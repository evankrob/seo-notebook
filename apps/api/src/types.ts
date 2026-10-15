export interface Actor { id: string; org_id: string; name: string; kind: 'human'|'agent'; model?: string; scopes: string[]; role?: string }
export type Job = { kind:'sync'; propertyId:string; date:string } | {kind:'import'; id:string};
export interface Env { DB:D1Database; UPLOADS:R2Bucket; JOBS:Queue<Job>; ASSETS:Fetcher; CONNECTOR_MODE:string; APP_ORIGIN:string }
export type Bindings = { Bindings:Env; Variables:{actor:Actor} };
export interface Change { id:string; client_id:string; occurred_at:string; timezone:string; status:string; type:string; page_ids:string[]; group_id:string|null; sitewide:number; summary:string; rationale:string; author_id:string; author_name:string; author_kind:string; source:string; expected_metric:string; evidence:string[]; tags:string[] }
export interface Metric { property_id:string; page_id:string; date:string; metric:string; value:number; source:string; data_state:'final'|'fresh' }
