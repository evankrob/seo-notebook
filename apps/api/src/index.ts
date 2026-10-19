import { Hono, type Context } from 'hono';
import { z, ZodError } from 'zod';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { clients } from './schema';
import type { Actor, Bindings, Env, Job } from './types';
import { accessConfigured, authenticate, hash } from './auth';
import { HttpError, client, date, day, getImpact, impactCache, listSites, siteDomain, listChanges, logChange, normalizeURL, pageURL, scope, updateChange } from './service';
import { backfillPage, fanout, processJob } from './jobs';
import { discover, parseServiceAccount } from '../../../packages/connectors/google';
import { mcp } from './mcp';
import { csvCell } from '../../../packages/connectors/csv';
const app = new Hono<Bindings>();
const body = async (c: Context<Bindings>): Promise<unknown> => {
    try {
        return await c.req.json();
    }
    catch {
        throw new HttpError(400, 'Request body must be valid JSON');
    }
};
app.use('*', async (c, next) => { await next(); c.header('X-Content-Type-Options', 'nosniff'); c.header('Referrer-Policy', 'no-referrer'); c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'"); c.header('Cache-Control', 'no-store'); });
app.onError((e, c) => c.json({ error: e instanceof ZodError ? e.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ') : e instanceof HttpError ? e.message : 'Internal server error' }, e instanceof HttpError ? e.status as 400 : e instanceof ZodError ? 400 : 500));
app.get('/health', c => c.json({ ok: true, mode: c.env.CONNECTOR_MODE, google: !!parseServiceAccount(c.env.GOOGLE_SERVICE_ACCOUNT) }));
app.use('/v1/*', async (c, next) => {
    const actor = await authenticate(c.req.raw, c.env);
    if (!actor)
        throw new HttpError(401, accessConfigured(c.env) ? 'Sign in through Cloudflare Access' : 'Authentication required');
    // Browser identity rides on the Access cookie, so cross-site writes must be refused.
    if (actor.kind === 'human' && !['GET', 'HEAD'].includes(c.req.method) && c.req.header('Origin') !== new URL(c.req.url).origin)
        throw new HttpError(403, 'Origin mismatch');
    c.set('actor', actor);
    await next();
});
app.get('/v1/me', c => c.json({ ...c.get('actor'), auth: c.get('actor').kind === 'agent' ? 'token' : accessConfigured(c.env) ? 'access' : 'local' }));
app.get('/v1/sites', async (c) => c.json(await listSites(c.env, c.get('actor'))));
app.get('/v1/agents', async (c) => { admin(c.get('actor')); return c.json((await c.env.DB.prepare('SELECT id,name,model,scopes,revoked FROM agent_token WHERE org_id=? ORDER BY revoked, name').bind(c.get('actor').org_id).all<{ scopes: string }>()).results.map(a => ({ ...a, scopes: JSON.parse(a.scopes) }))); });
const admin = (a: Actor) => { if (a.kind !== 'human' || a.role !== 'admin')
    throw new HttpError(403, 'Workspace admin required'); };
app.post('/v1/agents', async (c) => { const a = c.get('actor'); admin(a); const b = z.object({ name: z.string().min(1).max(100), model: z.string().optional(), scopes: z.array(z.enum(['write:changes', 'read:metrics'])).min(1) }).parse(await body(c)); const token = crypto.randomUUID() + crypto.randomUUID(), id = crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO agent_token(id,org_id,name,model,token_hash,scopes) VALUES (?,?,?,?,?,?)').bind(id, a.org_id, b.name, b.model ?? null, await hash(token), JSON.stringify(b.scopes)).run(); return c.json({ id, token }, 201); });
app.delete('/v1/agents/:id', async (c) => { admin(c.get('actor')); await c.env.DB.prepare('UPDATE agent_token SET revoked=1 WHERE id=? AND org_id=?').bind(c.req.param('id'), c.get('actor').org_id).run(); return c.json({ ok: true }); });
app.get('/v1/clients', async (c) => { scope(c.get('actor'), 'read:metrics'); return c.json(await drizzle(c.env.DB).select().from(clients).where(eq(clients.orgId, c.get('actor').org_id))); });
app.post('/v1/clients', async (c) => {
    admin(c.get('actor'));
    const b = z.object({ domain: z.string().min(1).max(253), name: z.string().min(1).max(200).optional(), timezone: z.string().default('UTC').refine(s => { try {
            new Intl.DateTimeFormat('en', { timeZone: s });
            return true;
        }
        catch {
            return false;
        } }, 'Invalid timezone') }).strict().parse(await body(c));
    const domain = siteDomain(b.domain), id = crypto.randomUUID();
    const r = await c.env.DB.prepare('INSERT OR IGNORE INTO client(id,org_id,name,timezone,domain) VALUES (?,?,?,?,?)').bind(id, c.get('actor').org_id, b.name ?? domain, b.timezone, domain).run();
    if (!r.meta.changes)
        throw new HttpError(409, 'Site already exists: ' + domain);
    return c.json({ id, domain, name: b.name ?? domain, timezone: b.timezone }, 201);
});
app.get('/v1/clients/:id/context', async (c) => { const a = c.get('actor'); scope(a, 'read:metrics'); const cl = await client(c.env, a, c.req.param('id')); const [properties, pages, groups] = await Promise.all([
        "SELECT p.*, COALESCE(n.mode,'mock') AS mode FROM property p LEFT JOIN connection n ON n.id=p.connection_id WHERE p.client_id=?",
        'SELECT * FROM page WHERE client_id=?',
        'SELECT * FROM page_group WHERE client_id=?',
    ].map(sql => c.env.DB.prepare(sql).bind(cl.id).all())); return c.json({ client: cl, properties: properties.results, pages: pages.results, groups: groups.results }); });
const pageSchema = z.object({ client_id: z.string(), url: z.string().url(), canonical: z.string().url().optional(), tags: z.array(z.string()).default([]) }).strict();
app.post('/v1/pages', async (c) => {
    const a = c.get('actor');
    admin(a);
    const b = pageSchema.parse(await body(c));
    await client(c.env, a, b.client_id);
    // Store the URL Search Console reports (after redirects); reuse the page if it already exists.
    const url = await pageURL(c.env, b.client_id, normalizeURL(b.url));
    const existing = await c.env.DB.prepare('SELECT id FROM page WHERE client_id=? AND url=?').bind(b.client_id, url).first<{ id: string }>();
    if (existing)
        return c.json({ ...b, id: existing.id, url, existing: true });
    const id = crypto.randomUUID();
    await c.env.DB.prepare('INSERT INTO page VALUES (?,?,?,?,?)').bind(id, b.client_id, url, b.canonical ? normalizeURL(b.canonical) : null, JSON.stringify(b.tags)).run();
    await backfillPage(c.env, b.client_id, id);
    return c.json({ ...b, id, url }, 201);
});
app.post('/v1/groups', async (c) => { const a = c.get('actor'); admin(a); const b = z.object({ client_id: z.string(), name: z.string().min(1), page_ids: z.array(z.string()).min(1).max(200) }).parse(await body(c)); await client(c.env, a, b.client_id); for (const id of b.page_ids)
    if (!await c.env.DB.prepare('SELECT id FROM page WHERE id=? AND client_id=?').bind(id, b.client_id).first())
        throw new HttpError(400, 'Page outside client'); const id = crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO page_group VALUES (?,?,?,?)').bind(id, b.client_id, b.name, JSON.stringify([...new Set(b.page_ids)])).run(); return c.json({ id, ...b }, 201); });
// What the service account can see in Search Console and GA4, for the connect dialog.
app.get('/v1/google', async (c) => {
    admin(c.get('actor'));
    const sa = parseServiceAccount(c.env.GOOGLE_SERVICE_ACCOUNT);
    if (!sa)
        return c.json({ configured: false });
    return c.json({ configured: true, ...await discover(sa) });
});
const propertyInput = z.object({
    client_id: z.string(),
    type: z.enum(['gsc_domain', 'gsc_url_prefix', 'ga4', 'custom']),
    external_id: z.string().min(1).max(300),
    auth_type: z.enum(['oauth', 'service_account']).default('service_account'),
    mode: z.enum(['mock', 'live']).default('mock'),
}).strict().superRefine((b, ctx) => {
    if (b.mode !== 'live')
        return;
    const ok = b.type === 'gsc_domain' ? /^sc-domain:[a-z0-9.-]+$/i.test(b.external_id)
        : b.type === 'gsc_url_prefix' ? /^https?:\/\/[^/]+\/.*$/.test(b.external_id)
        : b.type === 'ga4' ? /^\d+$/.test(b.external_id) : false;
    if (!ok)
        ctx.addIssue({ code: 'custom', path: ['external_id'], message: 'Not a valid ' + b.type + ' property ID' });
});
app.post('/v1/properties', async (c) => {
    const a = c.get('actor');
    admin(a);
    const b = propertyInput.parse(await body(c));
    await client(c.env, a, b.client_id);
    if (b.mode === 'live' && !parseServiceAccount(c.env.GOOGLE_SERVICE_ACCOUNT))
        throw new HttpError(400, 'Google service account is not configured (GOOGLE_SERVICE_ACCOUNT secret)');
    const id = crypto.randomUUID(), connection = crypto.randomUUID();
    await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO connection VALUES (?,?,?,?,?)').bind(connection, a.org_id, b.type === 'ga4' ? 'ga4' : 'gsc', b.mode === 'live' ? 'service_account' : b.auth_type, b.mode),
        c.env.DB.prepare('INSERT INTO property VALUES (?,?,?,?,?)').bind(id, b.client_id, b.type, b.external_id, connection),
    ]);
    // Live properties start with sixteen months of history.
    const queued = b.mode === 'live' ? await fanout(c.env, id, true) : 0;
    return c.json({ id, ...b, queued }, 201);
});
app.delete('/v1/properties/:id', async (c) => {
    const a = c.get('actor');
    admin(a);
    const p = await c.env.DB.prepare('SELECT p.id,p.connection_id FROM property p JOIN client cl ON cl.id=p.client_id WHERE p.id=? AND cl.org_id=?').bind(c.req.param('id'), a.org_id).first<{ id: string; connection_id: string | null }>();
    if (!p)
        throw new HttpError(404, 'Property not found');
    await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM metric_series WHERE property_id=?').bind(p.id),
        c.env.DB.prepare('DELETE FROM property WHERE id=?').bind(p.id),
        c.env.DB.prepare('DELETE FROM connection WHERE id=? AND org_id=?').bind(p.connection_id, a.org_id),
    ]);
    return c.json({ ok: true });
});
app.post('/v1/properties/:id/sync', async (c) => {
    admin(c.get('actor'));
    const p = await c.env.DB.prepare("SELECT p.*, COALESCE(n.mode,'mock') AS mode FROM property p JOIN client cl ON cl.id=p.client_id LEFT JOIN connection n ON n.id=p.connection_id WHERE p.id=? AND cl.org_id=?").bind(c.req.param('id'), c.get('actor').org_id).first<{ id: string; type: string; mode: string }>();
    if (!p)
        throw new HttpError(404, 'Property not found');
    if (!['gsc_domain', 'gsc_url_prefix', 'ga4'].includes(p.type))
        throw new HttpError(400, 'No connector for this property');
    return c.json({ queued: await fanout(c.env, p.id, c.req.query('backfill') === 'true'), mode: p.mode }, 202);
});
app.get('/v1/changes', async (c) => c.json(await listChanges(c.env, c.get('actor'), c.req.query())));
app.post('/v1/changes', async (c) => c.json(await logChange(c.env, c.get('actor'), await body(c), c.req.header('Idempotency-Key'), c.get('actor').kind === 'human' ? 'ui' : 'api'), 201));
app.patch('/v1/changes/:id', async (c) => c.json(await updateChange(c.env, c.get('actor'), c.req.param('id'), await body(c))));
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
app.post('/v1/reports', async (c) => { const a = c.get('actor'); admin(a); const b = z.object({ client_id: z.string(), title: z.string().min(1).max(200), since: date, until: date }).parse(await body(c)); await client(c.env, a, b.client_id); if (b.since > b.until)
    throw new HttpError(400, 'Invalid report period'); const token = crypto.randomUUID() + crypto.randomUUID(), id = crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO report VALUES (?,?,?,?,?,?,0,?)').bind(id, b.client_id, await hash(token), b.title, b.since, b.until, new Date().toISOString()).run(); return c.json({ id, url: `/reports/${token}` }, 201); });
app.delete('/v1/reports/:id', async (c) => { admin(c.get('actor')); await c.env.DB.prepare('UPDATE report SET revoked=1 WHERE id=? AND client_id IN (SELECT id FROM client WHERE org_id=?)').bind(c.req.param('id'), c.get('actor').org_id).run(); return c.json({ ok: true }); });
async function reportData(env: Env, token: string) { const r = await env.DB.prepare('SELECT r.*,c.org_id,c.name FROM report r JOIN client c ON c.id=r.client_id WHERE r.token_hash=? AND r.revoked=0').bind(await hash(token)).first<any>(); if (!r)
    throw new HttpError(404, 'Report not found'); const actor: Actor = { id: 'report', org_id: r.org_id, name: 'Report reader', kind: 'human', scopes: ['read:metrics'] }; const changes = await listChanges(env, actor, { client: r.client_id, since: r.since, until: r.until }); const cache = impactCache(day(r.since, -28), day(r.until, 31)); return { title: r.title, client: r.name, since: r.since, until: r.until, changes: await Promise.all(changes.map(async (ch) => {
            // The outer change is already included; drop the copy and cap overlap IDs so payload grows linearly.
            const { overlaps, ...impact } = await getImpact(env, actor, ch.id, {}, { cache, change: ch });
            return { change: ch, impact: { ...impact, change: undefined, overlaps: overlaps.slice(0, 20), overlap_count: overlaps.length } };
        })) }; }
app.get('/public/reports/:token', async (c) => c.json(await reportData(c.env, c.req.param('token'))));
app.get('/public/reports/:token/export.csv', async (c) => { const r = await reportData(c.env, c.req.param('token')); const cols = ['date', 'status', 'type', 'who', 'what', 'why', 'confidence', 'before', 'after', 'percent']; const rows = r.changes.map(({ change: x, impact: i }) => [x.occurred_at, x.status, x.type, x.author_name, x.summary, x.rationale, i.confidence, i.pre, i.post, i.percent]); c.header('Content-Type', 'text/csv; charset=utf-8'); c.header('Content-Disposition', 'attachment; filename="seo-notebook-report.csv"'); return c.body([cols, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n')); });
// Agents only. In production this path bypasses Cloudflare Access; the bearer token is the gate.
app.all('/mcp', async (c) => {
    const a = c.req.header('Authorization') ? await authenticate(c.req.raw, c.env) : null;
    if (!a || a.kind !== 'agent')
        throw new HttpError(401, 'Agent bearer token required');
    return mcp(c.req.raw, c.env, a);
});
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
