import type { Actor, Env } from './types';
export const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, '0')).join('');
export async function password(s: string, salt: string) { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(s), 'PBKDF2', false, ['deriveBits']); return Array.from(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256))).map(b => b.toString(16).padStart(2, '0')).join(''); }
export async function authenticate(req: Request, env: Env): Promise<Actor | null> {
    const bearer = req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
        const a = await env.DB.prepare('SELECT * FROM agent_token WHERE token_hash=? AND revoked=0').bind(await hash(bearer)).first<any>();
        return a ? { id: a.id, org_id: a.org_id, name: a.name, model: a.model, kind: 'agent', scopes: JSON.parse(a.scopes) } : null;
    }
    const token = req.headers.get('Cookie')?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
    if (!token)
        return null;
    const m = await env.DB.prepare('SELECT m.* FROM session s JOIN member m ON m.id=s.member_id WHERE s.token_hash=? AND s.expires_at>?').bind(await hash(token), new Date().toISOString()).first<any>();
    return m ? { id: m.id, org_id: m.org_id, name: m.name, kind: 'human', scopes: ['write:changes', 'read:metrics'], role: m.role } : null;
}
// Sign-in throttling: fixed 15-minute windows per email and per client IP. Attempts are counted
// before the password is checked so concurrent guesses cannot race past the limit.
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_LIMITS = { email: 10, ip: 50 };
export const loginKeys = (email: string, ip?: string | null) => [
    { key: 'email:' + email.toLowerCase(), limit: LOGIN_LIMITS.email },
    ...(ip ? [{ key: 'ip:' + ip, limit: LOGIN_LIMITS.ip }] : []),
];
/** Records one attempt per key; returns seconds to wait when any key is over its limit, else 0. */
export async function countLoginAttempt(env: Env, keys: { key: string; limit: number }[], now = Date.now()) {
    const at = new Date(now).toISOString(), since = new Date(now - LOGIN_WINDOW_MS).toISOString();
    let wait = 0;
    for (const k of keys) {
        const row = await env.DB.prepare('INSERT INTO login_attempt(key,window_start,attempts) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start>? THEN attempts+1 ELSE 1 END, window_start=CASE WHEN window_start>? THEN window_start ELSE excluded.window_start END RETURNING window_start, attempts')
            .bind(k.key, at, since, since).first<{ window_start: string; attempts: number }>();
        if (row && row.attempts > k.limit)
            wait = Math.max(wait, Math.ceil((Date.parse(row.window_start) + LOGIN_WINDOW_MS - now) / 1000));
    }
    return wait;
}
/** After a successful sign-in: reset the email counter and refund this attempt's IP slot, so only failures accrue. */
export async function clearLoginAttempts(env: Env, keys: { key: string }[]) {
    const [email, ...ips] = keys;
    await env.DB.batch([
        env.DB.prepare('DELETE FROM login_attempt WHERE key=?').bind(email.key),
        ...ips.map(k => env.DB.prepare('UPDATE login_attempt SET attempts=MAX(attempts-1,0) WHERE key=?').bind(k.key)),
    ]);
}
