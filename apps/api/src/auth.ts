import type { Actor, Env } from './types';

export const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, '0')).join('');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const accessConfigured = (env: Env) => !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
const teamDomain = (env: Env) => env.ACCESS_TEAM_DOMAIN!.replace(/^https?:\/\//, '').replace(/\/+$/, '');

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
const jsonPart = <T>(s: string): T => JSON.parse(new TextDecoder().decode(b64url(s)));

// Access signing keys, cached per team. Unknown key IDs trigger at most one refetch per minute.
const certCache = new Map<string, { fetchedAt: number; keys: Map<string, CryptoKey> }>();
async function signingKey(team: string, kid: string): Promise<CryptoKey | undefined> {
    const cached = certCache.get(team);
    const stale = !cached || Date.now() - cached.fetchedAt > 3_600_000 || (!cached.keys.has(kid) && Date.now() - cached.fetchedAt > 60_000);
    if (stale) {
        const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
        if (!r.ok)
            throw new Error('Could not load Cloudflare Access signing keys');
        const { keys } = await r.json() as { keys: (JsonWebKey & { kid: string })[] };
        const imported = new Map<string, CryptoKey>();
        for (const jwk of keys)
            imported.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
        certCache.set(team, { fetchedAt: Date.now(), keys: imported });
    }
    return certCache.get(team)!.keys.get(kid);
}

/** Verifies a Cloudflare Access JWT (signature, audience, issuer, expiry) and returns the user's email. */
export async function verifyAccessJwt(token: string, env: Env, now = Date.now()): Promise<string | null> {
    const parts = token.split('.');
    if (parts.length !== 3)
        return null;
    try {
        const header = jsonPart<{ alg?: string; kid?: string }>(parts[0]);
        const claims = jsonPart<{ aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string }>(parts[1]);
        if (header.alg !== 'RS256' || !header.kid)
            return null;
        const team = teamDomain(env);
        const key = await signingKey(team, header.kid);
        if (!key)
            return null;
        const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        const seconds = now / 1000;
        if (!valid || !aud.includes(env.ACCESS_AUD) || claims.iss !== `https://${team}` || !claims.exp || claims.exp + 60 < seconds || (claims.nbf && claims.nbf - 60 > seconds) || typeof claims.email !== 'string')
            return null;
        return claims.email.toLowerCase();
    }
    catch {
        return null;
    }
}

/**
 * Human identity. Deployed: the Cloudflare Access JWT. Local (Access not configured):
 * requests to a loopback host act as LOCAL_USER_EMAIL. Anything else is unauthenticated.
 */
async function humanEmail(req: Request, env: Env): Promise<string | null> {
    if (accessConfigured(env)) {
        const token = req.headers.get('Cf-Access-Jwt-Assertion') ?? req.headers.get('Cookie')?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
        return token ? verifyAccessJwt(token, env) : null;
    }
    return LOOPBACK.has(new URL(req.url).hostname) ? (env.LOCAL_USER_EMAIL || 'owner@localhost').toLowerCase() : null;
}

interface MemberRow {
    id: string;
    org_id: string;
    name: string;
    email: string;
    role: string;
}
/** Anyone who passes Access is a workspace admin; the Access policy is the membership list. */
async function memberFor(env: Env, email: string): Promise<MemberRow> {
    const find = () => env.DB.prepare('SELECT id,org_id,name,email,role FROM member WHERE lower(email)=?').bind(email).first<MemberRow>();
    const existing = await find();
    if (existing)
        return existing;
    let org = await env.DB.prepare('SELECT id FROM org ORDER BY rowid LIMIT 1').first<{ id: string }>();
    if (!org) {
        await env.DB.prepare("INSERT OR IGNORE INTO org VALUES ('default','My notebook','self-host')").run();
        org = { id: 'default' };
    }
    await env.DB.prepare("INSERT OR IGNORE INTO member(id,org_id,name,email,password_hash,salt,role) VALUES (?,?,?,?,'','','admin')").bind(crypto.randomUUID(), org.id, email.split('@')[0], email).run();
    return (await find())!;
}

export async function authenticate(req: Request, env: Env): Promise<Actor | null> {
    const bearer = req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
        const a = await env.DB.prepare('SELECT * FROM agent_token WHERE token_hash=? AND revoked=0').bind(await hash(bearer)).first<{ id: string; org_id: string; name: string; model: string | null; scopes: string }>();
        return a ? { id: a.id, org_id: a.org_id, name: a.name, model: a.model ?? undefined, kind: 'agent', scopes: JSON.parse(a.scopes) } : null;
    }
    const email = await humanEmail(req, env);
    if (!email)
        return null;
    const m = await memberFor(env, email);
    return { id: m.id, org_id: m.org_id, name: m.name, email: m.email, kind: 'human', scopes: ['write:changes', 'read:metrics'], role: 'admin' };
}
