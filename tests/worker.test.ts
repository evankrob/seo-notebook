import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { app } from '../apps/api/src/index';
import { processJob, fanout } from '../apps/api/src/jobs';
import type { Env, Job } from '../apps/api/src/types';
// Real SQLite schema/constraints with D1's asynchronous statement contract.
class Statement {
    params: any[] = [];
    constructor(private db: DatabaseSync, private sql: string) { }
    bind(...params: any[]) { const s = new Statement(this.db, this.sql); s.params = params; return s; }
    async all() { return { results: this.db.prepare(this.sql).all(...this.params), success: true, meta: {} }; }
    async first(column?: string) { const row = this.db.prepare(this.sql).get(...this.params) as any; return row ? (column ? row[column] : row) : null; }
    async raw() { return this.db.prepare(this.sql).all(...this.params).map(Object.values); }
    async run() { return { success: true, results: [], meta: this.db.prepare(this.sql).run(...this.params) }; }
}
let sqlite: DatabaseSync, env: Env, jobs: Job[], objects: Map<string, string>;
beforeEach(() => { sqlite = new DatabaseSync(':memory:'); for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync('migrations/' + f, 'utf8')); sqlite.exec(readFileSync('fixtures/seed.sql', 'utf8')); jobs = []; objects = new Map(); env = { DB: { prepare: (sql: string) => new Statement(sqlite, sql), batch: async (statements: Statement[]) => { sqlite.exec('BEGIN'); try {
            const rows = [];
            for (const s of statements)
                rows.push(await s.run());
            sqlite.exec('COMMIT');
            return rows;
        }
        catch (e) {
            sqlite.exec('ROLLBACK');
            throw e;
        } } } as unknown as D1Database, UPLOADS: { put: async (k: string, v: string) => { objects.set(k, v); }, get: async (k: string) => objects.has(k) ? { text: async () => objects.get(k)! } : null } as unknown as R2Bucket, JOBS: { send: async (j: Job) => { jobs.push(j); }, sendBatch: async (js: {
            body: Job;
        }[]) => { jobs.push(...js.map(j => j.body)); } } as unknown as Queue<Job>, ASSETS: { fetch: async () => new Response('assets') } as unknown as Fetcher, CONNECTOR_MODE: 'mock' }; });
afterEach(() => sqlite.close());
const auth = { Authorization: 'Bearer demo-agent-token-not-a-secret' };
function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) { return app.request('http://localhost:8787' + path, { method, headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }, env); }
const change = { client_id: 'cedar', occurred_at: '2026-08-20', type: 'content', summary: 'A test change', rationale: 'A test hypothesis', page_ids: ['garden'] };
describe('Worker API + SQL integration', () => {
    it('requires authentication off loopback and returns tenant-scoped resources', async () => { expect((await app.request('http://notebook.example/v1/clients', {}, env)).status).toBe(401); const r = await request('/v1/clients'); expect(r.status).toBe(200); expect((await r.json() as { domain: string }[])[0].domain).toBe('cedar.example'); expect((await request('/v1/clients/not-yours/context')).status).toBe(404); });
    it('creates, retries idempotently, refuses conflicts and preserves verified author', async () => { const headers = { 'Idempotency-Key': 'retry-1' }; const a = await (await request('/v1/changes', 'POST', change, headers)).json() as any; const b = await (await request('/v1/changes', 'POST', change, headers)).json() as any; expect(a.id).toBe(b.id); expect(a.author_name).toBe('Cedar Assistant'); expect((await request('/v1/changes', 'POST', { ...change, summary: 'different' }, headers)).status).toBe(409); expect((await request('/v1/changes', 'POST', { ...change, author_name: 'Fake' })).status).toBe(400); const updated = await (await request('/v1/changes/' + a.id, 'PATCH', { status: 'reverted' })).json() as any; expect(updated.status).toBe('reverted'); expect(updated.author_id).toBe('demo-agent'); });
    it('enforces scope shape and client membership', async () => { expect((await request('/v1/changes', 'POST', { ...change, page_ids: ['foreign'] })).status).toBe(400); expect((await request('/v1/changes', 'POST', { ...change, sitewide: true })).status).toBe(400); expect((await request('/v1/changes', 'POST', { ...change, client_id: 'foreign' })).status).toBe(404); });
    it('returns final 28/28 impact and control adjustment', async () => { const r = await request('/v1/impact/title-refresh?control=control-guides'); expect(r.status).toBe(200); const i = await r.json() as any; expect(i.scored).toBe(true); expect(i.confidence).toBe('Strong'); expect(i.percent).toBeGreaterThan(20); expect(i.control.complete).toBe(true); });
    it('detects overlapping page changes and filters timelines', async () => { const i = await (await request('/v1/impact/form-layout')).json() as any; expect(i.overlaps).toContain('overlap-copy'); expect(i.confidence).toBe('Inconclusive'); const t = await (await request('/v1/timeline?client=cedar&property=cedar-gsc&page=garden&metric=clicks')).json() as any; expect(t.metrics.every((m: any) => m.page_id === 'garden')).toBe(true); expect(t.changes.every((c: any) => c.page_ids.includes('garden'))).toBe(true); });
    it('stores raw CSV in R2, queues parsing, upserts metrics and records failures', async () => { const csv = readFileSync('fixtures/metrics.csv', 'utf8'); const r = await app.request('/v1/metrics/import?client=cedar', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/csv' }, body: csv }, env); expect(r.status).toBe(202); expect(objects.size).toBe(1); await processJob(env, jobs[0]); await processJob(env, jobs[0]); expect(sqlite.prepare("SELECT COUNT(*) n FROM metric_series WHERE date='2026-07-31'").get()?.n).toBe(2); const j = await r.json() as any; expect((await (await request('/v1/imports/' + j.id)).json() as any).status).toBe('completed'); const bad = await app.request('/v1/metrics/import?client=cedar', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/csv' }, body: 'property_id,page_id,date,metric,value\ncedar-gsc,foreign,2026-07-30,clicks,2' }, env); const bj = await bad.json() as any; await expect(processJob(env, jobs[1])).rejects.toThrow(); expect((await (await request('/v1/imports/' + bj.id)).json() as any).status).toBe('failed'); });
    it('imports historic change CSV with retry protection', async () => { await app.request('/v1/changes/import?client=cedar', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/csv' }, body: readFileSync('fixtures/changes.csv', 'utf8') }, env); await processJob(env, jobs[0]); await processJob(env, jobs[0]); expect(sqlite.prepare("SELECT COUNT(*) n FROM change_entry WHERE source='import'").get()?.n).toBe(1); });
    it('runs daily seven-day revisions and bounded sixteen-month fixture backfill', async () => { expect(await fanout(env, 'cedar-gsc')).toBe(7); expect(jobs.length).toBe(7); await processJob(env, jobs[0]); expect(sqlite.prepare("SELECT COUNT(*) n FROM metric_series WHERE source='mock:gsc'").get()?.n).toBe(12); jobs.length = 0; const count = await fanout(env, 'cedar-ga4', true); expect(count).toBeGreaterThan(480); expect(count).toBeLessThan(500); });
    it('shares a read-only period report and CSV without granting workspace access', async () => { const publicReport = await app.request('/public/reports/demo-read-only-report', {}, env); expect(publicReport.status).toBe(200); expect((await publicReport.json() as any).changes.length).toBe(5); const csv = await app.request('/public/reports/demo-read-only-report/export.csv', {}, env); expect(csv.headers.get('Content-Type')).toContain('text/csv'); expect(await csv.text()).toContain('Clarified the garden tools title'); expect((await app.request('/public/reports/demo-read-only-report', { method: 'POST' }, env)).status).toBe(404); expect((await app.request('/v1/changes', { headers: { Authorization: 'Bearer demo-read-only-report' } }, env)).status).toBe(401); });
    it('treats loopback requests as the local owner, protects mutations by origin, issues scoped tokens', async () => { const path = '/v1/agents', body = { name: 'Read only', scopes: ['read:metrics'] }; const noOrigin = await request(path, 'POST', body, { Authorization: '' }); expect(noOrigin.status).toBe(403); const good = await request(path, 'POST', body, { Authorization: '', Origin: 'http://localhost:8787' }); expect(good.status).toBe(201); const token = (await good.json() as { token: string }).token; expect((await request('/v1/changes', 'POST', change, { Authorization: 'Bearer ' + token })).status).toBe(403); const me = await (await request('/v1/me', 'GET', undefined, { Authorization: '' })).json() as { auth: string; role: string; email: string }; expect(me).toMatchObject({ auth: 'local', role: 'admin', email: 'owner@localhost' }); });
    it('prevents cross-organization reads even with valid tokens', async () => { sqlite.exec("INSERT INTO org VALUES ('other','Other','self-host'); INSERT INTO client(id,org_id,name,timezone,domain) VALUES ('other-client','other','Other client','UTC','other.example'); UPDATE agent_token SET org_id='other' WHERE id='demo-agent';"); expect((await (await request('/v1/changes')).json() as any[])).toHaveLength(0); expect((await request('/v1/impact/title-refresh')).status).toBe(404); });
    it('supports MCP initialize, tools/list and tools/call over Streamable HTTP', async () => { const headers = { Accept: 'application/json, text/event-stream' }; const init = await request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, headers); expect(init.status).toBe(200); expect((await init.json() as any).result.serverInfo.name).toBe('seo-notebook'); const tools = await request('/mcp', 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, headers); expect((await tools.json() as any).result.tools.map((t: any) => t.name)).toEqual(['log_change', 'update_change', 'list_sites', 'list_changes', 'get_impact']); const call = await request('/mcp', 'POST', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_impact', arguments: { change_id: 'title-refresh' } } }, headers); const result = await call.json() as any; expect(JSON.parse(result.result.content[0].text).scored).toBe(true); });
});
describe('workspace administration boundaries', () => {
    const human = async () => ({ Authorization: '', Origin: 'http://localhost:8787' });

    it('creates and revokes share tokens without leaking administrative access', async () => { const headers = await human(); const created = await request('/v1/reports', 'POST', { client_id: 'cedar', title: 'Fixture report', since: '2026-09-01', until: '2026-09-30' }, headers); expect(created.status).toBe(201); const r = await created.json() as any; const token = r.url.split('/').at(-1); expect((await app.request('/public/reports/' + token, {}, env)).status).toBe(200); await request('/v1/reports/' + r.id, 'DELETE', undefined, headers); expect((await app.request('/public/reports/' + token, {}, env)).status).toBe(404); });
    it('creates client entities with mock auth modes and normalized page URLs', async () => { const headers = await human(); const c = await (await request('/v1/clients', 'POST', { domain: 'https://www.Moss.example/', name: 'Fictional Moss Supply', timezone: 'UTC' }, headers)).json() as any; expect(c.domain).toBe('moss.example'); expect((await request('/v1/clients', 'POST', { domain: 'moss.example' }, headers)).status).toBe(409); const p = await (await request('/v1/pages', 'POST', { client_id: c.id, url: 'https://MOSS.example/items/?tracking=1' }, headers)).json() as any; expect(sqlite.prepare('SELECT url FROM page WHERE id=?').get(p.id)?.url).toBe('https://moss.example/items/'); expect((await request('/v1/groups', 'POST', { client_id: c.id, name: 'Items', page_ids: [p.id] }, headers)).status).toBe(201); const property = await (await request('/v1/properties', 'POST', { client_id: c.id, type: 'gsc_url_prefix', external_id: 'https://moss.example/', auth_type: 'service_account' }, headers)).json() as any; expect(property.mode).toBe('mock'); });
    it('rejects invalid impact options and foreign controls', async () => { expect((await request('/v1/impact/title-refresh?days=0')).status).toBe(400); expect((await request('/v1/impact/title-refresh?control=foreign')).status).toBe(400); expect((await request('/v1/impact/title-refresh?property=foreign')).status).toBe(400); });
    it('MCP attributes logs to its bearer identity and handles idempotency', async () => { const headers = { Accept: 'application/json, text/event-stream' }; const body = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'log_change', arguments: { ...change, idempotency_key: 'mcp-retry' } } }; const a = await (await request('/mcp', 'POST', body, headers)).json() as any; const b = await (await request('/mcp', 'POST', body, headers)).json() as any; const first = JSON.parse(a.result.content[0].text); expect(first.id).toBe(JSON.parse(b.result.content[0].text).id); expect(first.source).toBe('mcp'); expect(first.author_id).toBe('demo-agent'); });
});
describe('robustness', () => {
    it('rejects malformed JSON bodies with 400 instead of 500', async () => {
        const raw = (path: string, method: string, body: string) => app.request('http://localhost:8787' + path, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body }, env);
        for (const [path, method, body] of [['/v1/changes', 'POST', '{bad'], ['/v1/changes', 'POST', ''], ['/v1/changes/title-refresh', 'PATCH', '{']]) {
            const r = await raw(path, method, body);
            expect(r.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
            expect((await r.json() as { error: string }).error).toBe('Request body must be valid JSON');
        }
        expect((await raw('/v1/changes', 'POST', '[]')).status).toBe(400);
    });

    it('builds large reports with a constant query count and impacts identical to the single endpoint', async () => {
        const insert = sqlite.prepare("INSERT INTO change_entry(id,client_id,occurred_at,timezone,status,type,page_ids,group_id,sitewide,summary,rationale,author_id,author_name,author_kind,model,source,evidence,expected_metric,tags,created_at,updated_at) VALUES (?,'cedar',?,'UTC','shipped','content',?,?,?,'bulk','bulk','demo-agent','Cedar Assistant','agent',NULL,'api','[]',?,'[]','2026-10-01','2026-10-01')");
        for (let i = 0; i < 150; i++) {
            const d = new Date(Date.UTC(2026, 7, 1 + (i % 80))).toISOString().slice(0, 10);
            const kind = i % 3;
            insert.run('bulk-' + i, d, kind === 0 ? '["garden"]' : '[]', kind === 1 ? 'control-guides' : null, kind === 2 ? 1 : 0, i % 4 === 0 ? 'ctr' : 'clicks');
        }
        let queries = 0;
        const prepare = env.DB.prepare.bind(env.DB);
        (env.DB as { prepare: unknown }).prepare = (sql: string) => { queries++; return prepare(sql); };
        const r = await app.request('/public/reports/demo-read-only-report', {}, env);
        expect(r.status).toBe(200);
        expect(queries).toBeLessThan(25);
        const report = await r.json() as { changes: { change: { id: string }; impact: Record<string, unknown> & { overlaps: string[]; overlap_count: number } }[] };
        expect(report.changes.length).toBeGreaterThan(150);
        (env.DB as { prepare: unknown }).prepare = prepare;
        for (const { change, impact } of report.changes) {
            expect(impact.change).toBeUndefined();
            expect(impact.overlaps.length).toBeLessThanOrEqual(20);
            const single = await (await request('/v1/impact/' + change.id)).json() as Record<string, unknown> & { overlaps: string[] };
            expect(impact.overlap_count).toBe(single.overlaps.length);
            expect(impact.overlaps).toEqual(single.overlaps.slice(0, 20));
            for (const key of ['pre', 'post', 'percent', 'delta', 'confidence', 'scored', 'series', 'warnings', 'property_id', 'metric'])
                expect(impact[key], `${change.id}.${key}`).toEqual(single[key]);
        }
    });
});

describe('Cloudflare Access identity', () => {
    const aud = 'aud-test';
    let team: string, privateKey: CryptoKey, otherKey: CryptoKey;
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    async function jwt(claims: Record<string, unknown>, key = privateKey) {
        const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), body = enc(claims);
        const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body))).toString('base64url');
        return `${head}.${body}.${sig}`;
    }
    const claims = (extra: Record<string, unknown> = {}) => ({ aud: [aud], iss: `https://${team}`, exp: Math.floor(Date.now() / 1000) + 600, email: 'Evan@RaleighDigital.com', ...extra });
    const me = (headers: Record<string, string>, url = 'https://notebook.example/v1/me') => app.request(url, { headers }, env);
    beforeEach(async () => {
        const rsa = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
        const pair = await crypto.subtle.generateKey(rsa, true, ['sign', 'verify']) as CryptoKeyPair;
        privateKey = pair.privateKey;
        otherKey = (await crypto.subtle.generateKey(rsa, true, ['sign', 'verify']) as CryptoKeyPair).privateKey;
        const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'k1' };
        team = `team-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`; // fresh team = fresh key cache
        vi.stubGlobal('fetch', vi.fn(async (u: string | URL) => String(u) === `https://${team}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : new Response('not found', { status: 404 })));
        env.ACCESS_TEAM_DOMAIN = team;
        env.ACCESS_AUD = aud;
    });
    afterEach(() => vi.unstubAllGlobals());

    it('identifies the Access user and provisions them as an admin of the workspace', async () => {
        const r = await me({ 'Cf-Access-Jwt-Assertion': await jwt(claims()) });
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ email: 'evan@raleighdigital.com', role: 'admin', auth: 'access', org_id: 'demo-org' });
        const cookie = await me({ Cookie: 'CF_Authorization=' + await jwt(claims()) });
        expect(cookie.status).toBe(200);
        expect(sqlite.prepare("SELECT COUNT(*) n FROM member WHERE email='evan@raleighdigital.com'").get()).toEqual({ n: 1 });
    });

    it('rejects forged, expired, misaddressed and missing tokens, with no loopback bypass', async () => {
        for (const token of [await jwt(claims(), otherKey), await jwt(claims({ aud: ['other-app'] })), await jwt(claims({ iss: 'https://evil.cloudflareaccess.com' })), await jwt(claims({ exp: Math.floor(Date.now() / 1000) - 120 })), await jwt(claims({ email: undefined })), 'not.a.jwt', 'garbage'])
            expect((await me({ 'Cf-Access-Jwt-Assertion': token })).status).toBe(401);
        expect((await me({ 'Cf-Access-Authenticated-User-Email': 'evan@raleighdigital.com' })).status).toBe(401);
        expect((await me({}, 'http://localhost:8787/v1/me')).status).toBe(401);
        // Agent tokens keep working when Access is configured.
        expect((await request('/v1/sites')).status).toBe(200);
    });
});

describe('agent-first change logging', () => {
    const today = new Date().toISOString().slice(0, 10);
    const base = { summary: 'Rewrote the bikini wax title', rationale: 'Match the dominant query wording' };
    const siteOf = (domain: string, org = 'demo-org') => sqlite.prepare('SELECT * FROM client WHERE domain=? AND org_id=?').get(domain, org) as { id: string } | undefined;

    it('creates the site and page from a URL and stores old to new values', async () => {
        const r = await request('/v1/changes', 'POST', { ...base, url: 'https://www.UnikeWax.com/bikini-wax/?utm_source=x', diff: [{ field: 'title', before: 'Bikini Wax', after: 'Bikini Wax in Raleigh | Unike' }, { field: 'meta_description', before: null, after: 'Book a bikini wax.' }] });
        expect(r.status).toBe(201);
        const c = await r.json() as { client_id: string; page_ids: string[]; type: string; occurred_at: string; status: string; diff: { field: string; before: string | null }[]; author_name: string };
        expect(c).toMatchObject({ type: 'title_meta', occurred_at: today, status: 'shipped', author_name: 'Cedar Assistant' });
        expect(c.diff).toEqual([{ field: 'title', before: 'Bikini Wax', after: 'Bikini Wax in Raleigh | Unike' }, { field: 'meta_description', before: null, after: 'Book a bikini wax.' }]);
        expect(c.client_id).toBe(siteOf('unikewax.com')!.id);
        expect(sqlite.prepare('SELECT url FROM page WHERE id=?').get(c.page_ids[0])).toEqual({ url: 'https://www.unikewax.com/bikini-wax/' });
        const again = await (await request('/v1/changes', 'POST', { ...base, url: 'https://www.unikewax.com/bikini-wax/', diff: [{ field: 'content', before: 'a', after: 'b' }] })).json() as { client_id: string; page_ids: string[]; type: string };
        expect(again).toMatchObject({ client_id: c.client_id, page_ids: c.page_ids, type: 'content' });
        const sites = await (await request('/v1/sites')).json() as { domain: string; changes: number; pages: number; last_change_at: string }[];
        expect(sites.find(x => x.domain === 'unikewax.com')).toMatchObject({ changes: 2, pages: 1, last_change_at: today });
        expect(await (await request('/v1/changes?site=www.unikewax.com')).json()).toHaveLength(2);
    });

    it('validates targets: one site per change, matching client, real URLs, a scope', async () => {
        const bad = [
            { ...base, urls: ['https://a.example/x', 'https://b.example/y'] },
            { ...base, client_id: 'cedar', url: 'https://unikewax.com/' },
            { ...base, url: 'not a url' },
            { ...base, url: 'ftp://unikewax.com/file' },
            { ...base },
            { ...base, site: 'unikewax.com' },
            { ...base, url: 'https://unikewax.com/', diff: [{ field: 'sidebar', after: 'x' }] },
        ];
        for (const body of bad)
            expect((await request('/v1/changes', 'POST', body)).status, JSON.stringify(body)).toBe(400);
        const sitewide = await request('/v1/changes', 'POST', { ...base, site: 'https://unikewax.com', sitewide: true, type: 'template', occurred_at: '2026-10-01' });
        expect(sitewide.status).toBe(201);
        expect(await sitewide.json()).toMatchObject({ sitewide: 1, page_ids: [], occurred_at: '2026-10-01' });
    });

    it('keeps auto-created sites inside each workspace', async () => {
        sqlite.exec("INSERT INTO org VALUES ('other','Other','self-host'); INSERT INTO agent_token(id,org_id,name,model,token_hash,scopes) VALUES ('agent2','other','Other agent',NULL,'" + createHash('sha256').update('other-token').digest('hex') + "','[\"write:changes\",\"read:metrics\"]');");
        await request('/v1/changes', 'POST', { ...base, url: 'https://unikewax.com/a' });
        const other = await request('/v1/changes', 'POST', { ...base, url: 'https://unikewax.com/a' }, { Authorization: 'Bearer other-token' });
        expect(other.status).toBe(201);
        expect(siteOf('unikewax.com')!.id).not.toBe(siteOf('unikewax.com', 'other')!.id);
        expect(await (await request('/v1/changes?site=unikewax.com')).json()).toHaveLength(1);
        expect(await (await request('/v1/sites', 'GET', undefined, { Authorization: 'Bearer other-token' })).json()).toHaveLength(1);
    });

    it('MCP: logs by URL idempotently, ships with update_change, lists sites, and requires a bearer token', async () => {
        const headers = { Accept: 'application/json, text/event-stream' };
        const call = async (name: string, args: Record<string, unknown>) => {
            const r = await request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers);
            return (await r.json() as { result: { isError?: boolean; content: { text: string }[] } }).result;
        };
        expect((await app.request('http://localhost:8787/mcp', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }, env)).status).toBe(401);
        const args = { ...base, url: 'https://unikewax.com/bikini-wax', status: 'planned', diff: [{ field: 'h1', before: 'Waxing', after: 'Bikini waxing' }], idempotency_key: 'unike-h1' };
        const first = JSON.parse((await call('log_change', args)).content[0].text) as { id: string; source: string; type: string };
        const retry = JSON.parse((await call('log_change', args)).content[0].text) as { id: string };
        expect(retry.id).toBe(first.id);
        expect(first).toMatchObject({ source: 'mcp', type: 'content' });
        const shipped = JSON.parse((await call('update_change', { change_id: first.id, status: 'shipped' })).content[0].text) as { status: string; diff: unknown[] };
        expect(shipped.status).toBe('shipped');
        expect(shipped.diff).toHaveLength(1);
        const sites = JSON.parse((await call('list_sites', {})).content[0].text) as { domain: string }[];
        expect(sites.map(s => s.domain)).toContain('unikewax.com');
        const invalid = await call('log_change', { ...base, url: 'https://unikewax.com/', diff: [{ field: 'nope' }] });
        expect(invalid.isError).toBe(true);
        expect(invalid.content[0].text).toContain('diff');
    });

    it('lists agents for humans without token hashes; agents cannot list', async () => {
        const list = await (await request('/v1/agents', 'GET', undefined, { Authorization: '' })).json() as Record<string, unknown>[];
        expect(list.map(a => a.id)).toContain('demo-agent');
        expect(list.every(a => !('token_hash' in a))).toBe(true);
        expect((await request('/v1/agents')).status).toBe(403);
    });
});
