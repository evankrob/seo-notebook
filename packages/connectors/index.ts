import type { Metric } from '../../apps/api/src/types';
export interface ConnectionConfig {
    provider: 'gsc' | 'ga4';
    authType: 'oauth' | 'service_account';
    mode: 'mock';
}
export interface SyncRequest {
    propertyId: string;
    pages: {
        id: string;
        url: string;
    }[];
    date: string;
    today: string;
}
export interface Connector {
    readonly provider: 'gsc' | 'ga4';
    sync(request: SyncRequest): Promise<Metric[]>;
}
// Deliberately no HTTP client, OAuth implementation or credential fields in MVP.
export class FixtureConnector implements Connector {
    constructor(public readonly provider: 'gsc' | 'ga4') { }
    async sync(r: SyncRequest): Promise<Metric[]> {
        const index = Math.floor(Date.parse(r.date) / 86400000);
        const state = r.date >= new Date(Date.parse(r.today) - 3 * 86400000).toISOString().slice(0, 10) ? 'fresh' : 'final';
        return r.pages.flatMap((p, i) => {
            const base = 18 + i * 3 + (index % 7), uplift = r.date >= '2026-09-05' && i === 0 ? 1.35 : 1;
            const values = this.provider === 'gsc' ? { clicks: Math.round(base * uplift), impressions: Math.round(base * 30 * uplift), ctr: 1 / 30, position: 8 - i * .5 } : { sessions: Math.round(base * 3 * uplift), key_events: Math.round(base * .2 * uplift) };
            return Object.entries(values).map(([metric, value]) => ({ property_id: r.propertyId, page_id: p.id, date: r.date, metric, value: value!, source: `mock:${this.provider}`, data_state: state }));
        });
    }
}
export function connector(provider: string, mode: string): Connector {
    if (mode !== 'mock')
        throw new Error('Only fixture connectors are available');
    if (provider !== 'gsc' && provider !== 'ga4')
        throw new Error('Unsupported connector');
    return new FixtureConnector(provider);
}
