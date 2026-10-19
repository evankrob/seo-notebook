# Agent guide

How an AI agent should use SEO Notebook. Connect through the notebook's **Agents → Connect an agent** screen, which gives you an MCP config with your own bearer token.

## Every time you change a page

Call `log_change` right after the change, in the same task:

- `url` (or `urls`): the page(s) you changed. You do not need IDs; the site and pages are created from the domain. Use `site` plus `sitewide: true` for template, robots or sitewide changes.
- `summary`: what changed, in one line.
- `rationale`: why. State the hypothesis ("titles that lead with the service + city should lift CTR").
- `diff`: the old and new value of every field you edited, e.g. `{"field": "title", "before": "Brow Wax", "after": "Brow Wax in Springfield | Bright Wax"}`. Fields: `title`, `meta_description`, `h1`, `headings`, `content`, `canonical`, `robots`, `schema`, `redirect`, `internal_links`, `images`, `url`, `other`. For long content, send a representative excerpt (max 5,000 characters per value).
- `evidence`: links such as the PR or commit, if there is one.
- `idempotency_key`: a stable key for this change (e.g. `site-page-field-date`). Reuse it on retries; never reuse it for a different change.

Leave out `occurred_at`, `type` and `status` unless you know better: they default to today, a type inferred from `diff`, and `shipped`.

## Planned work

If the change is not live yet (a PR awaiting review, a scheduled deploy), log it with `status: "planned"`. When it ships, call `update_change` with `status: "shipped"` (and `occurred_at` if it went live on a different day). If it is rolled back, set `status: "reverted"`. Never mark something shipped that did not ship.

## Before you edit

Call `list_changes` with the page `url` (or `site`) to see recent work on the same page. Changes close together overlap, and overlapping changes make impact readouts inconclusive, so mention recent changes to the user before stacking another one on the same page.

## Reading impact

`get_impact` compares 28 days before a change with 28 days after it, skipping the 3 days after. It stays inconclusive until both windows have complete, final data, which takes about a month after a change. When you report results, include the confidence label and the caveats: a before/after difference is not proof that the change caused it.

## Rules

- Your identity comes from your token; never send author fields.
- Do not put credentials, personal data or customer information in summaries, diffs, tags or evidence.
