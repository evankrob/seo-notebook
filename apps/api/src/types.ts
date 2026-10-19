export interface Actor {
    id: string;
    org_id: string;
    name: string;
    kind: 'human' | 'agent';
    model?: string;
    email?: string;
    scopes: string[];
    role?: string;
}
export type Job = {
    kind: 'sync';
    propertyId: string;
    date: string;
} | {
    /** Live properties: one Google query covers a date range (optionally one page). */
    kind: 'sync_range';
    propertyId: string;
    pageId?: string;
    start: string;
    end: string;
} | {
    kind: 'import';
    id: string;
};
export interface Env {
    DB: D1Database;
    UPLOADS: R2Bucket;
    JOBS: Queue<Job>;
    ASSETS: Fetcher;
    CONNECTOR_MODE: string;
    /** Service-account JSON key (a Worker secret). Unset = live Google properties are unavailable. */
    GOOGLE_SERVICE_ACCOUNT?: string;
    /** Cloudflare Access team domain, e.g. myteam.cloudflareaccess.com. Unset = local mode. */
    ACCESS_TEAM_DOMAIN?: string;
    /** Application Audience (AUD) tag of the Access application protecting the UI. */
    ACCESS_AUD?: string;
    /** Identity used in local mode (Access not configured, loopback requests only). */
    LOCAL_USER_EMAIL?: string;
}
export type Bindings = {
    Bindings: Env;
    Variables: {
        actor: Actor;
    };
};
export interface Change {
    id: string;
    client_id: string;
    occurred_at: string;
    timezone: string;
    status: string;
    type: string;
    page_ids: string[];
    group_id: string | null;
    sitewide: number;
    summary: string;
    rationale: string;
    author_id: string;
    author_name: string;
    author_kind: string;
    source: string;
    expected_metric: string;
    evidence: string[];
    tags: string[];
    diff: FieldChange[];
}
export interface FieldChange {
    field: string;
    before: string | null;
    after: string | null;
    note?: string;
}
export interface Metric {
    property_id: string;
    page_id: string;
    date: string;
    metric: string;
    value: number;
    source: string;
    data_state: 'final' | 'fresh';
}
