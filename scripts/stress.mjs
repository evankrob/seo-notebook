// Local stress/robustness harness. Run against `npm run dev` with demo fixtures only, never production.
// Cross-org checks need a second local org, created with:
//   H=$(printf other-org-agent-token | shasum -a 256 | cut -d' ' -f1)
//   npx wrangler d1 execute DB --local --command "INSERT OR IGNORE INTO org VALUES ('org2','Other','self-host');
//     INSERT OR IGNORE INTO agent_token(id,org_id,name,model,token_hash,scopes) VALUES ('agent2','org2','Other',NULL,'$H','[\"write:changes\",\"read:metrics\"]');
//     INSERT OR IGNORE INTO client VALUES ('c2','org2','Other client','UTC');"
// Usage: node scripts/stress.mjs [baseUrl]
const B = process.argv[2] ?? 'http://localhost:8787';
const AG = { Authorization: 'Bearer demo-agent-token-not-a-secret', 'Content-Type': 'application/json' };
const AG2 = { Authorization: 'Bearer other-org-agent-token', 'Content-Type': 'application/json' };
const out = [];
const log = (name, ok, detail) => { out.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`); };
const req = async (path, opts = {}) => { const t = performance.now(); try { const r = await fetch(B + path, opts); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body, ms: performance.now() - t, headers: r.headers }; } catch (e) { return { status: 0, body: String(e), ms: performance.now() - t }; } };
async function pool(n, conc, fn) { const res = Array.from({ length: n }); let i = 0; await Promise.all(Array.from({ length: conc }, async () => { while (i < n) { const k = i++; res[k] = await fn(k); } })); return res; }
const stats = rs => { const ms = rs.map(r => r.ms).sort((a, b) => a - b); const q = p => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))].toFixed(0); const codes = {}; for (const r of rs) codes[r.status] = (codes[r.status] ?? 0) + 1; return `p50=${q(.5)}ms p95=${q(.95)}ms max=${q(1)}ms codes=${JSON.stringify(codes)}`; };
const change = (o = {}) => ({ client_id: 'cedar', occurred_at: '2026-10-01', timezone: 'America/New_York', status: 'shipped', type: 'content', page_ids: ['garden'], summary: 'stress', rationale: 'stress', expected_metric: 'clicks', evidence: [], ...o });
const post = (path, body, headers = AG) => req(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

// 1. Raw throughput
let rs = await pool(2000, 100, () => req('/health')); log('health x2000 @100', rs.every(r => r.status === 200), stats(rs));
rs = await pool(500, 50, () => req('/')); log('static index x500 @50', rs.every(r => r.status === 200), stats(rs));

// 2. Login (PBKDF2 100k) concurrency + brute force
// Attempts are counted before verification, so >10 simultaneous sign-ins to one account are throttled by design.
rs = await pool(100, 5, () => post('/auth/login', { email: 'alex@cedar.example', pass: 'notebook-demo-only' }, { 'Content-Type': 'application/json' }));
log('login ok x100 @5', rs.every(r => r.status === 200), stats(rs));
rs = await pool(300, 50, k => post('/auth/login', { email: 'victim@cedar.example', pass: 'wrong' + k }, { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.9.9' }));
log('brute-force 300 bad passwords -> throttled (429)', rs.filter(r => r.status === 429).length >= 290, stats(rs));
const knownU = await pool(8, 1, () => post('/auth/login', { email: 'alex@cedar.example', pass: 'x' }, { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.1' }));
await post('/auth/login', { email: 'alex@cedar.example', pass: 'notebook-demo-only' }, { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.1' });
const unknownU = await pool(8, 1, () => post('/auth/login', { email: 'nobody@cedar.example', pass: 'x' }, { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.2' }));
const avg = a => a.reduce((s, r) => s + r.ms, 0) / a.length;
log('login timing does not reveal valid emails', Math.abs(avg(knownU) - avg(unknownU)) < 15, `known=${avg(knownU).toFixed(1)}ms unknown=${avg(unknownU).toFixed(1)}ms`);

// 3. Write load
const run = Date.now();
rs = await pool(500, 50, k => post('/v1/changes', change({ summary: `stress ${run} ${k}` })));
log('create 500 changes @50', rs.every(r => r.status === 201), stats(rs));
const errs = rs.filter(r => r.status !== 201); if (errs.length) console.log('   sample error:', JSON.stringify(errs[0].body).slice(0, 300));

// 4. Idempotency race
const key = 'race-' + run;
rs = await pool(40, 40, () => req('/v1/changes', { method: 'POST', headers: { ...AG, 'Idempotency-Key': key }, body: JSON.stringify(change({ summary: 'race ' + run })) }));
const ids = new Set(rs.filter(r => r.status < 300).map(r => r.body.id));
log('40 concurrent same Idempotency-Key -> 1 row, no 500s', ids.size === 1 && rs.every(r => r.status < 500), `distinct ids=${ids.size} ${stats(rs)}`);
const list = await req(`/v1/changes?client=cedar`, { headers: AG });
const raceRows = Array.isArray(list.body) ? list.body.filter(c => c.summary === 'race ' + run).length : 'n/a';
log('idempotency race rows in DB', raceRows === 1, `rows=${raceRows}`);
rs = await pool(5, 5, () => req('/v1/changes', { method: 'POST', headers: { ...AG, 'Idempotency-Key': key }, body: JSON.stringify(change({ summary: 'different body' })) }));
log('reused key + different body -> 409/422', rs.every(r => r.status === 409 || r.status === 422), stats(rs));

// 5. Read load
rs = await pool(300, 30, () => req('/v1/changes?client=cedar', { headers: AG })); log('list changes x300 @30', rs.every(r => r.status === 200), `${stats(rs)} count=${list.body.length}`);
rs = await pool(200, 20, () => req('/v1/timeline?client=cedar', { headers: AG })); log('timeline x200 @20', rs.every(r => r.status === 200), stats(rs));
rs = await pool(100, 20, () => req('/v1/timeline?client=cedar&page=garden', { headers: AG })); log('timeline page filter x100 @20 (N+1 resolvePages)', rs.every(r => r.status === 200), stats(rs));
rs = await pool(200, 20, () => req('/v1/impact/title-refresh?control=control-guides', { headers: AG })); log('impact x200 @20', rs.every(r => r.status === 200), `${stats(rs)} conf=${rs[0].body.confidence}`);
rs = await pool(50, 10, () => req('/public/reports/demo-read-only-report')); log('public report JSON x50 @10 (unauthenticated)', rs.every(r => r.status === 200), `${stats(rs)} changes=${rs[0].body.changes?.length}`);
rs = await pool(20, 5, () => req('/public/reports/demo-read-only-report/export.csv')); log('public report CSV x20', rs.every(r => r.status === 200), stats(rs));

// 6. Malformed / hostile input
const bad = [
  ['invalid JSON body', post('/v1/changes', '{not json')],
  ['empty body', post('/v1/changes', '')],
  ['array body', post('/v1/changes', '[]')],
  ['wrong types', post('/v1/changes', change({ page_ids: 'garden' }))],
  ['two scopes', post('/v1/changes', change({ sitewide: true }))],
  ['no scope', post('/v1/changes', change({ page_ids: [] }))],
  ['bad date 2026-02-30', post('/v1/changes', change({ occurred_at: '2026-02-30' }))],
  ['bad timezone', post('/v1/changes', change({ timezone: 'Mars/Olympus' }))],
  ['unknown page', post('/v1/changes', change({ page_ids: ['nope'] }))],
  ['extra field (author spoof)', post('/v1/changes', change({ author_name: 'Mallory' }))],
  ['1MB summary', post('/v1/changes', change({ summary: 'x'.repeat(1_000_000) }))],
  ['5000 page_ids', post('/v1/changes', change({ page_ids: Array(5000).fill('garden') }))],
  ['bad since on timeline', req('/v1/timeline?client=cedar&since=yesterday', { headers: AG })],
  ['impact days=100000', req('/v1/impact/title-refresh?days=100000', { headers: AG })],
  ['PATCH invalid JSON', req('/v1/changes/title-refresh', { method: 'PATCH', headers: AG, body: '{' })],
  ['login invalid JSON', post('/auth/login', '{', { 'Content-Type': 'application/json' })],
  ['MCP invalid JSON', post('/mcp', '{', { ...AG, Accept: 'application/json, text/event-stream' })],
];
for (const [name, p] of bad) { const r = await p; const ok = r.status >= 400 && r.status < 500; log(`reject ${name}`, ok, `status=${r.status} ${JSON.stringify(r.body).slice(0, 140)}`); }

// 7. Auth / isolation
const noAuth = await req('/v1/changes?client=cedar'); log('no auth -> 401', noAuth.status === 401, `status=${noAuth.status}`);
const sqli = await req(`/v1/changes?client=${encodeURIComponent("cedar' OR 1=1--")}`, { headers: AG }); log('SQLi in client filter returns nothing', sqli.status === 200 && sqli.body.length === 0, `status=${sqli.status}`);
const crossList = await req('/v1/changes?client=cedar', { headers: AG2 }); log('other org list cedar -> empty', crossList.status === 200 && crossList.body.length === 0, `status=${crossList.status} n=${crossList.body.length}`);
const crossImpact = await req('/v1/impact/title-refresh', { headers: AG2 }); log('other org impact -> 404', crossImpact.status === 404, `status=${crossImpact.status}`);
const crossPatch = await req('/v1/changes/title-refresh', { method: 'PATCH', headers: AG2, body: JSON.stringify({ summary: 'pwned' }) }); log('other org PATCH -> 404', crossPatch.status === 404, `status=${crossPatch.status}`);
const crossCreate = await post('/v1/changes', change(), AG2); log('other org create in cedar -> 404', crossCreate.status === 404, `status=${crossCreate.status}`);
const crossTimeline = await req('/v1/timeline?client=cedar', { headers: AG2 }); log('other org timeline -> 404', crossTimeline.status === 404, `status=${crossTimeline.status}`);
const crossImport = await req('/v1/metrics/import?client=cedar', { method: 'POST', headers: { ...AG2, 'Content-Type': 'text/csv' }, body: 'a' }); log('other org import -> 404', crossImport.status === 404, `status=${crossImport.status}`);
const agentAdmin = await post('/v1/agents', { name: 'x', scopes: ['read:metrics'] }); log('agent cannot mint agents -> 403', agentAdmin.status === 403, `status=${agentAdmin.status}`);
const login = await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alex@cedar.example', pass: 'notebook-demo-only' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const csrf = await post('/v1/clients', { name: 'x', timezone: 'UTC' }, { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' }); log('cookie mutation w/ foreign Origin -> 403', csrf.status === 403, `status=${csrf.status}`);
const csrf2 = await post('/v1/clients', { name: 'x', timezone: 'UTC' }, { Cookie: cookie, 'Content-Type': 'application/json' }); log('cookie mutation w/o Origin -> 403', csrf2.status === 403, `status=${csrf2.status}`);

// 8. MCP under load
const mcpH = { ...AG, Accept: 'application/json, text/event-stream' };
rs = await pool(100, 20, k => post('/mcp', { jsonrpc: '2.0', id: k, method: 'tools/list' }, mcpH)); log('MCP tools/list x100 @20', rs.every(r => r.status === 200 && r.body.result?.tools?.length === 3), stats(rs));
rs = await pool(50, 10, k => post('/mcp', { jsonrpc: '2.0', id: k, method: 'tools/call', params: { name: 'log_change', arguments: { ...change({ summary: `mcp ${run} ${k % 10}` }), idempotency_key: `mcp-${run}-${k % 10}` } } }, mcpH));
log('MCP log_change x50 (10 keys) no errors', rs.every(r => r.status === 200 && !r.body.result?.isError && !r.body.error), stats(rs));
const after = await req('/v1/changes?client=cedar', { headers: AG }); const mcpRows = after.body.filter(c => c.summary.startsWith(`mcp ${run}`)).length;
log('MCP idempotency: 10 keys -> 10 rows', mcpRows === 10, `rows=${mcpRows}`);

// 9. Imports
const header = 'property_id,page_id,date,metric,value,data_state\n';
const rows = n => Array.from({ length: n }, (_, i) => `cedar-gsc,guides,${new Date(Date.UTC(2025, 0, 1) + (i % 600) * 86400000).toISOString().slice(0, 10)},${['clicks', 'impressions', 'sessions', 'revenue', 'key_events', 'custom', 'ctr', 'position'][Math.floor(i / 600) % 8]},${i % 97},final`).join('\n');
const imports = { 'csv 5000 rows': header + rows(5000), 'csv 5001 rows': header + rows(5001), 'csv bad value': header + 'cedar-gsc,guides,2026-01-01,clicks,-5,final', 'csv foreign page': header + 'cedar-gsc,nope,2026-01-01,clicks,1,final', 'csv garbage': '\u0000\u0001"unterminated,quote\n', 'csv quoted multiline': header + 'cedar-gsc,guides,2026-01-02,clicks,"3",final\r\n' };
const jobIds = {};
for (const [name, body] of Object.entries(imports)) { const r = await req('/v1/metrics/import?client=cedar', { method: 'POST', headers: { ...AG, 'Content-Type': 'text/csv' }, body }); jobIds[name] = r.body.id; log(`import queued: ${name}`, r.status === 202, `status=${r.status} ${body.length}B`); }
const big = await req('/v1/metrics/import?client=cedar', { method: 'POST', headers: { ...AG, 'Content-Type': 'text/csv' }, body: header + 'x'.repeat(1_100_000) }); log('import >1MB -> 413', big.status === 413, `status=${big.status}`);
rs = await pool(30, 30, () => req('/v1/metrics/import?client=cedar', { method: 'POST', headers: { ...AG, 'Content-Type': 'text/csv' }, body: header + rows(2000) })); log('30 concurrent 2000-row imports queued', rs.every(r => r.status === 202), stats(rs));
const burst = rs.map(r => r.body.id);
const sync = await req('/v1/properties/cedar-gsc/sync?backfill=true', { method: 'POST', headers: { Cookie: cookie, Origin: new URL(B).origin, 'Content-Type': 'application/json' } }); log('16-month backfill queued', sync.status === 202, `status=${sync.status} queued=${sync.body.queued}`);
const deadline = Date.now() + 120_000; let pending = [];
while (Date.now() < deadline) { const st = await Promise.all([...Object.values(jobIds), ...burst].map(id => req(`/v1/imports/${id}`, { headers: AG }))); pending = st.filter(s => s.body.status === 'queued' || s.body.status === 'processing'); if (!pending.length) break; await new Promise(r => setTimeout(r, 2000)); }
for (const [name, id] of Object.entries(jobIds)) { const s = (await req(`/v1/imports/${id}`, { headers: AG })).body; const expectFail = /5001|bad value|foreign|garbage/.test(name); log(`import result: ${name}`, expectFail ? s.status === 'failed' : s.status === 'completed', `status=${s.status} rows=${s.row_count} err=${(s.error ?? '').slice(0, 100)}`); }
const burstSt = await Promise.all(burst.map(id => req(`/v1/imports/${id}`, { headers: AG }))); const bc = {}; for (const s of burstSt) bc[s.body.status] = (bc[s.body.status] ?? 0) + 1;
log('burst imports all processed', !pending.length, JSON.stringify(bc));
const tl = await req('/v1/timeline?client=cedar&since=2025-01-01', { headers: AG }); log('timeline after backfill (20k cap)', tl.status === 200, `rows=${tl.body.metrics?.length} ms=${tl.ms.toFixed(0)}${tl.body.metrics?.length === 20000 ? ' (TRUNCATED at cap)' : ''}`);

const fails = out.filter(o => !o.ok); console.log(`\n${out.length - fails.length}/${out.length} passed`); for (const f of fails) console.log(' FAIL', f.name, f.detail ?? '');
