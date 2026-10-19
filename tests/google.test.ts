import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { accessToken, clearTokenCache, discover, parseServiceAccount, syncAnalytics, syncSearchConsole, type ServiceAccount } from '../packages/connectors/google';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const testKey = JSON.stringify({ type: 'service_account', client_email: 'notebook@test-project.iam.gserviceaccount.com', private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' });
const sa = parseServiceAccount(testKey) as ServiceAccount;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Request bodies are whatever JSON the connector sent; tests read them loosely.
type Body = Record<string, any>; // oxlint-disable-line typescript/no-explicit-any
interface Call { url: string; body: Body }
let calls: Call[];
function mockGoogle(handler: (url: string, body: Body) => Response | undefined) {
    calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        const raw = init?.body;
        const body = raw instanceof URLSearchParams ? Object.fromEntries(raw) : typeof raw === 'string' ? JSON.parse(raw) : undefined;
        calls.push({ url, body });
        if (url === 'https://oauth2.googleapis.com/token')
            return json({ access_token: 'token-1', expires_in: 3600 });
        return handler(url, body) ?? json({ error: { message: 'unexpected ' + url } }, 500);
    });
}
beforeEach(() => clearTokenCache());
afterEach(() => vi.restoreAllMocks());

describe('Google service-account connector', () => {
    it('rejects missing or malformed keys', () => {
        expect(parseServiceAccount(undefined)).toBeNull();
        expect(parseServiceAccount('not json')).toBeNull();
        expect(parseServiceAccount('{"client_email":"x"}')).toBeNull();
        expect(sa.client_email).toContain('@');
    });

    it('signs a verifiable RS256 assertion and caches the token', async () => {
        mockGoogle(() => undefined);
        expect(await accessToken(sa)).toBe('token-1');
        expect(await accessToken(sa)).toBe('token-1');
        expect(calls).toHaveLength(1);
        const [head, claims, sig] = calls[0].body.assertion.split('.');
        const payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
        expect(payload).toMatchObject({ iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token' });
        expect(payload.scope).toContain('webmasters.readonly');
        expect(payload.scope).toContain('analytics.readonly');
        expect(createVerify('RSA-SHA256').update(head + '.' + claims).verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    });

    it('surfaces token errors', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400));
        await expect(accessToken(sa)).rejects.toThrow('Invalid JWT Signature');
    });

    it('queries Search Console per page and zero-fills final days without impressions', async () => {
        mockGoogle((url) => url.includes('/searchAnalytics/query') ? json({ rows: [{ keys: ['2026-10-01'], clicks: 4, impressions: 120, ctr: 0.033, position: 7.2 }] }) : undefined);
        const rows = await syncSearchConsole(sa, { propertyId: 'prop', externalId: 'sc-domain:cedar.example', pages: [{ id: 'garden', url: 'https://cedar.example/garden-tools/' }], start: '2026-10-01', end: '2026-10-18', today: '2026-10-19' });
        const q = calls.find(c => c.url.includes('searchAnalytics'))!;
        expect(q.url).toContain('/sites/sc-domain%3Acedar.example/');
        expect(q.body.dimensionFilterGroups[0].filters[0]).toEqual({ dimension: 'page', operator: 'equals', expression: 'https://cedar.example/garden-tools/' });
        expect(rows.find(r => r.date === '2026-10-01' && r.metric === 'clicks')).toMatchObject({ value: 4, data_state: 'final', source: 'gsc' });
        expect(rows.find(r => r.date === '2026-10-02' && r.metric === 'clicks')?.value).toBe(0);
        // Fresh days with no data are left out so a later sync can fill them.
        expect(rows.some(r => r.date >= '2026-10-16')).toBe(false);
    });

    it('reads organic GA4 sessions by landing page and maps them to pages', async () => {
        mockGoogle((url) => url.includes(':runReport') ? json({ rowCount: 1, rows: [{ dimensionValues: [{ value: '20261001' }, { value: '/contact/' }], metricValues: [{ value: '30' }, { value: '2' }] }] }) : undefined);
        const rows = await syncAnalytics(sa, { propertyId: 'ga', externalId: '123', pages: [{ id: 'contact', url: 'https://cedar.example/contact/' }], start: '2026-10-01', end: '2026-10-02', today: '2026-10-19' });
        const q = calls.find(c => c.url.includes(':runReport'))!;
        expect(q.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/123:runReport');
        expect(JSON.stringify(q.body.dimensionFilter)).toContain('Organic Search');
        expect(q.body.dimensionFilter.andGroup.expressions[0].filter.inListFilter.values).toEqual(['/contact/']);
        expect(rows.filter(r => r.date === '2026-10-01').map(r => [r.metric, r.value])).toEqual([['sessions', 30], ['key_events', 2]]);
        expect(rows.find(r => r.date === '2026-10-02' && r.metric === 'sessions')?.value).toBe(0);
    });

    it('lists visible properties and reports per-API errors', async () => {
        mockGoogle((url) => url.endsWith('/sites')
            ? json({ siteEntry: [{ siteUrl: 'sc-domain:cedar.example', permissionLevel: 'siteRestrictedUser' }, { siteUrl: 'https://x.example/', permissionLevel: 'siteUnverifiedUser' }] })
            : json({ error: { message: 'Analytics Admin API has not been used in project' } }, 403));
        const d = await discover(sa);
        expect(d.gsc.map(s => s.siteUrl)).toEqual(['sc-domain:cedar.example']);
        expect(d.ga4).toEqual([]);
        expect(d.errors.ga4).toContain('Admin API');
    });
});
