import { z } from 'zod';
import { day, impact, windows } from '../../../packages/impact';
import type { Actor, Change, Env, Metric } from './types';
import { hash } from './auth';
export class HttpError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Invalid date');
export const types = ['new_page', 'content', 'title_meta', 'internal_links', 'schema', 'redirect', 'template', 'technical', 'CRO_form', 'CRO_layout', 'ppc_landing', 'external_event'] as const;
export const fields = ['title', 'meta_description', 'h1', 'headings', 'content', 'canonical', 'robots', 'schema', 'redirect', 'internal_links', 'images', 'url', 'other'] as const;
// One edited field with its previous and new value. Long content should be excerpted by the agent.
export const fieldChange = z.object({ field: z.enum(fields), before: z.string().max(5000).nullable().default(null), after: z.string().max(5000).nullable().default(null), note: z.string().max(300).optional() }).strict();
export const changeSchema = z.object({ client_id: z.string().min(1), occurred_at: date, timezone: z.string().default('UTC').refine(s => { try {
        new Intl.DateTimeFormat('en', { timeZone: s });
        return true;
    }
    catch {
        return false;
    } }, 'Invalid timezone'), status: z.enum(['planned', 'shipped', 'reverted']).default('shipped'), type: z.enum(types), page_ids: z.array(z.string()).max(200).default([]), group_id: z.string().nullable().default(null), sitewide: z.boolean().default(false), summary: z.string().min(1).max(500), rationale: z.string().min(1).max(4000), evidence: z.array(z.string().url().refine(s => /^https?:/.test(s))).max(20).default([]), expected_metric: z.enum(['clicks', 'impressions', 'ctr', 'position', 'sessions', 'key_events', 'revenue', 'custom']).default('clicks'), tags: z.array(z.string().max(80)).max(30).default([]), diff: z.array(fieldChange).max(20).default([]) }).strict();
export function decode(row: any): Change { return { ...row, page_ids: JSON.parse(row.page_ids), evidence: JSON.parse(row.evidence), tags: JSON.parse(row.tags), diff: JSON.parse(row.diff ?? '[]') }; }
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
    if (q.site) {
        sql += ' AND c.domain=?';
        args.push(siteDomain(q.site));
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
export const normalizeURL = (s: string) => { let u: URL;
    try {
        u = new URL(s);
    }
    catch {
        throw new HttpError(400, 'Invalid URL: ' + s.slice(0, 200));
    } if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new HttpError(400, 'Expected HTTP(S) URL'); u.hash = ''; u.search = ''; u.hostname = u.hostname.toLowerCase(); return u.toString(); };
// Per-request memo for computing many impacts at once (reports). Data is loaded once for
// the [start, end] date range and filtered in memory, so query count stays constant.
export interface ImpactCache {
    start: string;
    end: string;
    memo: Map<string, Promise<unknown>>;
}
export const impactCache = (start: string, end: string): ImpactCache => ({ start, end, memo: new Map() });
function remember<T>(cache: ImpactCache | undefined, key: string, load: () => Promise<T>): Promise<T> {
    if (!cache)
        return load();
    let value = cache.memo.get(key) as Promise<T> | undefined;
    if (!value) {
        value = load();
        cache.memo.set(key, value);
    }
    return value;
}
const covers = (cache: ImpactCache | undefined, start: string, end: string): cache is ImpactCache => !!cache && start >= cache.start && end <= cache.end;
export async function resolvePages(env: Env, c: Change, cache?: ImpactCache): Promise<string[]> {
    if (c.sitewide)
        return remember(cache, 'site:' + c.client_id, async () => (await env.DB.prepare('SELECT id FROM page WHERE client_id=?').bind(c.client_id).all<{
            id: string;
        }>()).results.map(p => p.id));
    if (c.group_id) {
        if (cache) {
            const groups = await remember(cache, 'groups:' + c.client_id, async () => new Map((await env.DB.prepare('SELECT id,page_ids FROM page_group WHERE client_id=?').bind(c.client_id).all<{
                id: string;
                page_ids: string;
            }>()).results.map(g => [g.id, JSON.parse(g.page_ids) as string[]])));
            return groups.get(c.group_id) ?? [];
        }
        const g = await env.DB.prepare('SELECT page_ids FROM page_group WHERE id=? AND client_id=?').bind(c.group_id, c.client_id).first<{
            page_ids: string;
        }>();
        return g ? JSON.parse(g.page_ids) : [];
    }
    return c.page_ids;
}
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
/** Site key for a hostname or URL: lowercase, without a leading "www.". */
export function siteDomain(hostOrUrl: string) {
    let host: string;
    try {
        host = new URL(hostOrUrl.includes('://') ? hostOrUrl : 'https://' + hostOrUrl).hostname;
    }
    catch {
        throw new HttpError(400, 'Invalid site: ' + hostOrUrl);
    }
    return host.toLowerCase().replace(/^www\./, '');
}
interface SiteRow {
    id: string;
    org_id: string;
    name: string;
    timezone: string;
    domain: string;
}
/** Finds or creates the site for a domain in the actor's workspace. */
export async function ensureSite(env: Env, actor: Actor, domain: string, timezone = 'UTC'): Promise<SiteRow> {
    const find = () => env.DB.prepare('SELECT * FROM client WHERE org_id=? AND domain=?').bind(actor.org_id, domain).first<SiteRow>();
    const found = await find();
    if (found)
        return found;
    await env.DB.prepare('INSERT OR IGNORE INTO client(id,org_id,name,timezone,domain) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), actor.org_id, domain, timezone, domain).run();
    return (await find())!;
}
async function ensurePage(env: Env, clientId: string, url: string) {
    const r = await env.DB.prepare("INSERT OR IGNORE INTO page(id,client_id,url,canonical,tags) VALUES (?,?,?,NULL,'[]')").bind(crypto.randomUUID(), clientId, url).run();
    const id = (await env.DB.prepare('SELECT id FROM page WHERE client_id=? AND url=?').bind(clientId, url).first<{ id: string }>())!.id;
    // A new page has no metrics yet; pull its history from any live Google property of the site.
    if (r.meta.changes)
        await (await import('./jobs')).backfillPage(env, clientId, id);
    return id;
}
export async function listSites(env: Env, actor: Actor) {
    scope(actor, 'read:metrics');
    return (await env.DB.prepare(`SELECT c.id, c.domain, c.name, c.timezone,
        (SELECT COUNT(*) FROM page p WHERE p.client_id=c.id) AS pages,
        (SELECT COUNT(*) FROM change_entry e WHERE e.client_id=c.id) AS changes,
        (SELECT MAX(e.occurred_at) FROM change_entry e WHERE e.client_id=c.id) AS last_change_at
        FROM client c WHERE c.org_id=? ORDER BY last_change_at IS NULL, last_change_at DESC, c.domain`).bind(actor.org_id).all()).results;
}
// What agents send: URLs instead of IDs; date and type are optional.
export const changeInputSchema = changeSchema.extend({
    client_id: z.string().min(1).optional(),
    site: z.string().min(1).max(253).optional(),
    url: z.string().max(2000).optional(),
    urls: z.array(z.string().max(2000)).max(200).optional(),
    occurred_at: date.optional(),
    type: z.enum(types).optional(),
}).strict();
const typeByField: Partial<Record<(typeof fields)[number], (typeof types)[number]>> = { title: 'title_meta', meta_description: 'title_meta', schema: 'schema', redirect: 'redirect', internal_links: 'internal_links', canonical: 'technical', robots: 'technical' };
function inferType(diff: z.infer<typeof fieldChange>[]): (typeof types)[number] {
    const kinds = new Set(diff.map(d => typeByField[d.field] ?? 'content'));
    return kinds.size === 1 ? [...kinds][0] : 'content';
}
const today = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
/** Turns agent input into a stored change, creating the site and pages from URLs as needed. */
async function resolveChange(env: Env, actor: Actor, input: z.infer<typeof changeInputSchema>) {
    const { site, url, urls, ...rest } = input;
    const pageUrls = [...(url ? [url] : []), ...(urls ?? [])].map(normalizeURL);
    const domains = new Set(pageUrls.map(siteDomain));
    if (site)
        domains.add(siteDomain(site));
    if (domains.size > 1)
        throw new HttpError(400, 'All URLs in one change must belong to the same site');
    let clientId = input.client_id;
    if (domains.size === 1) {
        const found = await ensureSite(env, actor, [...domains][0], input.timezone);
        if (clientId && clientId !== found.id)
            throw new HttpError(400, 'client_id does not match the site of the URLs');
        clientId = found.id;
    }
    if (!clientId)
        throw new HttpError(400, 'Provide url, urls or site (or client_id)');
    await client(env, actor, clientId);
    const pageIds = [...rest.page_ids, ...await Promise.all(pageUrls.map(u => ensurePage(env, clientId, u)))];
    return changeSchema.parse({ ...rest, client_id: clientId, page_ids: [...new Set(pageIds)], occurred_at: input.occurred_at ?? today(input.timezone), type: input.type ?? inferType(input.diff) });
}
export async function logChange(env: Env, actor: Actor, raw: unknown, key?: string, source = 'api') {
    scope(actor, 'write:changes');
    const input = changeInputSchema.parse(raw);
    if (key && key.length > 200)
        throw new HttpError(400, 'Idempotency key too long');
    // Hash what was sent, before defaults like "today" are applied, so retries stay identical.
    const requestHash = await hash(JSON.stringify(input));
    if (key) {
        const old = await env.DB.prepare('SELECT * FROM idempotency WHERE actor_id=? AND key=?').bind(actor.id, key).first<any>();
        if (old) {
            if (old.request_hash !== requestHash)
                throw new HttpError(409, 'Idempotency key reused with different content');
            return getChange(env, actor, old.change_id);
        }
    }
    const c = await resolveChange(env, actor, input);
    await validateScope(env, c);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const insert = env.DB.prepare('INSERT INTO change_entry (id,client_id,occurred_at,timezone,status,type,page_ids,group_id,sitewide,summary,rationale,author_id,author_name,author_kind,model,source,evidence,expected_metric,tags,created_at,updated_at,diff) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, c.client_id, c.occurred_at, c.timezone, c.status, c.type, JSON.stringify(c.page_ids), c.group_id, Number(c.sitewide), c.summary, c.rationale, actor.id, actor.name, actor.kind, actor.model ?? null, source, JSON.stringify(c.evidence), c.expected_metric, JSON.stringify(c.tags), now, now, JSON.stringify(c.diff));
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
    await env.DB.prepare('UPDATE change_entry SET occurred_at=?,timezone=?,status=?,type=?,page_ids=?,group_id=?,sitewide=?,summary=?,rationale=?,evidence=?,expected_metric=?,tags=?,diff=?,updated_at=? WHERE id=?').bind(merged.occurred_at, merged.timezone, merged.status, merged.type, JSON.stringify(merged.page_ids), merged.group_id, Number(merged.sitewide), merged.summary, merged.rationale, JSON.stringify(merged.evidence), merged.expected_metric, JSON.stringify(merged.tags), JSON.stringify(merged.diff), new Date().toISOString(), id).run();
    return getChange(env, actor, id);
}
interface MetricRow {
    page_id: string;
    date: string;
    value: number;
    data_state: 'final' | 'fresh';
    weight?: number;
}
async function metricRows(env: Env, property: string, metric: string, start: string, end: string, cache?: ImpactCache): Promise<MetricRow[]> {
    const load = async (s: string, e: string) => {
        const rows = (await env.DB.prepare('SELECT page_id,date,value,data_state FROM metric_series WHERE property_id=? AND date>=? AND date<=? AND metric=?').bind(property, s, e, metric).all<MetricRow>()).results;
        if (['ctr', 'position'].includes(metric)) {
            const weights = (await env.DB.prepare("SELECT page_id,date,value FROM metric_series WHERE property_id=? AND date>=? AND date<=? AND metric='impressions' AND data_state='final'").bind(property, s, e).all<MetricRow>()).results;
            const index = new Map(weights.map(r => [r.page_id + '|' + r.date, r.value]));
            for (const row of rows)
                row.weight = index.get(row.page_id + '|' + row.date);
        }
        return rows;
    };
    if (!covers(cache, start, end))
        return load(start, end);
    const all = await remember(cache, `rows:${property}:${metric}`, () => load(cache.start, cache.end));
    return all.filter(r => r.date >= start && r.date <= end);
}
export async function getImpact(env: Env, actor: Actor, id: string, q: Record<string, string | undefined> = {}, opts: {
    cache?: ImpactCache;
    change?: Change;
} = {}) {
    scope(actor, 'read:metrics');
    const { cache } = opts;
    // A preloaded change must already have been read through an org-scoped query.
    const c = opts.change ?? await getChange(env, actor, id), days = z.coerce.number().int().min(7).max(180).parse(q.days ?? 28), lag = z.coerce.number().int().min(0).max(60).parse(q.lag ?? 3);
    const w = windows(c.occurred_at, days, lag);
    const pages = await resolvePages(env, c, cache);
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
    else {
        const [a, b] = ['sessions', 'key_events', 'revenue'].includes(metric) ? ['ga4', 'ga4'] : metric === 'custom' ? ['custom', 'custom'] : ['gsc_domain', 'gsc_url_prefix'];
        property = await remember(cache, `property:${c.client_id}:${a}`, async () => (await env.DB.prepare('SELECT id FROM property WHERE client_id=? AND type IN (?,?) ORDER BY id LIMIT 1').bind(c.client_id, a, b).first<{
            id: string;
        }>())?.id);
    }
    const relevant = new Set([...pages, ...control]);
    const rows = property ? (await metricRows(env, property, metric, w.pre.start, w.post.end, cache)).filter(r => relevant.has(r.page_id)) : [];
    const others = covers(cache, w.pre.start, w.post.end)
        ? (await remember(cache, 'changes:' + c.client_id, () => listChanges(env, actor, { client: c.client_id, since: cache.start, until: cache.end }))).filter(o => o.occurred_at >= w.pre.start && o.occurred_at <= w.post.end)
        : await listChanges(env, actor, { client: c.client_id, since: w.pre.start, until: w.post.end });
    const overlaps: string[] = [];
    for (const o of others) {
        if (o.id !== c.id && o.status !== 'planned' && (await resolvePages(env, o, cache)).some(p => pages.includes(p)))
            overlaps.push(o.id);
    }
    if (control.some(id => pages.includes(id))) throw new HttpError(400, 'Control must exclude changed pages');
    const result = impact({ date: c.occurred_at, points: rows, pages, control, days, lag, overlaps, status: c.status, newPage: c.type === 'new_page', metric });
    if (metric === 'ctr' || metric === 'position')
        result.warnings.push('Impression-weighted mean. For position a lower value is better. Confidence thresholds are calibrated only for volume metrics.');
    const weighted = ['ctr', 'position'].includes(metric);
    const byDate = new Map<string, MetricRow[]>();
    for (const r of rows) {
        if (pages.includes(r.page_id))
            byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    }
    const series = [...byDate.keys()].toSorted().map(date => {
        const points = byDate.get(date)!;
        const totalWeight = points.reduce((sum, p) => sum + (p.weight ?? 0), 0);
        const value = weighted ? (totalWeight ? points.reduce((sum, p) => sum + p.value * (p.weight ?? 0), 0) / totalWeight : 0) : points.reduce((sum, p) => sum + p.value, 0);
        return { date, value, data_state: points.every(p => p.data_state === 'final') ? 'final' : 'fresh' };
    });
    return { change: c, metric, property_id: property, series, ...result };
}
export async function storeMetrics(env: Env, metrics: Metric[]) { for (let i = 0; i < metrics.length; i += 40)
    await env.DB.batch(metrics.slice(i, i + 40).map(m => env.DB.prepare('INSERT INTO metric_series(property_id,page_id,date,metric,value,source,data_state,ingested_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(property_id,page_id,date,metric) DO UPDATE SET value=excluded.value,source=excluded.source,data_state=excluded.data_state,ingested_at=excluded.ingested_at').bind(m.property_id, m.page_id, m.date, m.metric, m.value, m.source, m.data_state, new Date().toISOString()))); }
export { day };
