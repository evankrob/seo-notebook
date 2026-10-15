import { z } from 'zod';
import { day, impact, windows } from '../../../packages/impact';
import type { Actor, Change, Env, Metric } from './types';
import { hash } from './auth';
export class HttpError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Invalid date');
export const types = ['new_page', 'content', 'title_meta', 'internal_links', 'schema', 'redirect', 'template', 'technical', 'CRO_form', 'CRO_layout', 'ppc_landing', 'external_event'] as const;
export const changeSchema = z.object({ client_id: z.string().min(1), occurred_at: date, timezone: z.string().default('UTC').refine(s => { try {
        new Intl.DateTimeFormat('en', { timeZone: s });
        return true;
    }
    catch {
        return false;
    } }, 'Invalid timezone'), status: z.enum(['planned', 'shipped', 'reverted']).default('shipped'), type: z.enum(types), page_ids: z.array(z.string()).max(200).default([]), group_id: z.string().nullable().default(null), sitewide: z.boolean().default(false), summary: z.string().min(1).max(500), rationale: z.string().min(1).max(4000), evidence: z.array(z.string().url().refine(s => /^https?:/.test(s))).max(20).default([]), expected_metric: z.enum(['clicks', 'impressions', 'ctr', 'position', 'sessions', 'key_events', 'revenue', 'custom']).default('clicks'), tags: z.array(z.string().max(80)).max(30).default([]) }).strict();
export function decode(row: any): Change { return { ...row, page_ids: JSON.parse(row.page_ids), evidence: JSON.parse(row.evidence), tags: JSON.parse(row.tags) }; }
export async function client(env: Env, actor: Actor, id: string) { const c = await env.DB.prepare('SELECT * FROM client WHERE id=? AND org_id=?').bind(id, actor.org_id).first<any>(); if (!c)
    throw new HttpError(404, 'Client not found'); return c; }
export function scope(actor: Actor, s: string) { if (!actor.scopes.includes(s))
    throw new HttpError(403, 'Missing scope: ' + s); }
export async function getChange(env: Env, actor: Actor, id: string) { const c = await env.DB.prepare('SELECT e.* FROM change_entry e JOIN client c ON c.id=e.client_id WHERE e.id=? AND c.org_id=?').bind(id, actor.org_id).first(); if (!c)
    throw new HttpError(404, 'Change not found'); return decode(c); }
export async function listChanges(env: Env, actor: Actor, q: Record<string, string | undefined>) {
    scope(actor, 'read:metrics');
    const args: unknown[] = [actor.org_id];
    let sql = 'SELECT e.* FROM change_entry e JOIN client c ON c.id=e.client_id WHERE c.org_id=?';
    if (q.client) {
        sql += ' AND e.client_id=?';
        args.push(q.client);
    }
    if (q.since) {
        date.parse(q.since);
        sql += ' AND e.occurred_at>=?';
        args.push(q.since);
    }
    if (q.until) {
        date.parse(q.until);
        sql += ' AND e.occurred_at<=?';
        args.push(q.until);
    }
    const { results } = await env.DB.prepare(sql + ' ORDER BY e.occurred_at DESC,e.id LIMIT 1000').bind(...args).all();
    let rows = results.map(decode);
    if (q.url) {
        const p = await env.DB.prepare('SELECT p.id,p.client_id FROM page p JOIN client c ON c.id=p.client_id WHERE p.url=? AND c.org_id=?').bind(normalizeURL(q.url), actor.org_id).all<{
            id: string;
            client_id: string;
        }>();
        const ids = p.results.map(p => p.id);
        const groups = await env.DB.prepare('SELECT g.* FROM page_group g JOIN client c ON c.id=g.client_id WHERE c.org_id=?').bind(actor.org_id).all<any>();
        rows = rows.filter(r => (r.sitewide && p.results.some(p => p.client_id === r.client_id)) || r.page_ids.some(id => ids.includes(id)) || groups.results.some(g => g.id === r.group_id && JSON.parse(g.page_ids).some((id: string) => ids.includes(id))));
    }
    return rows;
}
export const normalizeURL = (s: string) => { const u = new URL(s); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new HttpError(400, 'Expected HTTP(S) URL'); u.hash = ''; u.search = ''; u.hostname = u.hostname.toLowerCase(); return u.toString(); };
export async function resolvePages(env: Env, c: Change): Promise<string[]> { if (c.sitewide)
    return (await env.DB.prepare('SELECT id FROM page WHERE client_id=?').bind(c.client_id).all<{
        id: string;
    }>()).results.map(p => p.id); if (c.group_id) {
    const g = await env.DB.prepare('SELECT page_ids FROM page_group WHERE id=? AND client_id=?').bind(c.group_id, c.client_id).first<{
        page_ids: string;
    }>();
    return g ? JSON.parse(g.page_ids) : [];
} return c.page_ids; }
async function validateScope(env: Env, c: z.infer<typeof changeSchema>) {
    if (Number(c.sitewide) + Number(!!c.group_id) + Number(c.page_ids.length > 0) !== 1)
        throw new HttpError(400, 'Choose exactly one scope: pages, group, or sitewide');
    for (const id of c.page_ids) {
        if (!await env.DB.prepare('SELECT id FROM page WHERE id=? AND client_id=?').bind(id, c.client_id).first())
            throw new HttpError(400, 'Page outside client');
    }
    if (c.group_id && !await env.DB.prepare('SELECT id FROM page_group WHERE id=? AND client_id=?').bind(c.group_id, c.client_id).first())
        throw new HttpError(400, 'Group outside client');
}
export async function logChange(env: Env, actor: Actor, raw: unknown, key?: string, source = 'api') {
    scope(actor, 'write:changes');
    const c = changeSchema.parse(raw);
    await client(env, actor, c.client_id);
    await validateScope(env, c);
    const requestHash = await hash(JSON.stringify(c));
    if (key) {
        if (key.length > 200)
            throw new HttpError(400, 'Idempotency key too long');
        const old = await env.DB.prepare('SELECT * FROM idempotency WHERE actor_id=? AND key=?').bind(actor.id, key).first<any>();
        if (old) {
            if (old.request_hash !== requestHash)
                throw new HttpError(409, 'Idempotency key reused with different content');
            return getChange(env, actor, old.change_id);
        }
    }
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const insert = env.DB.prepare('INSERT INTO change_entry (id,client_id,occurred_at,timezone,status,type,page_ids,group_id,sitewide,summary,rationale,author_id,author_name,author_kind,model,source,evidence,expected_metric,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, c.client_id, c.occurred_at, c.timezone, c.status, c.type, JSON.stringify([...new Set(c.page_ids)]), c.group_id, Number(c.sitewide), c.summary, c.rationale, actor.id, actor.name, actor.kind, actor.model ?? null, source, JSON.stringify(c.evidence), c.expected_metric, JSON.stringify(c.tags), now, now);
    try {
        await env.DB.batch(key ? [insert, env.DB.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').bind(actor.id, key, requestHash, id)] : [insert]);
    }
    catch (e) {
        if (key) {
            const old = await env.DB.prepare('SELECT * FROM idempotency WHERE actor_id=? AND key=?').bind(actor.id, key).first<any>();
            if (old && old.request_hash === requestHash)
                return getChange(env, actor, old.change_id);
        }
        throw e;
    }
    return getChange(env, actor, id);
}
export async function updateChange(env: Env, actor: Actor, id: string, raw: unknown) {
    scope(actor, 'write:changes');
    const old = await getChange(env, actor, id);
    const parsed = changeSchema.omit({ client_id: true }).partial().parse(raw);
    const patch = Object.fromEntries(Object.entries(parsed).filter(([key]) => Object.hasOwn(raw as object, key)));
    const merged = changeSchema.parse({ ...Object.fromEntries(Object.keys(changeSchema.shape).map(k => [k, (old as any)[k]])), sitewide: !!old.sitewide, ...patch });
    await validateScope(env, merged);
    await env.DB.prepare('UPDATE change_entry SET occurred_at=?,timezone=?,status=?,type=?,page_ids=?,group_id=?,sitewide=?,summary=?,rationale=?,evidence=?,expected_metric=?,tags=?,updated_at=? WHERE id=?').bind(merged.occurred_at, merged.timezone, merged.status, merged.type, JSON.stringify(merged.page_ids), merged.group_id, Number(merged.sitewide), merged.summary, merged.rationale, JSON.stringify(merged.evidence), merged.expected_metric, JSON.stringify(merged.tags), new Date().toISOString(), id).run();
    return getChange(env, actor, id);
}
export async function getImpact(env: Env, actor: Actor, id: string, q: Record<string, string | undefined> = {}) {
    scope(actor, 'read:metrics');
    const c = await getChange(env, actor, id), days = z.coerce.number().int().min(7).max(180).parse(q.days ?? 28), lag = z.coerce.number().int().min(0).max(60).parse(q.lag ?? 3);
    const w = windows(c.occurred_at, days, lag);
    let pages = await resolvePages(env, c);
    let control: string[] = [];
    if (q.control) {
        const g = await env.DB.prepare('SELECT page_ids FROM page_group WHERE id=? AND client_id=?').bind(q.control, c.client_id).first<{
            page_ids: string;
        }>();
        if (!g)
            throw new HttpError(400, 'Control group not found');
        control = JSON.parse(g.page_ids);
    }
    const metric = q.metric ?? c.expected_metric;
    if (!['clicks', 'impressions', 'ctr', 'position', 'sessions', 'key_events', 'revenue', 'custom'].includes(metric))
        throw new HttpError(400, 'Invalid metric');
    let property = q.property;
    if (property) {
        if (!await env.DB.prepare('SELECT id FROM property WHERE id=? AND client_id=?').bind(property, c.client_id).first())
            throw new HttpError(400, 'Property outside client');
    }
    else
        property = (await env.DB.prepare('SELECT id FROM property WHERE client_id=? AND type IN (?,?) ORDER BY id LIMIT 1').bind(c.client_id, ['sessions', 'key_events', 'revenue'].includes(metric) ? 'ga4' : metric === 'custom' ? 'custom' : 'gsc_domain', ['sessions', 'key_events', 'revenue'].includes(metric) ? 'ga4' : metric === 'custom' ? 'custom' : 'gsc_url_prefix').first<{
            id: string;
        }>())?.id;
    const rows = property ? (await env.DB.prepare('SELECT page_id,date,value,data_state FROM metric_series WHERE property_id=? AND date>=? AND date<=? AND metric=?').bind(property, w.pre.start, w.post.end, metric).all<any>()).results : [];
    if (property && ['ctr', 'position'].includes(metric)) {
        const weights = (await env.DB.prepare("SELECT page_id,date,value FROM metric_series WHERE property_id=? AND date>=? AND date<=? AND metric='impressions' AND data_state='final'").bind(property, w.pre.start, w.post.end).all<any>()).results;
        const index = new Map(weights.map(r => [r.page_id + '|' + r.date, r.value]));
        for (const row of rows)
            row.weight = index.get(row.page_id + '|' + row.date);
    }
    const others = await listChanges(env, actor, { client: c.client_id, since: w.pre.start, until: w.post.end });
    const overlaps: string[] = [];
    for (const o of others) {
        if (o.id !== id && o.status !== 'planned' && (await resolvePages(env, o)).some(p => pages.includes(p)))
            overlaps.push(o.id);
    }
    const result = impact({ date: c.occurred_at, points: rows, pages, control, days, lag, overlaps, status: c.status, newPage: c.type === 'new_page', metric });
    if (metric === 'ctr' || metric === 'position')
        result.warnings.push('Impression-weighted mean. For position a lower value is better. Confidence thresholds are calibrated only for volume metrics.');
    const dates = [...new Set(rows.filter(r => pages.includes(r.page_id)).map(r => r.date))].sort();
    const series = dates.map(date => { const points = rows.filter(r => r.date === date && pages.includes(r.page_id)); const weighted = ['ctr', 'position'].includes(metric); const totalWeight = points.reduce((sum, p) => sum + (p.weight ?? 0), 0); return { date, value: weighted ? (totalWeight ? points.reduce((sum, p) => sum + p.value * (p.weight ?? 0), 0) / totalWeight : 0) : points.reduce((sum, p) => sum + p.value, 0), data_state: points.every(p => p.data_state === 'final') ? 'final' : 'fresh' }; });
    return { change: c, metric, property_id: property, series, ...result };
}
export async function storeMetrics(env: Env, metrics: Metric[]) { for (let i = 0; i < metrics.length; i += 40)
    await env.DB.batch(metrics.slice(i, i + 40).map(m => env.DB.prepare('INSERT INTO metric_series(property_id,page_id,date,metric,value,source,data_state,ingested_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(property_id,page_id,date,metric) DO UPDATE SET value=excluded.value,source=excluded.source,data_state=excluded.data_state,ingested_at=excluded.ingested_at').bind(m.property_id, m.page_id, m.date, m.metric, m.value, m.source, m.data_state, new Date().toISOString()))); }
export { day };
