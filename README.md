# SEO Notebook

An MIT-licensed, agent-native SEO and CRO change log. Record who changed what and why, annotate a metrics timeline, and share a cautious before/after readout with a client. Inspired by open-seo's TypeScript, Cloudflare self-hosting and agent-first model.

**Phase 1 is local and fixture-backed.** No Google, DataForSEO, OAuth or other provider requests are implemented. Nothing in setup creates Cloudflare resources or deploys a Worker. Demo data belongs to fictional **Cedar & Finch Supply** at `cedar.example`.

## Run locally

Requires **Node 22.14+** and npm. All application development runs in Wrangler, with local D1, R2 and Queues emulation; no separate Vite, Node or Docker server.

```sh
npm ci
cp .env.example .dev.vars
npm run setup
npm run dev
```

Open `http://localhost:8787`. Sign in as `alex@cedar.example` with `notebook-demo-only`. Both are public local fixtures, not real credentials. A second person joins through an admin-created invitation; there is no public registration. Share invite tokens yourself; the app sends no email.

Demo report: `http://localhost:8787/reports/demo-read-only-report`. Its token grants only report reading and CSV export. Create and revoke report links through the authenticated API. New report and agent tokens are randomly generated and stored only as SHA-256 hashes.

```sh
npm run check             # TypeScript + all tests
npm run test:integration  # direct Worker + SQLite tests; no listening socket
npm run seed:generate    # regenerate deterministic fixtures/seed.sql
```

`npm run setup` applies local migrations and inserts fixtures without replacing existing rows. Wrangler persists data in `.wrangler/state`. For a clean local demo, stop Wrangler, remove `.wrangler/state`, and rerun setup. Do not remove that directory if you need your local entries.

The demo's historical metrics cover August 1–October 14, 2026. A September title change has measurable lift, two form changes overlap, another change is planned, and one is reverted. The last three seeded days are fresh. Queue a seven-day sync or sixteen-month backfill using Workspace tools to generate additional daily fixtures. Scheduled sync runs at `0 7 * * *` (UTC); during local dev trigger it explicitly:

```sh
curl 'http://localhost:8787/__scheduled?cron=0+7+*+*+*'
```

Queue jobs are one property-day each; daily sync revisits the previous seven days and marks the latest three days fresh. Backfill starts sixteen calendar months before today. Reprocessing upserts the same property/page/date/metric key. Local Queue delivery is asynchronous; inspect the timeline again after processing.

## Workspace and reports

The workspace supports clients, mock properties (GSC domain/prefix, GA4, custom), normalized pages, named page groups, and changes scoped to pages, one group or the entire client site. Add evidence links, rationale, types and expected metrics; edit, plan, ship or revert entries. Agent identity comes from the token, never a supplied author field.

Filter daily metrics and timeline markers by client, property and page. Select a change for its impact card and optional control group. Controls must exclude treatment pages. Create a read-only report for a client and date period; it includes shipped, planned and reverted work, per-change charts, impact notes, and CSV export. Reports reflect current data, not frozen snapshots. Revocation invalidates the share token.

Only workspace admins create clients, pages, properties, groups, invitations, reports and agent tokens. Editors can log/edit changes and import data. Agent capabilities are restricted to `write:changes` and `read:metrics`; they cannot administer a workspace. Sessions are HttpOnly, SameSite=Strict, valid for 24 hours, and Secure on HTTPS. Cookie-authenticated mutations require `Origin` to equal `APP_ORIGIN`. Passwords use PBKDF2-SHA256 with per-user salt and 100,000 iterations. There is no live OAuth or credential storage in this mock build.

## REST API

All `/v1` routes require a session or `Authorization: Bearer <agent-token>`. The demo bearer token is `demo-agent-token-not-a-secret`. Never use demo fixtures on a publicly accessible instance. JSON errors use `{ "error": "..." }`. Change lists are capped at 1,000 entries; timeline metrics at 20,000 rows.

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/v1/clients` | List / create clients |
| GET | `/v1/clients/:id/context` | Client properties, pages and groups |
| POST | `/v1/pages`, `/v1/groups`, `/v1/properties` | Create client entities |
| POST | `/v1/properties/:id/sync?backfill=true` | Queue mock backfill; omit flag for seven-day refresh |
| POST | `/v1/changes` | Create; optional `Idempotency-Key` header |
| PATCH | `/v1/changes/:id` | Edit, ship or revert; creator identity preserved |
| GET | `/v1/changes?client=&url=&since=&until=` | List/filter entries |
| GET | `/v1/impact/:id?control=&property=&metric=&days=28&lag=3` | Before/after readout |
| GET | `/v1/timeline?client=&property=&page=&metric=&since=` | Daily series and scoped markers |
| POST | `/v1/metrics/import?client=...` | Raw CSV or JSON array → R2 + Queue |
| POST | `/v1/changes/import?client=...` | Past changes CSV → R2 + Queue |
| GET | `/v1/imports/:id` | Status, error and imported row count |
| POST | `/v1/reports` | `{client_id,title,since,until}` → one-time share URL |
| DELETE | `/v1/reports/:id` | Revoke report |
| POST | `/v1/invites` | `{email,role?}` → seven-day one-time invite token |
| POST | `/v1/agents` | `{name,model?,scopes}` → one-time bearer token + ID |
| DELETE | `/v1/agents/:id` | Revoke agent token |
| GET | `/v1/me` | Authenticated identity |
| POST | `/v1/logout` | End session |

`POST /auth/login` accepts `{email,pass}` and is throttled per 15-minute window: 10 attempts per email and 50 failed attempts per client IP, answered with `429` and `Retry-After`; `POST /auth/accept` accepts `{token,name,password}` (minimum 12 characters). No signup endpoint exists. Public report endpoints are GET-only: `/reports/:token` (HTML), `/public/reports/:token` (JSON), `/public/reports/:token/export.csv`.

Example agent log:

```sh
curl http://localhost:8787/v1/changes \
  -H 'Authorization: Bearer demo-agent-token-not-a-secret' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: cedar-title-2026-10-15' \
  --data '{"client_id":"cedar","occurred_at":"2026-10-15","timezone":"America/New_York","status":"shipped","type":"title_meta","page_ids":["garden"],"summary":"Clarified the title","rationale":"Improve qualified clicks","expected_metric":"clicks","evidence":[]}'
```

Exactly one scope must be provided: nonempty `page_ids`, `group_id`, or `sitewide: true`. Date is `YYYY-MM-DD`, with a separate IANA timezone. Daily provider dates are treated as calendar dates in the property/client reporting timezone. URLs accept HTTP(S), remove query strings/fragments, retain path case and trailing slashes; canonical is stored separately. All entity relationships are checked against the authorized client/org.

## MCP

Remote Streamable HTTP is served from the same Worker at **`/mcp`**, using the official MCP SDK, stateless per-request transport and JSON responses. Supply a unique bearer token per agent. Supported tools:

- `log_change`: the REST change schema plus optional `idempotency_key`.
- `list_changes`: optional `client`, `url`, `since`.
- `get_impact`: `change_id`, optional `control`, `property`, `metric`, `days`, `lag`.

MCP initializes normally and supports `tools/list` and `tools/call`. For clients requiring stdio, run the bridge while Wrangler is running:

```sh
NOTEBOOK_URL=http://localhost:8787 \
NOTEBOOK_TOKEN=demo-agent-token-not-a-secret npm run mcp:stdio
```

The stdio process is only an MCP-to-local-REST bridge; Wrangler remains the application runtime. The bridge rejects non-loopback URLs. Give your agents the workflow in [docs/agent-guide.md](docs/agent-guide.md).

## CSV / JSON import

Send the raw CSV as `Content-Type: text/csv`, not multipart. The browser upload form does this for you. Maximum 1 MB and 5,000 rows; quoted commas, quotes, CRLF and multiline cells are supported. Parsing happens in the Queue consumer, after R2 storage. Failed jobs retain an error for inspection and Queue retries. Invalid metric files are fully validated before any rows are written; historical change imports are idempotent per row and may retain valid earlier rows if a later row fails client/scope checks. Reuploading creates a new import, while Queue retries reuse the original job.

[fixtures/metrics.csv](fixtures/metrics.csv): `property_id,page_id,date,metric,value,data_state`. `data_state` defaults to `final` when omitted; values must be finite and nonnegative. A JSON array of equivalent records is also accepted at the metrics endpoint. Supported metrics: `clicks,impressions,ctr,position,sessions,key_events,revenue,custom`.

[fixtures/changes.csv](fixtures/changes.csv): `occurred_at,timezone,status,type,page_id,summary,rationale`. Use optional `group_id` instead of `page_id`, or `sitewide=true`. Imported entries are attributed to the authenticated importer; historical authors cannot impersonate other agents. Existing records are updated only through PATCH. CSV exports escape formula-leading cells to prevent spreadsheet execution.

## Impact method

For change day **D**, defaults are **D−28 … D−1**, exclude **D and D+1 … D+3**, then **D+4 … D+31**. Override days (7–180) and lag (0–60) using REST/MCP. Any missing treatment page-day, fresh point, future end date, planned/reverted status, or new-page change prevents scoring. Missing dates are never filled with zero. New pages require a future predecessor/query-baseline feature; this MVP explicitly leaves them inconclusive.

Count metrics sum daily values. CTR and position use impression-weighted means; complete final impression coverage is required. Lower position values are better. Plain delta = after − before; percentage = (after / before − 1) × 100, null if baseline is zero. Optional control adjustment = treatment percentage growth − control percentage growth (percentage points); this is a descriptive normalized difference-in-differences, not a fitted causal model.

Confidence is a documented heuristic, **not a p-value**:

- **Inconclusive**: incomplete/ineligible windows; either period under 100 clicks/sessions/key events; other metrics without volume calibration; any overlapping change; or supplied controls with missing data, zero baseline or disagreeing direction.
- **Directional**: complete shipped treatment, both periods ≥100 on a calibrated volume metric, no overlaps, no control.
- **Strong**: the same conditions plus complete controls whose adjusted direction agrees with observed direction.

Overlaps include other shipped or reverted changes dated within either window or the lag interval whose resolved page scope intersects treatment pages, including groups and sitewide/external events. Planned entries are excluded. Controls should also be checked manually for changes; automatic clean-control selection is deferred. The UI warns about seasonality, paid traffic, GSC lag/revisions, query privacy filtering, low volume and lack of causal attribution. GA4 fixtures represent landing-page sessions and key events; real organic channel filtering remains a live-connector task.

## Architecture and self-hosting

- `apps/api`: TypeScript Hono Worker, Drizzle D1 entity query, prepared SQL persistence, auth, REST, MCP, Cron and Queue handlers.
- `apps/web`: dependency-free browser UI and SVG annotation charts, served as Worker assets. The scope's React/chart-library proposal is kept lightweight here; no separate frontend runtime or build server.
- `packages/connectors`: provider interface, deterministic GSC/GA4 fixture implementation and CSV parser.
- `packages/impact`: pure, tested windowing and scoring.
- `packages/mcp`: local stdio bridge.
- `migrations`, `fixtures`, `tests`: SQL schema, fictional data, unit and real-SQL integration tests.

`wrangler.toml` binds D1 `DB`, R2 `UPLOADS`, Queue `JOBS`, assets and one daily Cron. Its database ID is an intentional all-zero placeholder. Wrangler local emulation does not require Cloudflare login. **Do not deploy this demo configuration.** The user-requested build is wrangler-only, so Docker and off-Cloudflare runtimes are intentionally excluded despite the broader scope's future self-hosting proposal.

For eventual private Cloudflare hosting, first provision your own D1/R2/Queue bindings, replace placeholders, set an HTTPS `APP_ORIGIN`, apply migrations to the intended database, and bootstrap a workspace/admin with newly generated password and token hashes. Do not seed public demo credentials or include fixtures on a public instance. Review rate limiting and backup/restore before exposing login. This repository provides configuration and migrations; provisioning/deployment are intentionally not automated or executed. A deployment with real ingestion will need capacity planning (the scope anticipates Workers Paid); no pricing guarantee is made here.

This MVP uses one D1 database per self-hosted workspace with org checks at every API boundary. The scope's per-client D1 fleet, encrypted provider secrets, live OAuth/service-account auth, refresh serialization, raw provider archives and query-level retention are next-stage work. No unencrypted live credential path exists. R2 currently holds raw imports, not report PDFs. Outbound webhooks, PDF/email delivery, Ads, DataForSEO, GA4 annotation writes, auto-capture, causal models and billing are outside this build.

## Build environment notes

The restricted build sandbox disallows listening sockets, so `wrangler dev` and local D1 migration execution could not complete here. Direct Worker tests use real SQLite with D1-shaped adapters and in-memory R2/Queue, and test the official MCP transport. Run `npm run setup && npm run dev` on your normal machine for the final Wrangler/browser smoke check. See [BUILD-REPORT.md](BUILD-REPORT.md) for exact results and remaining limits.

The workspace's original `.git` metadata is read-only. Work was committed incrementally using a separate Git directory and delivered as `seo-notebook-history.bundle`; see the build report to import that history into writable Git metadata.
