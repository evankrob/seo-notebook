// Live Search Console and GA4 data through a Google service account.
// The key comes from the GOOGLE_SERVICE_ACCOUNT Worker secret and is never written to the database.
import type { Metric } from '../../apps/api/src/types';
import { day } from '../impact';

export interface ServiceAccount {
    client_email: string;
    private_key: string;
    token_uri: string;
}

export interface Page {
    id: string;
    url: string;
}

export interface RangeRequest {
    propertyId: string;
    /** `sc-domain:example.com`, `https://example.com/` or a numeric GA4 property ID. */
    externalId: string;
    pages: Page[];
    start: string;
    end: string;
    today: string;
}

const SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly';
const GSC = 'https://www.googleapis.com/webmasters/v3';
const GA4_DATA = 'https://analyticsdata.googleapis.com/v1beta';
const GA4_ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
// Recent days are still being revised by Google; they are stored as `fresh` and re-pulled by the daily sync.
const FRESH_DAYS = 3;

export class GoogleError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

/** Parses the downloaded JSON key. Returns null when the secret is unset or unusable. */
export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
    if (!raw)
        return null;
    try {
        const k = JSON.parse(raw) as Partial<ServiceAccount>;
        if (typeof k.client_email !== 'string' || typeof k.private_key !== 'string' || !k.private_key.includes('PRIVATE KEY'))
            return null;
        return { client_email: k.client_email, private_key: k.private_key, token_uri: k.token_uri ?? 'https://oauth2.googleapis.com/token' };
    }
    catch {
        return null;
    }
}

const b64url = (data: ArrayBuffer | string) => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    let s = '';
    for (const b of bytes)
        s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function signedAssertion(sa: ServiceAccount, now: number) {
    const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const iat = Math.floor(now / 1000);
    const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.'
        + b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPES, aud: sa.token_uri, iat, exp: iat + 3600 }));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    return unsigned + '.' + b64url(signature);
}

// Per-isolate cache; tokens live an hour and are refreshed five minutes early.
const tokens = new Map<string, { token: string; expires: number }>();
export const clearTokenCache = () => tokens.clear();

export async function accessToken(sa: ServiceAccount, now = Date.now()): Promise<string> {
    const cached = tokens.get(sa.client_email);
    if (cached && cached.expires > now + 300_000)
        return cached.token;
    const r = await fetch(sa.token_uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await signedAssertion(sa, now) }),
    });
    const body = await r.json() as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!r.ok || !body.access_token)
        throw new GoogleError(r.status, 'Google sign-in failed: ' + (body.error_description ?? body.error ?? r.statusText));
    tokens.set(sa.client_email, { token: body.access_token, expires: now + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
}

async function call<T>(sa: ServiceAccount, url: string, body?: unknown): Promise<T> {
    const r = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + await accessToken(sa), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({})) as T & { error?: { message?: string } };
    if (!r.ok)
        throw new GoogleError(r.status, json.error?.message ?? `Google API error ${r.status}`);
    return json;
}

const dates = (start: string, end: string) => {
    const out: string[] = [];
    for (let d = start; d <= end; d = day(d, 1))
        out.push(d);
    return out;
};
const state = (date: string, today: string): Metric['data_state'] => date > day(today, -FRESH_DAYS - 1) ? 'fresh' : 'final';

interface GscRow { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }

/** One query per page, by date. Days with no impressions come back missing and are stored as zero once final. */
export async function syncSearchConsole(sa: ServiceAccount, r: RangeRequest): Promise<Metric[]> {
    const out: Metric[] = [];
    const url = `${GSC}/sites/${encodeURIComponent(r.externalId)}/searchAnalytics/query`;
    for (const page of r.pages) {
        const res = await call<{ rows?: GscRow[] }>(sa, url, {
            startDate: r.start,
            endDate: r.end,
            dimensions: ['date'],
            dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: page.url }] }],
            type: 'web',
            dataState: 'all',
            rowLimit: 25000,
        });
        const byDate = new Map((res.rows ?? []).map(row => [row.keys[0], row]));
        for (const date of dates(r.start, r.end)) {
            const row = byDate.get(date);
            const data_state = state(date, r.today);
            if (!row && data_state === 'fresh')
                continue;
            const values: Record<string, number> = row
                ? { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }
                : { clicks: 0, impressions: 0 };
            for (const [metric, value] of Object.entries(values))
                out.push({ property_id: r.propertyId, page_id: page.id, date, metric, value, source: 'gsc', data_state });
        }
    }
    return out;
}

interface Ga4Report { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[]; rowCount?: number }

/** Organic Search sessions and key events by landing page, for all requested pages in a few calls. */
export async function syncAnalytics(sa: ServiceAccount, r: RangeRequest): Promise<Metric[]> {
    const byPath = new Map<string, string[]>();
    for (const p of r.pages) {
        const path = new URL(p.url).pathname;
        byPath.set(path, [...(byPath.get(path) ?? []), p.id]);
    }
    const paths = [...byPath.keys()];
    const totals = new Map<string, { sessions: number; key_events: number }>();
    const url = `${GA4_DATA}/properties/${encodeURIComponent(r.externalId)}:runReport`;
    for (let i = 0; i < paths.length; i += 200) {
        const values = paths.slice(i, i + 200);
        for (let offset = 0; ; offset += 100000) {
            const res = await call<Ga4Report>(sa, url, {
                dateRanges: [{ startDate: r.start, endDate: r.end }],
                dimensions: [{ name: 'date' }, { name: 'landingPage' }],
                metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
                dimensionFilter: { andGroup: { expressions: [
                    { filter: { fieldName: 'landingPage', inListFilter: { values } } },
                    { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { value: 'Organic Search' } } },
                ] } },
                limit: 100000,
                offset,
            });
            for (const row of res.rows ?? []) {
                const [rawDate, path] = row.dimensionValues.map(v => v.value);
                const key = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}|${path}`;
                const t = totals.get(key) ?? { sessions: 0, key_events: 0 };
                t.sessions += Number(row.metricValues[0].value) || 0;
                t.key_events += Number(row.metricValues[1].value) || 0;
                totals.set(key, t);
            }
            if (offset + 100000 >= (res.rowCount ?? 0))
                break;
        }
    }
    const out: Metric[] = [];
    for (const date of dates(r.start, r.end)) {
        const data_state = state(date, r.today);
        for (const [path, ids] of byPath) {
            const t = totals.get(date + '|' + path);
            if (!t && data_state === 'fresh')
                continue;
            for (const page_id of ids)
                for (const [metric, value] of Object.entries(t ?? { sessions: 0, key_events: 0 }))
                    out.push({ property_id: r.propertyId, page_id, date, metric, value, source: 'ga4', data_state });
        }
    }
    return out;
}

export interface Discovery {
    email: string;
    gsc: { siteUrl: string; permissionLevel: string }[];
    ga4: { id: string; name: string; account: string }[];
    errors: { gsc?: string; ga4?: string };
}

/** What the service account can see, so the UI can offer a pick list instead of typed IDs. */
export async function discover(sa: ServiceAccount): Promise<Discovery> {
    const out: Discovery = { email: sa.client_email, gsc: [], ga4: [], errors: {} };
    const [gsc, ga4] = await Promise.allSettled([
        call<{ siteEntry?: Discovery['gsc'] }>(sa, `${GSC}/sites`),
        call<{ accountSummaries?: { displayName: string; propertySummaries?: { property: string; displayName: string }[] }[] }>(sa, `${GA4_ADMIN}/accountSummaries?pageSize=200`),
    ]);
    if (gsc.status === 'fulfilled')
        out.gsc = (gsc.value.siteEntry ?? []).filter(s => s.permissionLevel !== 'siteUnverifiedUser');
    else
        out.errors.gsc = (gsc.reason as Error).message;
    if (ga4.status === 'fulfilled')
        out.ga4 = (ga4.value.accountSummaries ?? []).flatMap(a => (a.propertySummaries ?? []).map(p => ({ id: p.property.replace('properties/', ''), name: p.displayName, account: a.displayName })));
    else
        out.errors.ga4 = (ga4.reason as Error).message;
    return out;
}
