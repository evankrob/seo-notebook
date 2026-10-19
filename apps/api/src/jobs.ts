import { connector, syncWindow } from '../../../packages/connectors';
import { GoogleError, parseServiceAccount, syncAnalytics, syncSearchConsole } from '../../../packages/connectors/google';
import { parseCSV } from '../../../packages/connectors/csv';
import { day, date, logChange, storeMetrics } from './service';
import type { Env, Job, Metric } from './types';
import { z } from 'zod';
interface SyncProperty {
    id: string;
    client_id: string;
    type: string;
    external_id: string;
    mode: string;
}
const propertySQL = "SELECT p.id,p.client_id,p.type,p.external_id,COALESCE(c.mode,'mock') AS mode FROM property p LEFT JOIN connection c ON c.id=p.connection_id WHERE p.type IN ('gsc_domain','gsc_url_prefix','ga4')";

async function sendAll(env: Env, jobs: Job[]) {
    for (let i = 0; i < jobs.length; i += 100)
        await env.JOBS.sendBatch(jobs.slice(i, i + 100).map(body => ({ body })));
    return jobs.length;
}

/** Live jobs for one property: GA4 answers for every page at once, Search Console needs one query per page. */
export async function liveJobs(env: Env, p: SyncProperty, start: string, end: string, pageId?: string): Promise<Job[]> {
    if (p.type === 'ga4' || pageId)
        return [{ kind: 'sync_range', propertyId: p.id, start, end, ...(pageId ? { pageId } : {}) }];
    const pages = (await env.DB.prepare('SELECT id FROM page WHERE client_id=?').bind(p.client_id).all<{ id: string }>()).results;
    return pages.map(pg => ({ kind: 'sync_range', propertyId: p.id, pageId: pg.id, start, end }));
}

export async function fanout(env: Env, propertyId?: string, backfill = false) {
    const today = new Date().toISOString().slice(0, 10);
    const props = (await (propertyId ? env.DB.prepare(propertySQL + ' AND p.id=?').bind(propertyId) : env.DB.prepare(propertySQL)).all<SyncProperty>()).results;
    const { start, end } = syncWindow(today, backfill);
    const jobs: Job[] = [];
    for (const p of props) {
        if (p.mode === 'live')
            jobs.push(...await liveJobs(env, p, start, end));
        else
            for (let d = start; d <= end; d = day(d, 1))
                jobs.push({ kind: 'sync', propertyId: p.id, date: d });
    }
    return sendAll(env, jobs);
}

/** History for a page the notebook just learned about, from every live property of its site. */
export async function backfillPage(env: Env, clientId: string, pageId: string) {
    const props = (await env.DB.prepare(propertySQL + " AND p.client_id=? AND c.mode='live'").bind(clientId).all<SyncProperty>()).results;
    const { start, end } = syncWindow(new Date().toISOString().slice(0, 10), true);
    const jobs: Job[] = [];
    for (const p of props)
        jobs.push(...await liveJobs(env, p, start, end, pageId));
    return sendAll(env, jobs);
}

async function syncLive(env: Env, job: Extract<Job, { kind: 'sync_range' }>) {
    const p = await env.DB.prepare(propertySQL + ' AND p.id=?').bind(job.propertyId).first<SyncProperty>();
    if (!p || p.mode !== 'live')
        return; // Removed or switched back to fixtures since the job was queued.
    const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT);
    if (!sa)
        throw new Error('GOOGLE_SERVICE_ACCOUNT is not configured');
    const pages = (await env.DB.prepare('SELECT id,url FROM page WHERE client_id=?' + (job.pageId ? ' AND id=?' : '')).bind(p.client_id, ...(job.pageId ? [job.pageId] : [])).all<{ id: string; url: string }>()).results;
    if (!pages.length)
        return;
    const request = { propertyId: p.id, externalId: p.external_id, pages, start: job.start, end: job.end, today: new Date().toISOString().slice(0, 10) };
    const now = new Date().toISOString();
    try {
        await storeMetrics(env, p.type === 'ga4' ? await syncAnalytics(sa, request) : await syncSearchConsole(sa, request));
    }
    catch (e) {
        // Google's message says what to fix (e.g. "API has not been used in project … enable it by visiting https://…").
        if (e instanceof GoogleError)
            await env.DB.prepare('UPDATE property SET last_sync_at=?,last_sync_error=? WHERE id=?').bind(now, e.message, p.id).run();
        throw e;
    }
    await env.DB.prepare('UPDATE property SET last_sync_at=?,last_sync_ok_at=?,last_sync_error=NULL WHERE id=?').bind(now, now, p.id).run();
}

const metricSchema = z.object({ property_id: z.string(), page_id: z.string(), date, metric: z.enum(['clicks', 'impressions', 'ctr', 'position', 'sessions', 'key_events', 'revenue', 'custom']), value: z.coerce.number().finite().nonnegative(), data_state: z.enum(['final', 'fresh']).default('final') });
export async function processJob(env: Env, job: Job) {
    if (job.kind === 'sync_range')
        return syncLive(env, job);
    if (job.kind === 'sync') {
        const p = await env.DB.prepare('SELECT * FROM property WHERE id=?').bind(job.propertyId).first<any>();
        if (!p)
            throw new Error('Property missing');
        const pages = (await env.DB.prepare('SELECT id,url FROM page WHERE client_id=?').bind(p.client_id).all<{
            id: string;
            url: string;
        }>()).results;
        const rows = await connector(p.type === 'ga4' ? 'ga4' : 'gsc', 'mock').sync({ propertyId: p.id, pages, date: job.date, today: new Date().toISOString().slice(0, 10) });
        await storeMetrics(env, rows);
        return;
    }
    const j = await env.DB.prepare('SELECT * FROM import_job WHERE id=?').bind(job.id).first<any>();
    if (!j || j.status === 'completed')
        return;
    try {
        const obj = await env.UPLOADS.get(j.object_key);
        if (!obj)
            throw new Error('Raw upload missing');
        const body = await obj.text();
        const rows: Record<string, any>[] = j.kind.endsWith('json') ? JSON.parse(body) : parseCSV(body);
        if (!Array.isArray(rows) || rows.length > 5000)
            throw new Error('Expected at most 5000 rows');
        const actor = JSON.parse(j.actor_json);
        let count = 0;
        if (j.kind.startsWith('changes')) {
            // Validate every row before writing; retries use stable per-row idempotency keys.
            const changes = rows.map(r => ({ client_id: j.client_id, occurred_at: r.occurred_at, timezone: r.timezone || 'UTC', status: r.status || 'shipped', type: r.type, summary: r.summary, rationale: r.rationale, page_ids: r.page_id ? [r.page_id] : [], sitewide: r.sitewide === 'true', ...(r.group_id ? { group_id: r.group_id } : {}) }));
            const { changeSchema } = await import('./service');
            for (const c of changes)
                changeSchema.parse(c);
            for (const c of changes) {
                await logChange(env, actor, c, `import:${j.id}:${count}`, 'import');
                count++;
            }
        }
        else {
            const metrics: Metric[] = [];
            for (const row of rows) {
                const m = metricSchema.parse(row);
                const valid = await env.DB.prepare('SELECT p.id FROM property p JOIN page pg ON pg.client_id=p.client_id WHERE p.id=? AND pg.id=? AND p.client_id=?').bind(m.property_id, m.page_id, j.client_id).first();
                if (!valid)
                    throw new Error('Metric property/page outside client');
                metrics.push({ ...m, source: 'import' });
            }
            await storeMetrics(env, metrics);
            count = metrics.length;
        }
        await env.DB.prepare("UPDATE import_job SET status='completed',error=NULL,row_count=? WHERE id=?").bind(count, j.id).run();
    }
    catch (e) {
        await env.DB.prepare("UPDATE import_job SET status='failed',error=? WHERE id=?").bind(e instanceof Error ? e.message : 'Import failed', job.id).run();
        throw e;
    }
}
