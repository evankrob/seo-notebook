const root = document.querySelector('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opt = (v, t) => `<option value="${esc(v)}">${esc(t)}</option>`;
const number = n => n === null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
let state = { clients: [], client: null, context: null, changes: [], metrics: [], page: '', property: '', metric: 'clicks', selected: null, impact: null };
async function api(path, method = 'GET', data, raw = false) { const r = await fetch(path, { method, headers: data ? { 'Content-Type': raw ? 'text/csv' : 'application/json' } : {}, body: data ? (raw ? data : JSON.stringify(data)) : undefined }); const body = await r.json(); if (!r.ok)
    throw new Error(body.error || 'Request failed'); return body; }
function toast(message) { document.querySelector('#toast')?.remove(); const d = document.createElement('div'); d.id = 'toast'; d.textContent = message; document.body.append(d); setTimeout(() => d.remove(), 8000); }
function bind(id, fn, event = 'click') { document.getElementById(id)?.addEventListener(event, async (e) => { try {
    await fn(e);
}
catch (err) {
    toast(err.message);
} }); }
function modal(title, html, submit) { const container = document.createElement('div'); container.className = 'modal'; container.innerHTML = `<section class="panel" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="row between"><h2>${esc(title)}</h2><button class="secondary" id="close-modal" type="button">Close</button></div><form id="modal-form">${html}<button>Save</button></form></section>`; document.body.append(container); container.querySelector('#close-modal').onclick = () => container.remove(); container.onclick = e => { if (e.target === container)
    container.remove(); }; const onKey = e => { if (e.key === 'Escape') {
    container.remove();
    document.removeEventListener('keydown', onKey);
} }; document.addEventListener('keydown', onKey); container.querySelector('input,select,textarea')?.focus(); container.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true; try {
    await submit(Object.fromEntries(new FormData(e.target)));
    container.remove();
    document.removeEventListener('keydown', onKey);
}
catch (err) {
    toast(err.message);
}
finally {
    button.disabled = false;
} }; }
const input = (name, label, type = 'text', value = '', required = true) => `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''}></label>`;
async function boot() { if (location.pathname.startsWith('/reports/'))
    return report(); try {
    state.me = await api('/v1/me');
    state.clients = await api('/v1/clients');
    state.client = state.client ?? state.clients[0]?.id;
    if (state.client)
        await load();
    else
        welcome();
}
catch (e) {
    root.innerHTML = `<section class="login panel"><div class="eyebrow">SEO Notebook</div><h1>Not signed in.</h1><p class="muted">${esc(e.message)}. Open this notebook through its Cloudflare Access URL, or run it locally with <code>npm run dev</code>.</p></section>`;
} }
async function load() { state.context = await api(`/v1/clients/${state.client}/context`); if (!state.context.properties.some(p => p.id === state.property))
    state.property = state.context.properties.find(p => p.type.startsWith('gsc'))?.id ?? state.context.properties[0]?.id ?? ''; const q = new URLSearchParams({ client: state.client, property: state.property, metric: state.metric, since: '2026-08-01', ...(state.page ? { page: state.page } : {}) }); const t = await api('/v1/timeline?' + q); state.metrics = t.metrics; state.changes = t.changes; state.selected = state.changes.find(c => c.id === state.selected?.id) ?? state.changes.find(c => c.status === 'shipped') ?? state.changes[0]; state.impact = state.selected ? await api('/v1/impact/' + state.selected.id) : null; render(); }
function chart(metrics, changes, metric = state.metric) { const dates = [...new Set(metrics.map(m => m.date))].sort(), totals = dates.map(d => metrics.filter(m => m.date === d).reduce((s, m) => s + m.value, 0)); if (!dates.length)
    return '<div class="empty">No metrics yet. Queue a fixture sync or upload CSV.</div>'; const max = Math.max(...totals, 1), x = i => 40 + i / Math.max(dates.length - 1, 1) * 640, y = v => 165 - v / max * 130; const path = totals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' '); return `<svg class="chart" viewBox="0 0 720 205" role="img" aria-label="Daily ${esc(metric)} with change markers"><line x1="40" y1="35" x2="680" y2="35"/><line x1="40" y1="100" x2="680" y2="100"/><line x1="40" y1="165" x2="680" y2="165"/><text x="0" y="39">${number(max)}</text><text x="18" y="169">0</text><path d="${path}"/>${changes.map(c => { const i = dates.indexOf(c.occurred_at); return i < 0 ? '' : `<circle cx="${x(i)}" cy="${y(totals[i])}" r="5"><title>${esc(c.occurred_at + ' · ' + c.summary)}</title></circle>`; }).join('')}<text x="40" y="196">${dates[0]}</text><text x="610" y="196">${dates.at(-1)}</text></svg>`; }
function impactHTML(i) { if (!i)
    return '<p class="muted">Select a change to explore its impact.</p>'; return `<div class="row between"><span class="eyebrow">${esc(i.metric.replace('_', ' '))}</span><span class="pill">${esc(i.confidence)}</span></div><div class="impact-grid"><div>BEFORE · ${i.windows.days} DAYS<strong>${number(i.pre)}</strong><small>${esc(i.windows.pre.start)} → ${esc(i.windows.pre.end)}</small></div><div>AFTER · ${i.windows.days} DAYS<strong>${number(i.post)}</strong><small>${esc(i.windows.post.start)} → ${esc(i.windows.post.end)}</small></div></div><div class="stat positive">${i.scored && i.percent !== null ? (i.percent >= 0 ? '+' : '') + number(i.percent) + '%' : 'Pending'}</div><p>${i.scored ? 'Observed change' : 'Awaiting comparable final windows'} · ${i.windows.lag}-day lag</p>${i.control ? `<p>Control: ${number(i.control.pre)} → ${number(i.control.post)}<br>Adjusted difference: ${number(i.adjustedPercent)} percentage points</p>` : ''}${(i.overlap_count ?? i.overlaps.length) ? `<div class="warning">${i.overlap_count ?? i.overlaps.length} overlapping change(s).<br>${i.overlaps.map(esc).join('<br>')}</div>` : ''}${i.warnings.length ? `<details><summary>Measurement notes (${i.warnings.length})</summary><p>${i.warnings.map(esc).join('<br>')}</p></details>` : ''}<div class="separator"></div><small>${esc(i.caveat)} GSC recent days may be revised; query totals exclude anonymized queries.</small>`; }
function render() {
    const ctx = state.context, cs = state.changes;
    root.innerHTML = `<div class="intro"><div class="row between"><div><div class="eyebrow">Site / ${esc(ctx?.client.domain ?? ctx?.client.name ?? '')}</div><h1>The work. The why. The impact.</h1><p class="muted">A living record of your SEO & conversion changes.</p></div><div class="row"><button class="secondary" id="agents">⚙ Agents</button><button class="secondary" id="share">↗ Share report</button><button id="new-change">+ Log a change</button></div></div></div><div class="row between"><div class="row"><select id="client-filter" aria-label="Site">${state.clients.map(c => opt(c.id, c.domain ?? c.name)).join('')}</select><span class="muted">${esc(state.me.email ?? state.me.name)}</span></div>${signOut()}</div><div class="cards"><div class="card"><div class="eyebrow">Changes shipped</div><div class="stat">${cs.filter(c => c.status === 'shipped').length}</div><small>Progress, recorded.</small></div><div class="card"><div class="eyebrow">Planned next</div><div class="stat">${cs.filter(c => c.status === 'planned').length}</div><small>A hypothesis for every action.</small></div><div class="card"><div class="eyebrow">Connected sources</div><div class="stat">${ctx?.properties.length ?? 0} <span class="pill">MOCK DATA</span></div><small>GSC + GA4 · fixture-backed</small></div></div><div class="workspace"><section><div class="panel"><div class="row between"><h2>Performance timeline</h2><span class="muted">Daily metrics</span></div><div class="filters"><select id="property-filter" aria-label="Property">${ctx?.properties.map(p => opt(p.id, p.type + ' · ' + p.external_id)).join('') ?? ''}</select><select id="page-filter" aria-label="Page">${opt('', 'All pages')}${ctx?.pages.map(p => opt(p.id, new URL(p.url).pathname)).join('') ?? ''}</select><select id="metric-filter" aria-label="Metric">${['clicks', 'impressions', 'sessions', 'key_events'].map(m => opt(m, m.replace('_', ' '))).join('')}</select></div>${chart(state.metrics, cs)}<div class="legend"><span><i class="dot"></i>${esc(state.metric)}</span><span><i class="dot amber"></i>Change recorded · hover to inspect</span></div></div><div class="entries"><div class="row between"><h2>Change log</h2><small>${cs.length} entries</small></div>${cs.length ? cs.map(c => `<article class="entry"><div class="entry-meta">${esc(c.occurred_at)} <span class="pill ${esc(c.status)}">${esc(c.status)}</span> ${esc(c.type.replace('_', ' '))}</div><div class="card"><div class="row between"><h3>${esc(c.summary)}</h3><button class="secondary" data-impact="${esc(c.id)}">View impact ↗</button></div><p>${esc(c.rationale)}</p>${diffHTML(c.diff)}<small>${esc(c.author_name)} · ${esc(c.source)} · ${c.sitewide ? 'Sitewide' : esc(c.group_id ?? c.page_ids.map(id => ctx.pages.find(p => p.id === id)?.url ?? id).join(', '))}</small>${c.evidence.length ? `<p>${c.evidence.map(u => `<a href="${esc(u)}" rel="noreferrer" target="_blank">Evidence ↗</a>`).join(' · ')}</p>` : ''}<div class="row"><button class="secondary" data-edit="${esc(c.id)}">Edit</button>${c.status !== 'reverted' ? `<button class="secondary" data-revert="${esc(c.id)}">Revert</button>` : ''}</div></div></article>`).join('') : '<div class="empty">Your first change starts the story.</div>'}</div></section><aside><section class="panel"><div class="eyebrow">Impact notebook</div><h2 id="impact-title">${esc(state.selected?.summary ?? 'Select a change')}</h2><div id="impact-content">${impactHTML(state.impact)}</div><label>Compare with control<select id="control">${opt('', 'No control group')}${ctx?.groups.map(g => opt(g.id, g.name)).join('') ?? ''}</select></label><p>Defaults: 28 days before, 3 days excluded after the change, then 28 days after. Small samples remain inconclusive.</p></section><section class="panel"><h2>Workspace tools</h2><div class="tools"><button class="secondary" id="sync">↻ Sync fixture data (last 7 days)</button><button class="secondary" id="backfill">↻ Backfill fixtures (16 months)</button><button class="secondary" id="upload">↑ Upload CSV</button><button class="secondary" id="add-client">+ Add site</button><button class="secondary" id="add-page">+ Add page</button><button class="secondary" id="add-property">+ Connect mock property</button><button class="secondary" id="add-group">+ Create page group</button><button class="secondary" id="agent">+ Connect an agent</button></div><p>Agents usually create sites and pages for you when they log a change.</p></section></aside></div>`;
    if (state.client)
        document.querySelector('#client-filter').value = state.client;
    for (const [k, v] of [['property', state.property], ['page', state.page], ['metric', state.metric]]) {
        document.querySelector('#' + k + '-filter').value = v;
        bind(k + '-filter', async (e) => { state[k] = e.target.value; if (k === 'property')
            state.metric = ctx.properties.find(p => p.id === state.property)?.type === 'ga4' ? 'sessions' : 'clicks'; if (k === 'metric') {
            const ga = ['sessions', 'key_events'].includes(state.metric);
            state.property = ctx.properties.find(p => ga ? p.type === 'ga4' : p.type.startsWith('gsc'))?.id ?? state.property;
        } await load(); }, 'change');
    }
    bind('client-filter', async (e) => { state.client = e.target.value; state.page = ''; state.property = ''; await load(); }, 'change');
    bind('agents', agents);
    bind('new-change', () => changeForm());
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => changeForm(cs.find(c => c.id === b.dataset.edit)));
    root.querySelectorAll('[data-revert]').forEach(b => b.onclick = async () => { try {
        await api('/v1/changes/' + b.dataset.revert, 'PATCH', { status: 'reverted' });
        await load();
    }
    catch (e) {
        toast(e.message);
    } });
    root.querySelectorAll('[data-impact]').forEach(b => b.onclick = async () => { try {
        state.selected = cs.find(c => c.id === b.dataset.impact);
        state.impact = await api('/v1/impact/' + b.dataset.impact);
        render();
    }
    catch (e) {
        toast(e.message);
    } });
    bind('control', async (e) => { if (!state.selected)
        return; const i = await api('/v1/impact/' + state.selected.id + (e.target.value ? '?control=' + encodeURIComponent(e.target.value) : '')); document.querySelector('#impact-content').innerHTML = impactHTML(i); }, 'change');
    bind('sync', () => sync(false));
    bind('backfill', () => sync(true));
    bind('upload', upload);
    bind('share', share);
    bind('add-client', addSite);
    bind('add-page', () => modal('Add a page', input('url', 'Page URL', 'url') + input('canonical', 'Canonical URL (optional)', 'url', '', false), async (b) => { await api('/v1/pages', 'POST', { client_id: state.client, url: b.url, ...(b.canonical ? { canonical: b.canonical } : {}) }); await load(); }));
    bind('add-property', () => modal('Connect a fixture property', `<label>Type<select name="type">${['gsc_domain', 'gsc_url_prefix', 'ga4', 'custom'].map(t => opt(t, t)).join('')}</select></label>` + input('external_id', 'External ID (fictional)') + `<label>Mock auth flow<select name="auth_type">${opt('oauth', 'OAuth fixture')}${opt('service_account', 'Service-account fixture')}</select></label>`, async (b) => { await api('/v1/properties', 'POST', { client_id: state.client, ...b }); await load(); }));
    bind('add-group', () => modal('Create a page group', input('name', 'Group name') + `<label>Page IDs (comma separated)<input name="ids" required placeholder="${esc(ctx?.pages.map(p => p.id).join(', '))}"></label>`, async (b) => { await api('/v1/groups', 'POST', { client_id: state.client, name: b.name, page_ids: b.ids.split(',').map(s => s.trim()).filter(Boolean) }); await load(); }));
    bind('agent', newAgent);
}
function changeForm(existing) { const c = existing ?? {}, ctx = state.context; if (!ctx)
    return toast('Add a site first.'); const scopeValue = c.sitewide ? 'sitewide' : c.group_id ? 'group:' + c.group_id : c.page_ids?.[0] ?? ctx.pages[0]?.id; modal(existing ? 'Edit change' : 'Log a change', `<div class="form-grid">${input('occurred_at', 'Date', 'date', c.occurred_at ?? new Date().toISOString().slice(0, 10))}<label>Status<select name="status">${['planned', 'shipped', 'reverted'].map(t => opt(t, t)).join('')}</select></label><label>Change type<select name="type">${['content', 'title_meta', 'new_page', 'internal_links', 'schema', 'redirect', 'template', 'technical', 'CRO_form', 'CRO_layout', 'ppc_landing', 'external_event'].map(t => opt(t, t)).join('')}</select></label><label>Scope<select name="scope">${opt('sitewide', 'Sitewide')}${ctx.pages.map(p => opt(p.id, new URL(p.url).pathname)).join('')}${ctx.groups.map(g => opt('group:' + g.id, g.name)).join('')}</select></label><label class="wide">What changed?<input name="summary" required maxlength="500" value="${esc(c.summary ?? '')}"></label><label class="wide">Why? Hypothesis<textarea name="rationale" required>${esc(c.rationale ?? '')}</textarea></label><label>Expected metric<select name="expected_metric">${['clicks', 'impressions', 'sessions', 'key_events'].map(m => opt(m, m)).join('')}</select></label>${input('evidence', 'Evidence link (optional)', 'url', c.evidence?.[0] ?? '', false)}</div>`, async (b) => { const data = { client_id: state.client, occurred_at: b.occurred_at, timezone: ctx.client.timezone, status: b.status, type: b.type, summary: b.summary, rationale: b.rationale, expected_metric: b.expected_metric, evidence: b.evidence ? [b.evidence] : [], sitewide: b.scope === 'sitewide', page_ids: b.scope === 'sitewide' || b.scope.startsWith('group:') ? [] : [b.scope], group_id: b.scope.startsWith('group:') ? b.scope.slice(6) : null }; if (existing) {
    delete data.client_id;
    await api('/v1/changes/' + c.id, 'PATCH', data);
}
else
    await api('/v1/changes', 'POST', data); await load(); }); const f = document.querySelector('#modal-form'); for (const [k, v] of Object.entries({ status: c.status ?? 'shipped', type: c.type ?? 'content', scope: scopeValue, expected_metric: c.expected_metric ?? 'clicks' }))
    f.elements[k].value = v; }
async function sync(backfill) { if (!state.property)
    return toast('Add a property first.'); const r = await api(`/v1/properties/${state.property}/sync${backfill ? '?backfill=true' : ''}`, 'POST'); toast(`${r.queued} property-day fixture jobs queued. Refresh shortly to view results.`); }
function upload() { modal('Import a CSV', `<label>Import type<select name="kind">${opt('metrics', 'Daily metrics')}${opt('changes', 'Past changes')}</select></label><label>CSV file<input name="file" type="file" accept=".csv,text/csv" required></label><p class="muted">Use the examples in fixtures/. Maximum 1 MB / 5,000 rows. Raw uploads are stored in local R2 and parsed by the Queue.</p>`, async () => { const form = document.querySelector('#modal-form'), file = form.elements.file.files[0]; const r = await api(`/v1/${form.elements.kind.value}/import?client=${state.client}`, 'POST', await file.text(), true); toast('Import queued: ' + r.id); pollImport(r.id); }); }
async function pollImport(id) { for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const j = await api('/v1/imports/' + id);
    if (j.status === 'completed') {
        toast(`${j.row_count} rows imported.`);
        await load();
        return;
    }
    if (j.status === 'failed') {
        toast('Import failed: ' + j.error);
        return;
    }
} toast('Import is still queued. Check /v1/imports/' + id); }
function share() { if (!state.client)
    return; modal('Create a read-only report', input('title', 'Report title', 'text', state.context.client.name + ' · Progress report') + input('since', 'From', 'date', '2026-08-01') + input('until', 'Through', 'date', new Date().toISOString().slice(0, 10)), async (b) => { const r = await api('/v1/reports', 'POST', { client_id: state.client, ...b }); setTimeout(() => modal('Your read-only report', `<p>Anyone with this link can read this client’s selected period. Report ID: ${esc(r.id)}</p><a href="${esc(r.url)}" target="_blank">${esc(location.origin + r.url)}</a><p><a href="/public${esc(r.url)}/export.csv">Download CSV</a></p>`, async () => { }), 0); }); }
async function report() { const token = location.pathname.split('/')[2]; try {
    const r = await api('/public/reports/' + encodeURIComponent(token));
    root.innerHTML = `<div class="report-list"><div class="report-head"><div class="eyebrow">Client notebook · Read-only report</div><h1>${esc(r.title)}</h1><p class="muted">${esc(r.client)} · ${esc(r.since)} — ${esc(r.until)}</p><a class="button secondary" href="/public/reports/${encodeURIComponent(token)}/export.csv">↓ Export CSV</a></div>${r.changes.map(({ change: c, impact: i }) => `<article class="card"><div class="row between"><small>${esc(c.occurred_at)} · ${esc(c.author_name)}</small><span class="pill ${esc(c.status)}">${esc(c.status)}</span></div><h2>${esc(c.summary)}</h2><p>${esc(c.rationale)}</p>${diffHTML(c.diff)}${chart(i.series, [c], i.metric)}${impactHTML(i)}</article>`).join('') || '<p>No changes in this period.</p>'}</div>`;
}
catch (e) {
    root.innerHTML = `<p class="error">${esc(e.message)}</p>`;
} }

function signOut() {
    if (state.me.auth === 'access')
        return '<a class="button secondary" href="/cdn-cgi/access/logout">Sign out</a>';
    return '<span class="muted">Local mode</span>';
}

const fieldLabel = f => ({ meta_description: 'Meta description', h1: 'H1', internal_links: 'Internal links' }[f] ?? f[0].toUpperCase() + f.slice(1).replace('_', ' '));
function diffHTML(diff) {
    if (!diff?.length)
        return '';
    const rows = diff.map(d => `<dt>${esc(fieldLabel(d.field))}</dt>
        <dd><del>${esc(d.before ?? '—')}</del><span aria-hidden="true"> → </span><ins>${esc(d.after ?? '—')}</ins>${d.note ? `<small>${esc(d.note)}</small>` : ''}</dd>`).join('');
    return `<details class="diff"><summary>${diff.length} field${diff.length === 1 ? '' : 's'} changed</summary><dl>${rows}</dl></details>`;
}

// A dialog without a form, for read-only content.
function sheet(title, html) {
    const container = document.createElement('div');
    container.className = 'modal';
    container.innerHTML = `<section class="panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="row between"><h2>${esc(title)}</h2><button class="secondary" type="button" data-close>Close</button></div>${html}</section>`;
    const close = () => { container.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    container.onclick = e => { if (e.target === container || e.target.closest('[data-close]')) close(); };
    document.addEventListener('keydown', onKey);
    document.body.append(container);
    return container;
}

function welcome() {
    root.innerHTML = `<section class="panel welcome">
        <div class="row between"><div class="eyebrow">SEO Notebook</div>${signOut()}</div>
        <h1>Let your agents keep the log.</h1>
        <p class="muted">Connect the AI agents that edit your sites. Every time one changes a title, meta description or page content,
        it records what changed and why here, so you can see the before and after in Search Console and Analytics.</p>
        <ol>
            <li><strong>Connect an agent.</strong> You get a token and a copy-paste MCP config.</li>
            <li><strong>Tell it to log its changes.</strong> We give you a one-line instruction for its project rules.</li>
            <li><strong>Watch the notebook fill in.</strong> Sites and pages are created from the URLs it sends.</li>
        </ol>
        <div class="row"><button id="agent">+ Connect an agent</button><button class="secondary" id="add-client">Add a site manually</button></div>
    </section>`;
    bind('agent', newAgent);
    bind('add-client', addSite);
}

function addSite() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    modal('Add a site', input('domain', 'Domain', 'text', '') + input('timezone', 'Reporting timezone', 'text', zone), async (b) => {
        const c = await api('/v1/clients', 'POST', b);
        state.client = c.id;
        state.property = '';
        await boot();
    });
    document.querySelector('#modal-form [name=domain]').placeholder = 'example.com';
}

async function agents() {
    const list = await api('/v1/agents');
    const rows = list.map(a => `<tr><td>${esc(a.name)}</td><td>${esc(a.model ?? '')}</td>
        <td>${a.revoked ? '<span class="pill reverted">revoked</span>' : `<button class="secondary" data-revoke="${esc(a.id)}">Revoke</button>`}</td></tr>`).join('');
    const box = sheet('Agents', `<p class="muted">Each agent has its own token, so its changes are attributed to it and it can be revoked on its own.</p>
        ${list.length ? `<table class="agents"><thead><tr><th>Agent</th><th>Model / tool</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No agents connected yet.</div>'}
        <button id="connect-agent">+ Connect an agent</button>`);
    box.querySelector('#connect-agent').onclick = () => { box.remove(); newAgent(); };
    box.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
        try {
            await api('/v1/agents/' + b.dataset.revoke, 'DELETE');
            box.remove();
            await agents();
        }
        catch (e) {
            toast(e.message);
        }
    });
}

function newAgent() {
    modal('Connect an agent', input('name', 'Agent name', 'text', '') + input('model', 'Model / tool (optional)', 'text', '', false), async (b) => {
        const a = await api('/v1/agents', 'POST', { name: b.name, ...(b.model ? { model: b.model } : {}), scopes: ['write:changes', 'read:metrics'] });
        setTimeout(() => agentSetup(b.name, a.token), 0);
    });
    document.querySelector('#modal-form [name=name]').placeholder = 'e.g. Claude Code · unikewax repo';
}

function agentSetup(name, token) {
    const url = location.origin + '/mcp';
    const claude = `claude mcp add --transport http seo-notebook ${url} --header "Authorization: Bearer ${token}"`;
    const json = JSON.stringify({ mcpServers: { 'seo-notebook': { url, headers: { Authorization: 'Bearer ' + token } } } }, null, 2);
    const rule = 'After you change any page on a website (titles, meta descriptions, headings, content, schema, redirects, links), call the seo-notebook log_change tool with the page URL, a one-line summary, why you made the change, and the old and new value of each field you changed.';
    const block = (id, label, text) => `<label>${esc(label)}<pre id="${id}">${esc(text)}</pre></label><button class="secondary" type="button" data-copy="${id}">Copy</button>`;
    const box = sheet('Connect ' + name, `<p><strong>Copy the token now.</strong> It is shown once and stored only as a hash.</p>
        ${block('cfg-claude', 'Claude Code', claude)}
        ${block('cfg-json', 'Cursor, Windsurf and other MCP clients (JSON config)', json)}
        ${block('cfg-rule', 'Add to the agent’s project rules (CLAUDE.md, AGENTS.md, .cursorrules)', rule)}
        ${state.me.auth === 'access' ? '<div class="warning">Cloudflare Access must let <code>/mcp</code> through: add an Access application for this hostname with path <code>mcp</code> and a <em>Bypass</em> policy. The agent token protects that path.</div>' : ''}`);
    box.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
        await navigator.clipboard.writeText(box.querySelector('#' + b.dataset.copy).textContent);
        b.textContent = 'Copied';
    });
}

boot();
