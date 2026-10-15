# SEO Notebook — Phase 1 build report

Built on October 15, 2026. The project is implemented in this directory, with fictional data only. Nothing was deployed, no Cloudflare resources were created, and no Google, DataForSEO or other live connector API was called. No real credentials were used.

## Delivered

- MIT-licensed TypeScript Cloudflare Worker with Hono REST, Drizzle/D1 queries, SQL migrations, Worker assets, Cron, Queue producers/consumer and R2 upload storage.
- Invite-only workspace: seeded org/admin, expiring one-time invites, PBKDF2 passwords, cookie sessions, admin/editor roles and org isolation.
- Clients, GSC/GA4/custom properties, normalized pages and named page groups. Mock OAuth/service-account connection metadata.
- Change log with date/timezone, verified human or agent author, type, hypothesis, status, expected metric, tags, evidence and page/group/sitewide scopes. Create, edit, ship and revert, with idempotent agent writes.
- GSC and GA4 landing-page connector interfaces and deterministic fixtures, seven-day revision sync and sixteen-month backfill, one queued job per property-day, idempotent daily metric upserts.
- Raw CSV/JSON metric uploads and CSV change-history imports through R2 + Queue; import progress/error endpoint, validation and retry protection.
- Browser workspace with client/property/page filters, daily SVG chart and change annotations, change editor, import dialog, impact panel and admin tools.
- Tested 28-day before/after comparison with three excluded days after the change, optional controls, normalized difference-in-differences, weighted CTR/position, completeness/finality gates, confidence labels, overlap warnings and attribution caveats.
- REST plus official-SDK remote Streamable HTTP MCP (`log_change`, `list_changes`, `get_impact`) and a local stdio bridge. Per-agent hashed tokens, scopes, revocation and server-owned author identity.
- Revocable read-only report links with period changes, per-change chart/readout and spreadsheet-safe CSV export.
- Fictional Cedar & Finch fixtures, `.env.example`, self-host instructions, API reference and agent workflow guidance.

## Run

Use Node **22.14 or newer**:

```sh
npm ci
cp .env.example .dev.vars
npm run setup
npm run dev
```

Open `http://localhost:8787`. Demo login: `alex@cedar.example` / `notebook-demo-only`. Demo read-only report: `/reports/demo-read-only-report`. These are explicitly public local fixtures.

Run `npm run check` for TypeScript and all tests. Run `npm run test:integration` for direct Worker/SQLite tests. See README for REST/MCP examples, fixture sync/backfill, import formats and production preparation.

## Validation results

| Check | Result |
|---|---|
| TypeScript `tsc --noEmit` | Passed |
| Vitest | **38 passed**, 3 files |
| Worker + real SQLite integration | **17 passed**, included above |
| Browser JavaScript syntax | Passed (`node --check`) |
| Worker esbuild bundle | Passed, ESM bundle generated to `/tmp` only |
| Local Wrangler bindings/config | Wrangler identified DB, Queue, R2, assets and vars |
| `wrangler d1 migrations apply DB --local` | Blocked by sandbox `listen EPERM: 127.0.0.1` |
| `wrangler dev --local --test-scheduled` | Blocked by sandbox `uv_interface_addresses` permission error |
| Browser/real workerd smoke test | Not run: local listening sockets unavailable |

Integration tests execute the actual Hono handlers and official MCP transport with the real migration and seed SQL in SQLite. A D1-shaped test adapter supplies SQL execution/transaction semantics; Queue and R2 are in-memory test adapters. These tests cover auth, permissions, cross-org isolation, author forgery, idempotency/conflicts, edits/reverts, impact finality, overlaps, controls, imports/retries/errors, seven-day and sixteen-month jobs, invitations, entity creation, report export/revocation and MCP initialize/list/call. They do not certify workerd-specific binding behavior or browser interaction.

Dependency installation initially failed on sandbox DNS. Installation succeeded offline from the preexisting npm cache with install scripts disabled. Node 22 and the available esbuild binary were then used successfully for verification. The committed lockfile pins the dependency graph; normal self-hosting uses `npm ci`.

## Mocked and intentionally bounded

- Both connectors generate synthetic daily metrics. OAuth/service-account options are interface/configuration fixtures, not functioning authentication flows. There are no Google credentials, token refreshes or live provider clients.
- GA4 fixture metrics have landing-page granularity; channel attribution must be added with a real connector. GSC fixtures include fresh/final state and revision upserts, not actual privacy filtering.
- New pages have no supported predecessor/query-baseline selector yet; their cards remain inconclusive rather than manufacture a before period. Controls are manually selected page groups, and should be checked for unrelated changes before use.
- Reports are live period views, not frozen R2 snapshots. PDF/email, webhooks, Ads/DataForSEO, GA4 annotation writes, auto-capture, billing and causal inference are not included.
- Per the user's wrangler-only constraint, Docker/off-Cloudflare execution was not implemented. The scope's proposed React/TanStack/chart-library layer is a small browser/SVG frontend here; application/domain/backend code is TypeScript. Drizzle is used for typed entity reads; complex queries use bound SQL.
- One D1 per self-hosted workspace, with org checks; automated per-client database fleet routing is not implemented. No live secrets are stored; encrypted connection-secret storage belongs with live connectors.
- Lists currently cap at 1,000 changes and 20,000 timeline rows. Imports cap at 1 MB / 5,000 rows. Historical import rows retain authenticated importer attribution; a later invalid scope row can leave earlier valid changes recorded. Queue retries do not duplicate them.
- An instance exposed to the internet still needs deployment-specific bootstrap, rate limiting, backup/restore and live auth/security review. Public demo seed data must not be used there. This build includes no deploy/provision scripts.

## Commits

The original `.git` directory is mounted read-only. A normal commit failed because Git could not create `.git/index.lock`. To preserve incremental work without changing that mount, commits were made in an alternate Git directory at `/tmp/seo-notebook-git`, using this workspace as the work tree.

The complete history is delivered as **`seo-notebook-history.bundle`** in this directory (ignored by Git to avoid recursive bundling). Stages:

1. `feat: add Cloudflare scaffold, tenant schema, fixture connectors and impact engine`
2. `feat: implement authenticated REST and MCP, queued ingestion, workspace UI and client reports`
3. `test: verify Worker SQL and MCP flows, fix patch defaults and weighted impact scoring`
4. `docs: finalize self-host guide and Phase 1 build report`

On a machine with writable Git metadata, clone the bundle to recover the fully committed build:

```sh
git clone /path/to/app/seo-notebook-history.bundle seo-notebook-built
cd seo-notebook-built
git log --oneline
```

The original repository HEAD cannot be updated inside this restricted environment. The bundle is the durable commit deliverable; `/tmp` is not required to recover it.

## Next steps

1. Run local Wrangler setup/dev and browser smoke tests on a machine that permits localhost sockets. Verify native D1/R2/Queue/Cron behavior, report links, uploads and stdio MCP.
2. Add live GSC/GA4 adapters only when explicitly authorized, including encrypted credential storage, refresh synchronization, consent/service-account setup and quota/backfill controls.
3. Add predecessor/query baselines for new pages, automatic clean-control checks, query privacy labels and organic channel filtering before interpreting live results.
4. Add pagination, outbox/recovery for interrupted queue enqueueing, dead-letter operations, database backups and per-client D1 routing as volume requires.
5. Complete production bootstrap and security/rate-limit review before private Cloudflare hosting. Deployment and resource creation remain separate, unperformed actions.
