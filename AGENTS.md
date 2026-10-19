# AGENTS.md — SEO Notebook

Self-hosted Cloudflare Worker (Hono + D1 + Queues + R2): AI agents log SEO changes over MCP by URL (with old → new values), and the notebook scores their impact from GSC/GA4 metrics. Small vanilla-JS UI behind Cloudflare Access.

## Commands (Node >= 22; `node:sqlite` is required by tests)
- `npm ci` · `npm run setup` (local D1 migrate + seed) · `npm run dev` (http://localhost:8787)
- `npm run check` = typecheck + lint (oxlint) + tests. **Run it before every commit; it is what CI runs.**

## Map
- `apps/api/src/index.ts` HTTP routes (Hono). `auth.ts` Cloudflare Access JWT verification, local mode, agent bearer tokens. `service.ts` change log, URL → site/page resolution (`ensureSite`), scopes, `HttpError`, zod schemas. `jobs.ts` queued imports/ingestion. `redirects.ts` follows redirects (public http(s) only) so new pages store the URL Google reports. `mcp.ts` MCP server. `types.ts` Env/Actor/Change.
- `packages/impact` pure impact/window math. `packages/connectors` fixture GSC/GA4, live Google client (`google.ts`), CSV parser.
- `apps/web/app.js` browser UI. `migrations/` D1 schema. `fixtures/seed.sql` demo data (never for public instances).
- Tests: `tests/impact.test.ts`, `tests/connectors.test.ts`, `tests/google.test.ts`, `tests/worker.test.ts` (real handlers + real migrations on SQLite via a D1-shaped adapter).

## Invariants (do not break)
1. **Tenant isolation:** every query touching client data joins/filters on `org_id` of the actor. Load clients through `client(env, actor, id)`; never `SELECT ... WHERE id=?` alone.
2. **Authz:** call `scope(actor, ...)` / `admin(actor)` at the top of every handler. Agents never set author fields; the actor does.
3. **Validate input with zod** (`.strict()` for writes). Never pass `c.req.json()` straight to SQL.
4. Writes accept `Idempotency-Key`; retries must not duplicate rows (including queue retries).
5. Dates are `YYYY-MM-DD` via the shared `date` schema. JSON columns (`page_ids`, `evidence`, `tags`, `diff`, `scopes`) are encoded/decoded in one place (`decode`).
6. Only bound SQL parameters; no string-built SQL. Schema changes = new migration file, never edit an applied one.
7. Google access is read-only through the service account in the `GOOGLE_SERVICE_ACCOUNT` Worker secret (`packages/connectors/google.ts`). Never store Google credentials in D1 or code, and don't add OAuth or new Google scopes without explicit approval. Tests mock `fetch`; they never call Google.
8. **Auth:** humans are identified only by a verified Access JWT, or by loopback requests in local mode (Access vars unset). Never trust `Cf-Access-Authenticated-User-Email` or other unverified headers. `/mcp` accepts agent bearer tokens only.
9. Agent-facing inputs take URLs, not IDs. Auto-created sites and pages always belong to the actor's org.

## Verify
`npm run check`. For route changes, add a case to `tests/worker.test.ts` covering the happy path **and** a cross-org request that must 404.

## Don'ts
- No new `any` (lint warns; prefer typed row interfaces). No `@ts-ignore`.
- Don't add more 200+ char one-liners; format new code normally.
- Never commit `.dev.vars`, `.env*`, `wrangler.production.toml`, tokens, or `*.bundle`. Don't deploy or create Cloudflare resources.
