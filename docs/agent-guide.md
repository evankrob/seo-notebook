# Agent workflow

1. Read `/v1/changes?client=...&url=...&since=...` (or `list_changes`) before editing. Check the same page, group and sitewide changes for competing work.
2. Record a planned entry with a concrete hypothesis. Include page IDs (or one group or sitewide scope), date in the client's timezone, expected metric and evidence URLs.
3. After shipping, PATCH the entry to `shipped`. Log reverts as status `reverted`. Never claim a deployment that did not happen.
4. Use a stable `Idempotency-Key` header (MCP: `idempotency_key`) for retries. Different payloads require different keys.
5. Read `get_impact` after both windows are complete. Relay the confidence label and caveats. A before/after movement does not establish causality.

The server supplies the author identity from the authenticated session/token; do not send author fields. MCP provides only Phase 1's `log_change`, `list_changes`, `get_impact`. Use REST for edits. An agent with only `write:changes` can create and update but cannot list or measure; grant `read:metrics` when preflight and measurement are needed.

Every fixture is fictional. Do not put personal information or credentials in changes, tags, URLs or evidence.
