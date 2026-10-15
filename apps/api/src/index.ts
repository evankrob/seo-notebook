import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { clients } from './schema';
import type { Actor, Bindings, Env, Job } from './types';
import { authenticate, hash, password } from './auth';
import { HttpError, client, date, getImpact, listChanges, logChange, normalizeURL, scope, updateChange } from './service';
import { fanout, processJob } from './jobs';
import { mcp } from './mcp';
import { csvCell } from '../../../packages/connectors/csv';
const app = new Hono<Bindings>();
app.use('*', async (c, next) => { await next(); c.header('X-Content-Type-Options', 'nosniff'); c.header('Referrer-Policy', 'no-referrer'); c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'"); c.header('Cache-Control', 'no-store'); });
app.onError((e, c) => c.json({ error: e instanceof ZodError ? e.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ') : e instanceof HttpError ? e.message : 'Internal server error' }, e instanceof HttpError ? e.status as 400 : e instanceof ZodError ? 400 : 500));
app.get('/health', c => c.json({ ok: true, mode: c.env.CONNECTOR_MODE }));
app.post('/auth/login', async (c) => { const { email, pass } = z.object({ email: z.string().email(), pass: z.string().min(1).max(200) }).parse(await c.req.json()); const m = await c.env.DB.prepare('SELECT * FROM member WHERE email=?').bind(email).first<any>(); if (!m || await password(pass, m.salt) !== m.password_hash)
    throw new HttpError(401, 'Invalid credentials'); const token = crypto.randomUUID() + crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO session VALUES (?,?,?)').bind(await hash(token), m.id, new Date(Date.now() + 86400000).toISOString()).run(); c.header('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${new URL(c.req.url).protocol === 'https:' ? '; Secure' : ''}`); return c.json({ ok: true }); });
app.post('/auth/accept', async (c) => { const a = z.object({ token: z.string(), name: z.string().min(1).max(100), password: z.string().min(12).max(200) }).parse(await c.req.json()); const i = await c.env.DB.prepare('SELECT * FROM invite WHERE token_hash=? AND used=0 AND expires_at>?').bind(await hash(a.token), new Date().toISOString()).first<any>(); if (!i)
    throw new HttpError(400, 'Invalid invite'); const salt = crypto.randomUUID(); const digest = await password(a.password, salt); const id = crypto.randomUUID(); await c.env.DB.batch([c.env.DB.prepare('INSERT INTO member(id,org_id,name,email,password_hash,salt,role) SELECT ?,org_id,?,email,?,?,role FROM invite WHERE token_hash=? AND used=0').bind(id, a.name, digest, salt, await hash(a.token)), c.env.DB.prepare('UPDATE invite SET used=1 WHERE token_hash=? AND used=0').bind(await hash(a.token))]); return c.json({ ok: true }); });
app.use('/v1/*', async (c, next) => { const actor = await authenticate(c.req.raw, c.env); if (!actor)
    throw new HttpError(401, 'Authentication required'); if (actor.kind === 'human' && !['GET', 'HEAD'].includes(c.req.method) && c.req.header('Origin') !== c.env.APP_ORIGIN)
    throw new HttpError(403, 'Origin mismatch'); c.set('actor', actor); await next(); });
app.get('/v1/me', c => c.json(c.get('actor')));
app.post('/v1/logout', async (c) => { const token = c.req.header('Cookie')?.match(/(?:^|;\s*)session=([^;]+)/)?.[1]; if (token)
    await c.env.DB.prepare('DELETE FROM session WHERE token_hash=?').bind(await hash(token)).run(); c.header('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return c.json({ ok: true }); });
const admin = (a: Actor) => { if (a.kind !== 'human' || a.role !== 'admin')
    throw new HttpError(403, 'Workspace admin required'); };
app.post('/v1/invites', async (c) => { const a = c.get('actor'); admin(a); const b = z.object({ email: z.string().email(), role: z.enum(['admin', 'editor']).default('editor') }).parse(await c.req.json()); const token = crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO invite VALUES (?,?,?,?,?,0)').bind(await hash(token), a.org_id, b.email, b.role, new Date(Date.now() + 7 * 86400000).toISOString()).run(); return c.json({ token, expires_in_days: 7 }, 201); });
app.post('/v1/agents', async (c) => { const a = c.get('actor'); admin(a); const b = z.object({ name: z.string().min(1).max(100), model: z.string().optional(), scopes: z.array(z.enum(['write:changes', 'read:metrics'])).min(1) }).parse(await c.req.json()); const token = crypto.randomUUID() + crypto.randomUUID(), id = crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO agent_token(id,org_id,name,model,token_hash,scopes) VALUES (?,?,?,?,?,?)').bind(id, a.org_id, b.name, b.model ?? null, await hash(token), JSON.stringify(b.scopes)).run(); return c.json({ id, token }, 201); });
app.delete('/v1/agents/:id', async (c) => { admin(c.get('actor')); await c.env.DB.prepare('UPDATE agent_token SET revoked=1 WHERE id=? AND org_id=?').bind(c.req.param('id'), c.get('actor').org_id).run(); return c.json({ ok: true }); });
app.get('/v1/clients', async (c) => { scope(c.get('actor'), 'read:metrics'); return c.json(await drizzle(c.env.DB).select().from(clients).where(eq(clients.orgId, c.get('actor').org_id))); });
app.post('/v1/clients', async (c) => { admin(c.get('actor')); const b = z.object({ name: z.string().min(1).max(200), timezone: z.string().refine(s => { try {
        new Intl.DateTimeFormat('en', { timeZone: s });
        return true;
    }
    catch {
        return false;
    } }) }).parse(await c.req.json()); const id = crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO client VALUES (?,?,?,?)').bind(id, c.get('actor').org_id, b.name, b.timezone).run(); return c.json({ id, ...b }, 201); });
app.get('/v1/clients/:id/context', async (c) => { const a = c.get('actor'); scope(a, 'read:metrics'); const cl = await client(c.env, a, c.req.param('id')); const [properties, pages, groups] = await Promise.all(['property', 'page', 'page_group'].map(t => c.env.DB.prepare(`SELECT * FROM ${t} WHERE client_id=?`).bind(cl.id).all())); return c.json({ client: cl, properties: properties.results, pages: pages.results, groups: groups.results }); });
app.post('/v1/pages', async (c) => { const a = c.get('actor'); admin(a); const b = z.object({ client_id: z.string(), url: z.string().url(), canonical: z.string().url().optional(), tags: z.array(z.string()).default([]) }).parse(await c.req.json()); await client(c.env, a, b.client_id); const id = crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO page VALUES (?,?,?,?,?)').bind(id, b.client_id, normalizeURL(b.url), b.canonical ? normalizeURL(b.canonical) : null, JSON.stringify(b.tags)).run(); return c.json({ id, ...b }, 201); });
app.post('/v1/groups', async (c) => { const a = c.get('actor'); admin(a); const b = z.object({ client_id: z.string(), name: z.string().min(1), page_ids: z.array(z.string()).min(1).max(200) }).parse(await c.req.json()); await client(c.env, a, b.client_id); for (const id of b.page_ids)
    if (!await c.env.DB.prepare('SELECT id FROM page WHERE id=? AND client_id=?').bind(id, b.client_id).first())
        throw new HttpError(400, 'Page outside client'); const id = crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO page_group VALUES (?,?,?,?)').bind(id, b.client_id, b.name, JSON.stringify([...new Set(b.page_ids)])).run(); return c.json({ id, ...b }, 201); });
app.post('/v1/properties', async (c) => { const a = c.get('actor'); admin(a); const b = z.object({ client_id: z.string(), type: z.enum(['gsc_domain', 'gsc_url_prefix', 'ga4', 'custom']), external_id: z.string().min(1), auth_type: z.enum(['oauth', 'service_account']).default('oauth') }).parse(await c.req.json()); await client(c.env, a, b.client_id); const id = crypto.randomUUID(), connection = crypto.randomUUID(); await c.env.DB.batch([c.env.DB.prepare('INSERT INTO connection VALUES (?,?,?,?,?)').bind(connection, a.org_id, b.type === 'ga4' ? 'ga4' : 'gsc', b.auth_type, 'mock'), c.env.DB.prepare('INSERT INTO property VALUES (?,?,?,?,?)').bind(id, b.client_id, b.type, b.external_id, connection)]); return c.json({ id, ...b, mode: 'mock' }, 201); });
app.post('/v1/properties/:id/sync', async (c) => { admin(c.get('actor')); const p = await c.env.DB.prepare('SELECT * FROM property WHERE id=?').bind(c.req.param('id')).first<any>(); if (!p)
    throw new HttpError(404, 'Property not found'); await client(c.env, c.get('actor'), p.client_id); if (!['gsc_domain', 'gsc_url_prefix', 'ga4'].includes(p.type))
    throw new HttpError(400, 'No connector for this property'); return c.json({ queued: await fanout(c.env, p.id, c.req.query('backfill') === 'true'), mode: 'mock' }, 202); });
app.get('/v1/changes', async (c) => c.json(await listChanges(c.env, c.get('actor'), c.req.query())));
app.post('/v1/changes', async (c) => c.json(await logChange(c.env, c.get('actor'), await c.req.json(), c.req.header('Idempotency-Key'), c.get('actor').kind === 'human' ? 'ui' : 'api'), 201));
app.patch('/v1/changes/:id', async (c) => c.json(await updateChange(c.env, c.get('actor'), c.req.param('id'), await c.req.json())));
app.get('/v1/impact/:id', async (c) => c.json(await getImpact(c.env, c.get('actor'), c.req.param('id'), c.req.query())));
app.get('/v1/timeline', async (c) => { const a = c.get('actor'); scope(a, 'read:metrics'); const id = c.req.query('client') ?? ''; await client(c.env, a, id); let sql = 'SELECT m.* FROM metric_series m JOIN property p ON p.id=m.property_id WHERE p.client_id=?'; const args: string[] = [id]; for (const [key, col] of [['property', 'm.property_id'], ['page', 'm.page_id'], ['metric', 'm.metric']] as const) {
    const v = c.req.query(key);
    if (v) {
        sql += ` AND ${col}=?`;
        args.push(v);
    }
} const since = c.req.query('since') ?? '2026-08-01'; date.parse(since); sql += ' AND m.date>=?'; args.push(since); const rows = await c.env.DB.prepare(sql + ' ORDER BY m.date LIMIT 20000').bind(...args).all(); let changes = await listChanges(c.env, a, { client: id, since }); if (c.req.query('page')) {
    const { resolvePages } = await import('./service');
    const selected = c.req.query('page')!;
    const matches = await Promise.all(changes.map(async (ch) => (await resolvePages(c.env, ch)).includes(selected)));
    changes = changes.filter((_, i) => matches[i]);
} return c.json({ metrics: rows.results, changes }); });
app.post('/v1/:kind/import', async (c) => { const a = c.get('actor'); scope(a, 'write:changes'); const kind = c.req.param('kind'); if (!['metrics', 'changes'].includes(kind))
    throw new HttpError(404, 'Not found'); const id = c.req.query('client') ?? ''; await client(c.env, a, id); if (Number(c.req.header('Content-Length') ?? 0) > 1000000)
    throw new HttpError(413, 'Upload exceeds 1 MB'); const content = await c.req.text(); if (new TextEncoder().encode(content).length > 1000000)
    throw new HttpError(413, 'Upload exceeds 1 MB'); const format = c.req.header('Content-Type')?.includes('application/json') ? 'json' : 'csv'; if (kind === 'changes' && format === 'json')
    throw new HttpError(400, 'Change history import requires CSV'); const job = crypto.randomUUID(), key = `uploads/${a.org_id}/${job}.${format}`; await c.env.UPLOADS.put(key, content); await c.env.DB.prepare('INSERT INTO import_job VALUES (?,?,?,?,?,NULL,0,?,?)').bind(job, id, `${kind}:${format}`, key, 'queued', JSON.stringify(a), new Date().toISOString()).run(); await c.env.JOBS.send({ kind: 'import', id: job }); return c.json({ id: job, status: 'queued' }, 202); });
app.get('/v1/imports/:id', async (c) => { scope(c.get('actor'), 'read:metrics'); const j = await c.env.DB.prepare('SELECT j.id,j.client_id,j.kind,j.status,j.error,j.row_count FROM import_job j JOIN client c ON c.id=j.client_id WHERE j.id=? AND c.org_id=?').bind(c.req.param('id'), c.get('actor').org_id).first(); if (!j)
    throw new HttpError(404, 'Import not found'); return c.json(j); });
app.post('/v1/reports', async (c) => { const a = c.get('actor'); admin(a); const b = z.object({ client_id: z.string(), title: z.string().min(1).max(200), since: date, until: date }).parse(await c.req.json()); await client(c.env, a, b.client_id); if (b.since > b.until)
    throw new HttpError(400, 'Invalid report period'); const token = crypto.randomUUID() + crypto.randomUUID(), id = crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO report VALUES (?,?,?,?,?,?,0,?)').bind(id, b.client_id, await hash(token), b.title, b.since, b.until, new Date().toISOString()).run(); return c.json({ id, url: `/reports/${token}` }, 201); });
app.delete('/v1/reports/:id', async (c) => { admin(c.get('actor')); await c.env.DB.prepare('UPDATE report SET revoked=1 WHERE id=? AND client_id IN (SELECT id FROM client WHERE org_id=?)').bind(c.req.param('id'), c.get('actor').org_id).run(); return c.json({ ok: true }); });
async function reportData(env: Env, token: string) { const r = await env.DB.prepare('SELECT r.*,c.org_id,c.name FROM report r JOIN client c ON c.id=r.client_id WHERE r.token_hash=? AND r.revoked=0').bind(await hash(token)).first<any>(); if (!r)
    throw new HttpError(404, 'Report not found'); const actor: Actor = { id: 'report', org_id: r.org_id, name: 'Report reader', kind: 'human', scopes: ['read:metrics'] }; const changes = await listChanges(env, actor, { client: r.client_id, since: r.since, until: r.until }); return { title: r.title, client: r.name, since: r.since, until: r.until, changes: await Promise.all(changes.map(async (ch) => ({ change: ch, impact: await getImpact(env, actor, ch.id) }))) }; }
app.get('/public/reports/:token', async (c) => c.json(await reportData(c.env, c.req.param('token'))));
app.get('/public/reports/:token/export.csv', async (c) => { const r = await reportData(c.env, c.req.param('token')); const cols = ['date', 'status', 'type', 'who', 'what', 'why', 'confidence', 'before', 'after', 'percent']; const rows = r.changes.map(({ change: x, impact: i }) => [x.occurred_at, x.status, x.type, x.author_name, x.summary, x.rationale, i.confidence, i.pre, i.post, i.percent]); c.header('Content-Type', 'text/csv; charset=utf-8'); c.header('Content-Disposition', 'attachment; filename="seo-notebook-report.csv"'); return c.body([cols, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n')); });
app.all('/mcp', async (c) => { const a = await authenticate(c.req.raw, c.env); if (!a || a.kind !== 'agent')
    throw new HttpError(401, 'Agent bearer token required'); return mcp(c.req.raw, c.env, a); });
app.get('*', async (c) => { const p = new URL(c.req.url); if (p.pathname.startsWith('/v1/') || p.pathname.startsWith('/public/'))
    throw new HttpError(404, 'Not found'); if (p.pathname.startsWith('/reports/'))
    p.pathname = '/'; return c.env.ASSETS.fetch(new Request(p, c.req.raw)); });
export default { fetch: app.fetch, async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(fanout(env)); }, async queue(batch: MessageBatch<Job>, env: Env) { for (const msg of batch.messages) {
        try {
            await processJob(env, msg.body);
            msg.ack();
        }
        catch {
            msg.retry({ delaySeconds: 30 });
        }
    } } };
export { app };
