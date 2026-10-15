# SEO Notebook: Product Scope (scope only, no build)

Prepared 2026-10-14 (ET) for Evan. Every number below has a source link. Items marked **[ASSUMPTION]** are design choices or estimates that aren't backed by a source.

## 1. One-liner and positioning gap

**SEO Notebook** is an open-source, agent-native change log for SEO and CRO work. People, bots and AI agents record every change they make (date, URL, what changed, why, who). The tool joins each change to GSC, GA4 and other metrics, and shows before/after impact windows on an annotation timeline that clients can see.

**The gap:**
- **GSC custom annotations** (launched Nov 17, 2025) are limited: 120 characters each, 200 per property, deleted after 500 days, no editing, and they don't appear in comparison mode ([Help](https://support.google.com/webmasters/answer/16530728?hl=en), [Blog](https://developers.google.com/search/blog/2025/11/custom-chart-annotations)). The documented API has no annotation endpoint, so bots can't write to it ([HitMind analysis, inference from the API surface](https://hitmind.ai/blog/2026/10/13/automate-search-console-annotations-for-deployments/)). Future dates aren't allowed ([SERoundtable](https://www.seroundtable.com/google-search-console-annotations-future-dates-40461.html)).
- **GA4 annotations** have a 60-character title, a 150-character description and 1,000 per property ([PPC Land](https://ppc.land/google-analytics-introduces-annotations-feature-to-enhance-data-context/), [Help](https://support.google.com/analytics/answer/15884203?hl=en)). They can be created through the Admin API, but they're notes, not impact measurement.
- **SEOTesting.com** is the closest direct competitor (GSC-based tests plus a change log). It's closed SaaS priced per site, has no self-hosting, and has no agent/MCP-first logging.
- **SearchPilot** does real split testing for enterprise, at $37,500+/yr.
- **Semrush Notes** live inside a $117–$500/mo suite.
- **open-seo** shows the model works (MIT license, MCP, Cloudflare self-host, $10/mo hosted), but it does keyword/rank research, not change-impact logging.

**Our position:** an MIT-licensed system of record for changes that agents write to by default (MCP + REST). It covers multiple clients, has no per-site pricing, and gives a before/after readout per change. It can mirror entries into GA4 annotations through the API, but it can't do that for GSC.

## 2. Reference model: open-seo (github.com/every-app/open-seo)
Sources: [README](https://github.com/every-app/open-seo), [LICENSE](https://raw.githubusercontent.com/every-app/open-seo/main/LICENSE), [pricing](https://openseo.so/pricing)
- License: **MIT** (© 2026 Ben Senescu). TypeScript. About 23.6K GitHub stars (GitHub API, read 2026-10-14).
- Self-hosting: Docker for local/testing use, and **Cloudflare is the recommended** path ("works on the free plan").
- Hosted plan: **$10/mo**, which includes $10 of usage credits. Top-ups never expire. The free trial includes $0.50 of credit. GSC data is free and doesn't use credits.
- Revenue: the hosted version "charges 28% extra for every request we make to DataForSEO". Self-hosters bring their own DataForSEO key.
- Agent-first: it ships an MCP server and "Agent Skills" for Claude Code, Codex and ChatGPT.
- Lessons to copy: MIT, one-click Cloudflare deploy, BYO API keys, a cheap flat hosted plan plus metered pass-through, MCP and skills as the headline feature.

## 3. Core concepts and data model
**[ASSUMPTION: proposed design]** Tables in D1, raw uploads in R2.

| Entity | Key fields |
|---|---|
| `org` (agency/workspace) | id, name, plan |
| `client` | id, org_id, name, timezone |
| `property` | id, client_id, type (gsc_domain, gsc_url_prefix, ga4, ads, custom), external_id (e.g. `sc-domain:wholesalemedicaldevices.com`), connection_id |
| `page` | id, client_id, url (normalized), canonical, group tags (template, category) |
| `page_group` | named sets of pages (e.g. "all /hcpcs/ pages", "control: blog") |
| `change_entry` | id, client_id, occurred_at (date + tz), status (planned, shipped, reverted), type (new_page, content, title_meta, internal_links, schema, redirect, template, technical, CRO_form, CRO_layout, ppc_landing, external_event), scope (page ids, page group, or sitewide), summary, rationale/hypothesis, author (human user id **or** agent id + model/tool), source (ui, api, mcp, git, import), evidence links (PR, ClickUp task, diff, screenshot in R2), expected metric, tags |
| `metric_series` | property_id, page_id or null, query or null, date, metric (clicks, impressions, ctr, position, sessions, key_events, revenue, custom), value, source, data_state (final or fresh), ingested_at |
| `impact_window` | change_id, pre window (default 28d), post window (default 28d, after a lag buffer), comparison method, control group id, computed deltas, confidence label, overlapping change ids |
| `connection` | provider, auth type (oauth, service_account, api_key), encrypted secret ref, scopes, owner user |
| `report` | client_id, period, selected changes, share token, rendered snapshot in R2 |

Example: WMD `/wholesale-medical-braces/` → change_entry{type:new_page, author:"Mustafa (agent)", rationale:"GSC 'wholesale medical braces' queries landing on homepage; Orthopedic ads LP", expected:"non-brand B2B clicks + distributor form submits"}.

## 4. Agent API and MCP server
- **REST API** (Workers): `POST /v1/changes`, `PATCH /v1/changes/:id` (e.g. planned → shipped, or revert), `GET /v1/changes?client=&url=&since=`, `GET /v1/impact/:change_id`, `POST /v1/metrics/import` (CSV/JSON), plus webhooks out.
- Auth uses per-org API keys and per-agent tokens with scopes (write:changes, read:metrics). Each token is tagged with the agent identity, so the "who" field can't be faked. **[ASSUMPTION]**
- **MCP server** (remote Streamable HTTP served from the same Worker, and also local stdio for self-host). Tools:
  - `log_change`, `update_change`, `list_changes`
  - `get_impact`, `get_page_timeline`
  - `find_overlapping_changes`
  - `suggest_control_pages`
  - `create_report_draft`
- **Agent skills / prompts:** "log every shipped change" and "pre-flight: check overlapping changes on this URL before you edit".
- **Auto-capture integrations** (phase 2):
  - GitHub/GitLab deploy webhooks
  - WordPress plugin (post updated, Yoast/RankMath title changed)
  - ClickUp/Jira task moved to Done
  - Google Ads change history
  - Screaming Frog crawl diffs
- **Idempotency** keys on `log_change`, so retrying agents don't create duplicates. **[ASSUMPTION]**

## 5. Data connectors and auth
| Connector | Auth | Scope | Quotas / delays |
|---|---|---|---|
| GSC Search Analytics | OAuth (user) or service account added as a user on the property **[ASSUMPTION: SA must be granted in GSC like any user]** | `webmasters.readonly` ([docs](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)) | 1,200 queries/min per site and per user; 30M/day and 40K/min per project; separate load quotas, where page+query grouping and long date ranges cost the most ([limits](https://developers.google.com/webmaster-tools/limits)). Data is typically 2–3 days behind. Use `dataState=all` plus `first_incomplete_date`, and re-import the last ~7 days because Google revises them ([docs](https://developers.google.com/webmaster-tools/v1/searchanalytics/query), [SiteLine](https://siteline.tools/guides/search-console-16-month-limit)). History is about 16 months, so **ingest daily from day one to keep data past 16 months**. |
| GA4 Data API | OAuth or service account (added to the property) | `analytics.readonly` | Standard property: 200,000 core tokens/day, 40,000/hour, 14,000 per project per property per hour, 10 concurrent requests. Daily quotas reset at midnight PT ([quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas)). |
| GA4 Admin API (optional write) | OAuth | edit scope | Mirrors change entries as GA4 annotations (the Admin API supports creating them, per the [Help](https://support.google.com/analytics/answer/15884203?hl=en)). 1,000 per property, and creating them needs Analyst+ permissions. |
| DataForSEO (pluggable) | API key (BYO) | n/a | Pay as you go, $50 minimum top-up, balance never expires; SERP from $0.0006/SERP ([pricing](https://dataforseo.com/pricing)). Used for rank snapshots per changed URL/keyword. |
| Google Ads (phase 2) | OAuth + developer token | | Landing-page and search-term reports for CRO/PPC changes. |
| Manual / CSV upload | n/a | | GSC/Ads exports (like the WMD files), CRM leads, or hand-entered values. Raw files go to R2, and parsing runs in a Queue consumer. |

**OAuth realities:**
- `webmasters.readonly` is a *sensitive* scope. Sensitive-scope verification usually takes 3–5 business days ([Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)).
- A consent screen left in **Testing** mode expires refresh tokens (7 days, per [MakinForU docs](https://panel.makinforu.com/docs/self-hosting/google-search-console)). Self-hosters must publish the app, or choose "Internal" if everyone is on one Workspace.
- The hosted version needs a verified Google app for sensitive scopes. GSC and GA4 read scopes aren't *restricted*, so no security assessment is needed ([scope tiers](https://developers.google.com/workspace/guides/configure-oauth-consent)).
- Service accounts are the cleaner option for agencies. No consent screen or verification is needed **[ASSUMPTION]**. The cost is that the client has to add the SA email to each property.

## 6. Impact measurement method
Default readout per change **[ASSUMPTION: method design]**:
1. **Windows:** pre = N days before; post = N days after a *lag buffer*. Defaults are N=28 (whole weeks, so day-of-week effects cancel) and a buffer of 3 days for GSC data lag, plus a crawl/index delay for new pages. Users can override both.
2. **Metrics:** clicks, impressions, CTR and avg position (GSC page, or page+query); sessions and key events (GA4); and the Ads conversions the user chose (e.g. WMD distributor form).
3. **Comparison:**
   - (a) a plain before/after delta;
   - (b) a **diff-in-diff vs. a control group**: similar pages left unchanged, or the rest of the site;
   - (c) optional YoY for seasonal businesses (only possible once there's more than 12 months of history);
   - (d) phase 3: a causal-impact / Bayesian structural time-series model.
4. **Confidence label** (not a p-value claim): Strong, Directional or Inconclusive, based on volume thresholds, control agreement and overlaps.

**Caveats the UI must show:**
- **Seasonality and trend:** use whole-week windows plus a control group or YoY. KEES (Outer Banks rentals) is heavily seasonal **[ASSUMPTION]**.
- **Overlapping changes:** list other changes in the same window on the same URL, page group or sitewide, and lower confidence when they exist. Google core updates and external events go in as `external_event` entries (Semrush auto-adds Google updates the same way: [Semrush Notes](https://www.semrush.com/kb/480-notes)).
- **GSC lag and revisions:** recent days are incomplete, so never score a window until it is final.
- **GSC privacy filtering:** anonymized queries are missing from query-level data ([CrawlRaven](https://crawlraven.com/blog/google-search-console-api)), so page totals won't equal the sum of queries.
- **New pages have no "before":** measure them against the URLs or queries they're meant to take over (e.g. homepage clicks for "wholesale medical braces").
- **Attribution:** organic changes vs. paid. Ads budget changes (like WMD's ~66% spend drop) affect GA4 conversions, so channel-filter GA4 and log Ads changes as entries.
- **Small numbers:** low-traffic B2B pages (WMD has 261 total GSC clicks since Apr 2026, per Mustafa's data) will mostly be "Inconclusive", and the UI should say so.

## 7. Client reports
- Monthly/period report: a timeline of shipped changes, each with a before/after card (chart, deltas, confidence, rationale), wins, items still pending measurement, and the planned next changes.
- Delivery: a white-label shareable link (read-only token), a PDF snapshot in R2, CSV export, and an emailed digest (phase 2).
- Agency view: the change log across all clients ("what did our agents do this week").

## 8. Competitors and existing tools (sourced prices)
| Tool | What it does | Price | Source |
|---|---|---|---|
| SEOTesting.com | GSC-based SEO tests, change tracking | $50/mo (1 site), $125/mo (5 sites), $375/mo (20 sites), Enterprise on request; unlimited users; 14-day trial | https://seotesting.com/pricing/ |
| GSC custom annotations | Notes on Performance charts | Free; 120 chars, 200/property, 500-day expiry, no API | https://support.google.com/webmasters/answer/16530728?hl=en |
| GA4 annotations | Notes on line graphs | Free; 1,000/property; Admin API | https://support.google.com/analytics/answer/15884203?hl=en |
| SearchPilot | Enterprise server-side SEO split testing | From $37,500/yr (non-transactional sites); others on request | https://www.searchpilot.com/pricing |
| Semrush Notes | Notes in Position Tracking, Site Audit, etc. | SEO Toolkit Pro $139.95/mo, Guru $249.95/mo, Business $499.95/mo (annual $117.33 / $208.33 / $416.66) | https://www.semrush.com/kb/1624-semrush-one-vs-seo-toolkit, https://www.semrush.com/kb/480-notes |
| Ahrefs | Suite. **I couldn't find a documented user-annotation feature (not verified)** | Starter $29, Lite $129, Standard $249, Advanced $449, Enterprise from $1,499/mo | https://ahrefs.com/blog/ahrefs-pricing/, https://ahrefs.com/pricing |
| OpenSEO | OSS research suite (model, not a direct competitor) | $10/mo hosted incl. $10 usage; MIT | https://openseo.so/pricing |
| DataForSEO | Data provider (connector) | PAYG, $50 minimum top-up | https://dataforseo.com/pricing |

Not researched yet: GA Annotations-style SaaS tools (gaannotations.com/pricing returned 404), Looker Studio templates, SearchAtlas, SEOClarity. Check these before launch.

## 9. Business model and license
- **License: MIT**, matching open-seo, for maximum adoption and to make agent/tool vendors comfortable embedding it.
  - Alternative: **AGPL-3.0** core plus a commercial hosted license, which stops a competitor from rehosting the code as closed SaaS. **Recommendation: MIT** **[ASSUMPTION / judgment]**. The moat is the hosted convenience: a verified Google OAuth app, managed ingestion, report hosting and history kept past 16 months.
- **Hosted pricing** **[ASSUMPTION: proposal; benchmark is OpenSEO's $10/mo vs. SEOTesting's $50/site]**:
  - Free self-host
  - Hosted Solo $10/mo (a few properties)
  - Agency ~$29–49/mo (unlimited clients and users, white-label reports)
  - Connector pass-through (DataForSEO) at cost plus a markup, the same model as OpenSEO's 28%
- **Unit cost check:** the Workers Paid minimum is $5/mo/account. D1 includes 25B rows read and 50M rows written per month, plus 5 GB of storage, then $0.75/GB-mo ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). Small tenants should cost cents.

## 10. Cloudflare-first: fit and limits
| Service | Use | Relevant limits (source: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/)) |
|---|---|---|
| Workers | UI (SSR/static), REST API, remote MCP | Free: 10 ms CPU/request, 100K requests/day, 50 subrequests. Paid: up to 5 min CPU (default 30 s), 10,000 subrequests, 128 MB memory |
| Cron Triggers | Daily GSC/GA4 sync fan-out | Free: 5 per account. Paid: 250. Cron CPU on Paid: 30 s (<1 h interval) or 15 min (≥1 h); wall time 15 min |
| Queues | One message per property-day sync, CSV parsing, impact recompute | 128 KB messages, batches of 100, 15 min consumer wall time, retention up to 14 days (Free: 24 h). Paid: 1M operations/mo included, then $0.40/M |
| D1 | Relational data + metric series | **10 GB max per DB (can't be increased)**, 500 MB on Free; 2 MB max row; 100 bound params per query; 30 s max query; single-threaded per DB. Designed for **per-tenant databases** (50,000 DBs/account on Paid) |
| R2 | Uploads, report PDFs, raw API dumps | 10 GB-mo free, then $0.015/GB-mo, no egress fees |
| Workers secrets / KV | App OAuth client secret | Env vars: 5 KB each, 128 per Worker (Paid) |

**Limitations and mitigations:**
- **OAuth token storage:** per-tenant refresh tokens can't be Worker secrets (those are deploy-time, max 128). Store them **encrypted in D1** with AES-GCM via WebCrypto, using a master key held as a Worker secret. Optionally use one Durable Object per connection to serialize token refreshes. **[ASSUMPTION: design]**
- **Free-plan CPU (10 ms) and 50 subrequests** are too tight for GSC backfills and stats. Self-hosters with real data will need **Workers Paid ($5/mo)**. Document this clearly (open-seo says its app works on the free plan, but our ingestion is heavier).
- **D1 10 GB per DB:** page×query×date rows grow fast. Use a **D1 database per client**, store page-level daily aggregates by default, and keep query-level data only for pages with changes plus the top N queries; roll raw data into R2 as Parquet/CSV. **[ASSUMPTION]**
- **Heavy stats (causal impact)** may outgrow Worker CPU and memory. Use phase-3 Cloudflare Containers or an external job runner.
- **No blocker found** that rules out Cloudflare-first. A Docker/Node + SQLite/Postgres path should exist for people who want to self-host off Cloudflare (open-seo does this too).

## 11. Stack
**[ASSUMPTION: proposal, mirroring open-seo's TypeScript/Cloudflare approach]**
- TypeScript monorepo:
  - `apps/web`: React + TanStack Start or Remix on Workers
  - `apps/api`: Hono on Workers, REST + remote MCP via `@modelcontextprotocol/sdk`
  - `packages/connectors`: gsc, ga4, dataforseo, csv, plugin interface
  - `packages/impact`: windowing, diff-in-diff, confidence
  - `packages/mcp`: stdio build for local agents
- Drizzle ORM on D1/SQLite (portable to Postgres for the Docker build).
- Auth: better-auth or Lucia-style sessions, plus Google OAuth.
- Charts: ECharts or Recharts for the annotation timeline.
- One-click "Deploy to Cloudflare" button plus `wrangler` scripts.

## 12. MVP (Phase 1, aim: usable on WMD + KEES)
1. Orgs, clients, properties and pages; an invite-only multi-user workspace.
2. Change log: create, edit or revert entries; types; author = human or agent; evidence links; planned vs. shipped; a CSV import of past changes.
3. Connectors: GSC (OAuth + service account), daily sync with a 7-day re-import, and a backfill of the last 16 months. GA4 sessions and key events by landing page. CSV upload for anything else.
4. Annotation timeline per client, property and page, with change markers on GSC/GA4 charts.
5. A before/after impact card per change (28/28 days with a 3-day buffer), with an optional control group and an overlap warning.
6. REST API plus an MCP server (`log_change`, `list_changes`, `get_impact`), with per-agent tokens.
7. A shareable read-only client report link plus CSV export.
8. Self-host docs (Cloudflare and Docker) and an MIT repo.

Out of MVP: Ads connector, DataForSEO, GA4 annotation write-back, PDF reports, auto-capture integrations, causal-impact model, billing.

## 13. Phases
- **P0 (design):** schema, impact method spec, Google OAuth app setup (start sensitive-scope verification early; it typically takes 3–5 business days).
- **P1 (MVP):** above. Dogfood with Mustafa's agents logging WMD and KEES changes (e.g. the 301 redirect map, `/wholesale-medical-braces/`, the `/distributors/` mobile first screen).
- **P2:** hosted beta plus billing; DataForSEO and Google Ads connectors; GA4 annotation sync; auto-capture (GitHub, WordPress, ClickUp); PDF/email reports; agency multi-client dashboard.
- **P3:** causal-impact modeling, page-group split tests (SEOTesting/SearchPilot-lite), LLM-written report narratives, a marketplace for third-party connectors.

## 14. Risks
1. **Google OAuth verification and token churn** for the hosted app (sensitive scope; Testing-mode tokens expire after 7 days). Self-hosters get stuck. *Mitigation:* service-account path, clear docs.
2. **Over-claiming causality:** clients read deltas as proof. *Mitigation:* confidence labels, controls, overlap warnings, wording guardrails.
3. **Low-traffic sites** produce mostly inconclusive results, which weakens the value. *Mitigation:* aggregate by page group, measure leads/conversions, and use a longer default window.
4. **Agents logging inconsistently** (garbage in). *Mitigation:* MCP tools with a required schema, idempotency, a "log before ship" skill, and auto-capture.
5. **D1 10 GB per DB / Free-plan CPU limits.** *Mitigation:* per-tenant DBs, aggregation, R2 archive, Paid plan.
6. **Competition:** SEOTesting adds an MCP, or Google adds an annotation API or longer GSC retention. *Mitigation:* the moat is multi-source, agent-native, open source and cheap.
7. **MIT lets others rehost.** This is accepted (it's the open-seo model). The hosted value is the verified OAuth app and the managed history.
8. **Client data privacy:** GSC notes count as business data, and Google warns against PII ([Help](https://support.google.com/webmasters/answer/16530728?hl=en)). *Mitigation:* encrypted tokens, per-tenant DBs, no PII in entries.
9. **Scope creep** into a full SEO suite. Keep it the "change log + impact" product and integrate open-seo/DataForSEO rather than rebuilding them.
