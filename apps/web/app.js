const root = document.querySelector('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opt = (v, t, selected = false) => `<option value="${esc(v)}"${selected ? ' selected' : ''}>${esc(t)}</option>`;
const number = n => n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const METRICS = ['clicks', 'impressions', 'sessions', 'key_events'];
const TYPES = ['content', 'title_meta', 'new_page', 'internal_links', 'schema', 'redirect', 'template', 'technical', 'CRO_form', 'CRO_layout', 'ppc_landing', 'external_event'];
const FIELDS = ['title', 'meta_description', 'h1', 'headings', 'content', 'canonical', 'robots', 'schema', 'redirect', 'internal_links', 'images', 'url', 'other'];
const TYPE_LABELS = { title_meta: 'Title & meta', new_page: 'New page', internal_links: 'Internal links', CRO_form: 'CRO · form', CRO_layout: 'CRO · layout', ppc_landing: 'PPC landing', external_event: 'External event' };
const SOURCE_LABELS = { mcp: 'via MCP', api: 'via API', ui: 'by hand', import: 'imported' };
const WEEKS = 20;
// Performance chart ranges, in days; the first is the default.
const RANGES = [[30, 'Last 30 days'], [90, 'Last 90 days'], [182, 'Last 6 months'], [487, 'Last 16 months']];

const state = {
    me: null,
    sites: [],
    changes: [],
    contexts: {},
    agentCount: null,
    started: false,
    filter: { site: '', tag: '', status: '', day: '', q: '' },
    activityView: 'calendar',
    menuOpen: false,
    // Metrics for the selected site.
    metrics: [],
    pageChanges: null,
    property: '',
    page: '',
    metric: 'clicks',
    range: String(RANGES[0][0]),
    expanded: null,
    impacts: {},
};

async function api(path, method = 'GET', data, raw = false) {
    const r = await fetch(path, {
        method,
        headers: data ? { 'Content-Type': raw ? 'text/csv' : 'application/json' } : {},
        body: data ? (raw ? data : JSON.stringify(data)) : undefined,
    });
    const body = await r.json();
    if (!r.ok)
        throw new Error(body.error || 'Request failed');
    return body;
}

function toast(message) {
    document.querySelector('#toast')?.remove();
    const d = document.createElement('div');
    d.id = 'toast';
    d.setAttribute('role', 'status');
    d.textContent = message;
    document.body.append(d);
    setTimeout(() => d.remove(), 8000);
}

// Dates are local calendar days (YYYY-MM-DD).
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);
const today = () => iso(new Date());
const shortDate = s => parseDay(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(s.slice(0, 4) !== today().slice(0, 4) ? { year: 'numeric' } : {}) });

// "21m ago" when the change was logged the day it happened; otherwise days or weeks from its date.
function when(c) {
    const logged = c.created_at ? new Date(c.created_at) : null;
    if (logged && !isNaN(logged) && iso(logged) === c.occurred_at) {
        const s = (Date.now() - logged) / 1000;
        if (s >= 0 && s < 60)
            return 'just now';
        if (s >= 0 && s < 3600)
            return `${Math.floor(s / 60)}m ago`;
        if (s >= 0 && s < 86400)
            return `${Math.floor(s / 3600)}h ago`;
    }
    const days = daysBetween(c.occurred_at, today());
    if (days === 0)
        return 'today';
    if (days === 1)
        return 'yesterday';
    if (days === -1)
        return 'tomorrow';
    if (days < 0)
        return `in ${-days}d`;
    if (days < 7)
        return `${days}d ago`;
    if (days < 56)
        return `${Math.round(days / 7)}w ago`;
    return shortDate(c.occurred_at);
}

const fieldLabel = f => ({ meta_description: 'Meta description', h1: 'H1', internal_links: 'Internal links' }[f] ?? f[0].toUpperCase() + f.slice(1).replace('_', ' '));
const typeLabel = t => TYPE_LABELS[t] ?? t[0].toUpperCase() + t.slice(1).replace('_', ' ');
const initials = name => String(name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const siteOf = id => state.sites.find(s => s.id === id);
const domainOf = id => siteOf(id)?.domain ?? siteOf(id)?.name ?? '';

async function boot() {
    root.addEventListener('click', e => handle(e, 'click'));
    root.addEventListener('change', e => handle(e, 'change'));
    root.addEventListener('input', e => {
        if (e.target.id !== 'search')
            return;
        state.filter.q = e.target.value;
        render({ keepSearch: true });
    });
    if (location.pathname.startsWith('/reports/'))
        return report();
    try {
        state.me = await api('/v1/me');
    }
    catch (e) {
        return signedOut(e);
    }
    try {
        await refresh();
    }
    catch (e) {
        root.innerHTML = `<div class="page"><p class="error">${esc(e.message)}</p></div>`;
    }
}

async function refresh() {
    const [sites, changes] = await Promise.all([api('/v1/sites'), api('/v1/changes')]);
    state.sites = sites;
    state.changes = changes;
    if (!sites.length)
        return welcome();
    if (!state.started) {
        state.started = true;
        if (sites.length === 1)
            state.filter.site = sites[0].id;
    }
    if (state.filter.site && !siteOf(state.filter.site))
        state.filter.site = '';
    const contexts = await Promise.all(sites.map(s => api(`/v1/clients/${s.id}/context`)));
    state.contexts = Object.fromEntries(sites.map((s, i) => [s.id, contexts[i]]));
    state.agentCount = await api('/v1/agents').then(a => a.filter(x => !x.revoked).length, () => null);
    await loadMetrics();
    render();
}

// Live Google data wins over fixtures when a site has both.
const pickProperty = (ctx, ga) => {
    const fits = ctx.properties.filter(p => ga ? p.type === 'ga4' : p.type.startsWith('gsc'));
    return (fits.find(p => p.mode === 'live') ?? fits[0])?.id;
};

async function loadMetrics() {
    const ctx = state.contexts[state.filter.site];
    if (!ctx) {
        state.metrics = [];
        state.pageChanges = null;
        return;
    }
    if (!ctx.properties.some(p => p.id === state.property))
        state.property = pickProperty(ctx, false) ?? ctx.properties[0]?.id ?? '';
    if (!ctx.pages.some(p => p.id === state.page))
        state.page = '';
    if (!state.property) {
        state.metrics = [];
        state.pageChanges = null;
        return;
    }
    const q = new URLSearchParams({ client: ctx.client.id, property: state.property, metric: state.metric, since: iso(addDays(new Date(), -Number(state.range))), ...(state.page ? { page: state.page } : {}) });
    const t = await api('/v1/timeline?' + q);
    state.metrics = t.metrics;
    state.pageChanges = state.page ? new Set(t.changes.map(c => c.id)) : null;
}

// Filtering. Each sidebar count ignores its own filter so the numbers stay useful.
function matches(c, skip = '') {
    const f = state.filter, q = f.q.trim().toLowerCase();
    return (skip === 'site' || !f.site || c.client_id === f.site)
        && (skip === 'tag' || !f.tag || c.tags.includes(f.tag))
        && (skip === 'status' || !f.status || c.status === f.status)
        && (skip === 'day' || !f.day || c.occurred_at === f.day)
        && (!state.pageChanges || c.client_id !== f.site || state.pageChanges.has(c.id))
        && (!q || haystack(c).includes(q));
}
const haystack = c => [c.summary, c.rationale, c.author_name, c.type, ...c.tags, ...pagesOf(c).map(p => p.url), ...c.diff.flatMap(d => [d.before, d.after])].join(' ').toLowerCase();
const countBy = (list, key) => list.reduce((m, x) => { for (const k of [key(x)].flat()) m.set(k, (m.get(k) ?? 0) + 1); return m; }, new Map());

function pagesOf(c) {
    const ctx = state.contexts[c.client_id];
    if (!ctx)
        return [];
    const ids = c.group_id ? JSON.parse(ctx.groups.find(g => g.id === c.group_id)?.page_ids ?? '[]') : c.page_ids;
    return ids.map(id => ctx.pages.find(p => p.id === id)).filter(Boolean);
}

function render(opts = {}) {
    const scrollTop = document.querySelector('.sidebar')?.scrollTop ?? 0;
    const caret = opts.keepSearch ? document.querySelector('#search')?.selectionStart : null;
    root.innerHTML = `<div class="shell${state.menuOpen ? ' open' : ''}">
        <aside class="sidebar" aria-label="Filters">${sidebarHTML()}</aside>
        <div class="scrim" data-action="menu"></div>
        <main class="main">${mainHTML()}</main>
    </div>`;
    document.querySelector('.sidebar').scrollTop = scrollTop;
    if (opts.keepSearch) {
        const s = document.querySelector('#search');
        s.focus();
        s.setSelectionRange(caret, caret);
    }
    if (state.expanded)
        fillDetail(state.expanded);
}

function sidebarHTML() {
    const f = state.filter;
    const siteCounts = countBy(state.changes.filter(c => matches(c, 'site')), c => c.client_id);
    const scoped = state.changes.filter(c => !f.site || c.client_id === f.site);
    const tagCounts = [...countBy(scoped.filter(c => matches(c, 'tag')), c => c.tags)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const allCount = [...siteCounts.values()].reduce((a, b) => a + b, 0);
    const mode = state.me.auth === 'local' ? '<span class="pill quiet">LOCAL</span>' : '';
    return `<a class="brand" href="/"><span class="logo">N</span>SEO Notebook ${mode}</a>
        <div class="totals">
            <div><strong>${state.changes.length}</strong><span>Changes</span></div>
            <div><strong>${state.sites.length}</strong><span>Sites</span></div>
            <div><strong>${state.agentCount ?? '—'}</strong><span>Agents</span></div>
        </div>
        <section aria-label="Activity">
            <div class="segmented" role="group" aria-label="Activity view">
                <button data-action="view" data-value="trend" aria-pressed="${state.activityView === 'trend'}">Trend</button>
                <button data-action="view" data-value="calendar" aria-pressed="${state.activityView === 'calendar'}">Calendar</button>
            </div>
            ${activityHTML(state.changes.filter(c => matches(c, 'day')))}
        </section>
        <nav class="nav" aria-label="Sites">
            <div class="nav-title">Sites</div>
            <button data-action="site" data-value="" aria-pressed="${!f.site}"><span>All sites</span><span class="count">${allCount}</span></button>
            ${state.sites.map(s => `<button data-action="site" data-value="${esc(s.id)}" aria-pressed="${f.site === s.id}"><span>${esc(s.domain ?? s.name)}</span><span class="count">${siteCounts.get(s.id) ?? 0}</span></button>`).join('')}
        </nav>
        ${tagCounts.length || f.tag ? `<section class="nav" aria-label="Tags">
            <div class="nav-title">Tags</div>
            <div class="tags">${tagCounts.map(([t, n]) => `<button class="tag" data-action="tag" data-value="${esc(t)}" aria-pressed="${f.tag === t}">#${esc(t)}<b>${n}</b></button>`).join('')}</div>
        </section>` : ''}
        <nav class="nav" aria-label="Workspace">
            <div class="nav-title">Workspace</div>
            <button data-action="agents"><span>Agents</span><span class="count">${state.agentCount ?? '—'}</span></button>
            <button data-action="share"><span>Share a report</span></button>
            <button data-action="tools"><span>Imports &amp; data</span></button>
        </nav>
        <div class="sidebar-foot">
            <span>${esc(state.me.email ?? state.me.name)}</span>
            ${state.me.auth === 'access' ? '<a href="/cdn-cgi/access/logout">Sign out</a>' : '<span>Local mode · no sign-in</span>'}
        </div>`;
}

// GitHub-style grid: one column per week, oldest on the left, ending with the current week.
function activityHTML(list) {
    const counts = countBy(list, c => c.occurred_at);
    const now = new Date();
    const start = addDays(now, -now.getDay() - (WEEKS - 1) * 7);
    const days = Array.from({ length: WEEKS * 7 }, (_, i) => iso(addDays(start, i)));
    const inRange = days.reduce((n, d) => n + (counts.get(d) ?? 0), 0);
    const note = `<p class="activity-note">${plural(inRange, 'change')} in the last ${WEEKS} weeks${state.filter.day ? ` · showing ${esc(shortDate(state.filter.day))}` : ''}</p>`;
    if (state.activityView === 'trend') {
        const weeks = Array.from({ length: WEEKS }, (_, w) => days.slice(w * 7, w * 7 + 7).reduce((n, d) => n + (counts.get(d) ?? 0), 0));
        const max = Math.max(...weeks, 1);
        const bars = weeks.map((n, i) => {
            const h = n ? Math.max(4, n / max * 80) : 2;
            return `<rect class="${n ? '' : 'zero'}" x="${i * 10}" y="${88 - h}" width="7" height="${h}" rx="2"><title>Week of ${esc(shortDate(days[i * 7]))}: ${plural(n, 'change')}</title></rect>`;
        }).join('');
        return `<div class="activity"><svg class="trend" viewBox="0 0 ${WEEKS * 10 - 3} 90" preserveAspectRatio="none" role="img" aria-label="Changes per week">${bars}</svg>${monthsHTML(days)}</div>${note}`;
    }
    const max = Math.max(...counts.values(), 1), t = today();
    const cells = days.map(d => {
        const n = counts.get(d) ?? 0;
        const level = n ? Math.max(1, Math.ceil(n / max * 4)) : 0;
        const label = `${plural(n, 'change')} on ${shortDate(d)}`;
        return `<button class="l${level}${d > t ? ' future' : ''}" data-action="day" data-value="${d}" aria-pressed="${state.filter.day === d}" title="${esc(label)}" aria-label="${esc(label)}"></button>`;
    }).join('');
    return `<div class="activity"><div class="heat">${cells}</div>${monthsHTML(days)}</div>${note}`;
}

function monthsHTML(days) {
    const months = [...new Set(days.filter((_, i) => i % 7 === 0).map(d => d.slice(0, 7)))].slice(1);
    return `<div class="heat-months">${months.map(m => `<span>${parseDay(m + '-01').toLocaleDateString(undefined, { month: 'short' })}</span>`).join('')}</div>`;
}

function mainHTML() {
    const f = state.filter;
    const statusCounts = countBy(state.changes.filter(c => matches(c, 'status')), c => c.status);
    const total = [...statusCounts.values()].reduce((a, b) => a + b, 0);
    const list = state.changes.filter(c => matches(c));
    const site = siteOf(f.site);
    const chips = [
        f.tag && `<button data-action="tag" data-value="${esc(f.tag)}">#${esc(f.tag)} ✕</button>`,
        f.day && `<button data-action="day" data-value="${esc(f.day)}">${esc(shortDate(f.day))} ✕</button>`,
        state.page && `<button data-action="clear-page">${esc(pagePath(state.contexts[f.site]?.pages.find(p => p.id === state.page)?.url ?? ''))} ✕</button>`,
    ].filter(Boolean);
    return `<div class="topbar">
            <button class="secondary small menu-toggle" data-action="menu" aria-label="Open filters">☰</button>
            <h1>Timeline${site ? ` <span>/ ${esc(site.domain ?? site.name)}</span>` : ''}</h1>
            <input id="search" class="search" type="search" placeholder="Search changes, pages, tags…" value="${esc(f.q)}" aria-label="Search changes">
            <button data-action="new-change">+ Log a change</button>
        </div>
        ${site ? metricsHTML() : ''}
        <div class="status-tabs" role="group" aria-label="Status">
            ${[['', 'All', total], ['shipped', 'Shipped'], ['planned', 'Planned'], ['reverted', 'Reverted']].map(([v, label, n]) => `<button data-action="status" data-value="${v}" aria-pressed="${f.status === v}">${label} <span class="count">${n ?? statusCounts.get(v) ?? 0}</span></button>`).join('')}
        </div>
        ${chips.length ? `<div class="active-filters">${chips.join('')}</div>` : ''}
        <div class="timeline">${list.length ? timelineHTML(list) : `<div class="card empty">${state.changes.length ? 'No changes match these filters.' : 'Your first change starts the story. Connect an agent, or log one by hand.'}</div>`}</div>`;
}

function timelineHTML(list) {
    let month = '';
    return list.map(c => {
        const m = c.occurred_at.slice(0, 7);
        const head = m !== month ? `<div class="month">${parseDay(m + '-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>` : '';
        month = m;
        return head + entryHTML(c);
    }).join('');
}

// Paths alone are ambiguous when a site has pages on more than one host (www and bare domain).
const pageLabel = (ctx, p) => {
    const hosts = new Set(ctx.pages.map(x => x.url.replace(/^https?:\/\//, '').split('/')[0]));
    return hosts.size > 1 ? shortURL(p.url) : pagePath(p.url);
};
const pagePath = url => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };
const shortURL = url => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

function entryHTML(c) {
    const open = state.expanded === c.id;
    const pages = pagesOf(c);
    const group = c.group_id ? state.contexts[c.client_id]?.groups.find(g => g.id === c.group_id) : null;
    const where = c.sitewide
        ? `<span>Sitewide · ${esc(domainOf(c.client_id))}</span>`
        : group ? `<span>${esc(group.name)}</span>`
        : pages.slice(0, 2).map(p => `<a href="${esc(p.url)}" target="_blank" rel="noreferrer">${esc(shortURL(p.url))}</a>`).join('') + (pages.length > 2 ? `<span>+${pages.length - 2} more</span>` : '');
    return `<article class="card entry" id="change-${esc(c.id)}">
        ${entryBody(c)}
        <div class="entry-foot">
            <span>${esc(c.author_name)}${c.model ? ` · ${esc(c.model)}` : ''} ${esc(SOURCE_LABELS[c.source] ?? '')}</span>
            ${where}
            <button class="ghost small expand" data-action="expand" data-value="${esc(c.id)}" aria-expanded="${open}" aria-controls="detail-${esc(c.id)}">${open ? 'Hide impact ▴' : 'Impact &amp; details ▾'}</button>
        </div>
        ${open ? `<div class="detail" id="detail-${esc(c.id)}"><p class="muted">Measuring…</p></div>` : ''}
    </article>`;
}

// Shared by the timeline and the public report.
function entryBody(c, { interactive = true } = {}) {
    const tags = c.tags.map(t => interactive
        ? `<button class="tag" data-action="tag" data-value="${esc(t)}" aria-pressed="${state.filter.tag === t}">#${esc(t)}</button>`
        : `<span class="tag">#${esc(t)}</span>`).join('');
    return `<div class="entry-head">
            <span class="avatar${c.author_kind === 'agent' ? ' agent' : ''}" aria-hidden="true">${esc(initials(c.author_name))}</span>
            <time datetime="${esc(c.occurred_at)}" title="${esc(c.occurred_at)}">${esc(interactive ? when(c) : shortDate(c.occurred_at))}</time>
            <span aria-hidden="true">·</span><span>${esc(typeLabel(c.type))}</span>
            <span class="pill ${esc(c.status)}">${esc(c.status)}</span>
        </div>
        <h3>${esc(c.summary)}</h3>
        <p>${esc(c.rationale)}</p>
        ${diffHTML(c.diff)}
        ${tags ? `<div class="tags">${tags}</div>` : ''}`;
}

function diffHTML(diff) {
    if (!diff?.length)
        return '';
    const value = (v, tag) => v === null || v === undefined || v === '' ? '<span class="none">none</span>' : `<${tag}>${esc(v)}</${tag}>`;
    return `<div class="diff">${diff.map(d => `<div class="callout">
        <div class="field">${esc(fieldLabel(d.field))}</div>
        ${value(d.before, 'del')}<span class="arrow" aria-label="changed to">→</span>${value(d.after, 'ins')}
        ${d.note ? `<small>${esc(d.note)}</small>` : ''}
    </div>`).join('')}</div>`;
}

function metricsHTML() {
    const ctx = state.contexts[state.filter.site];
    if (!ctx.properties.length)
        return `<section class="panel metrics"><h2>Performance</h2><p class="muted">No data source for this site yet. Use <button class="ghost small" data-action="google">Connect Google data</button> to pull Search Console and GA4.</p></section>`;
    const markers = state.changes.filter(c => c.client_id === ctx.client.id && (!state.pageChanges || state.pageChanges.has(c.id)));
    return `<section class="panel metrics">
        <div class="row between"><h2>Performance</h2>${ctx.properties.find(p => p.id === state.property)?.mode === 'live' ? '<span class="pill">LIVE · GOOGLE</span>' : '<span class="pill quiet">FIXTURE DATA</span>'}</div>
        <div class="filters">
            <select data-change="property" aria-label="Property">${ctx.properties.map(p => opt(p.id, propertyLabel(p), p.id === state.property)).join('')}</select>
            <select data-change="page" aria-label="Page">${opt('', 'All pages')}${ctx.pages.map(p => opt(p.id, pageLabel(ctx, p), p.id === state.page)).join('')}</select>
            <select data-change="metric" aria-label="Metric">${METRICS.map(m => opt(m, m.replace('_', ' '), m === state.metric)).join('')}</select>
            <select data-change="range" aria-label="Date range">${RANGES.map(([d, label]) => opt(d, label, String(d) === state.range)).join('')}</select>
        </div>
        ${syncWarning(ctx.properties.find(p => p.id === state.property))}
        ${chart(state.metrics, markers)}
        <div class="legend"><span><i class="dot"></i>${esc(state.metric.replace('_', ' '))}</span><span><i class="dot amber"></i>Change logged · select to open</span></div>
    </section>`;
}

function chart(metrics, changes, metric = state.metric) {
    const dates = [...new Set(metrics.map(m => m.date))].sort();
    if (!dates.length)
        return '<div class="empty">No metrics yet. Google data appears a few minutes after a property is connected.</div>';
    const totals = dates.map(d => metrics.filter(m => m.date === d).reduce((s, m) => s + m.value, 0));
    const max = Math.max(...totals, 1), x = i => 40 + i / Math.max(dates.length - 1, 1) * 640, y = v => 165 - v / max * 130;
    const path = totals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const markers = changes.map(c => {
        const i = dates.indexOf(c.occurred_at);
        return i < 0 ? '' : `<circle cx="${x(i)}" cy="${y(totals[i])}" r="5" data-action="marker" data-value="${esc(c.id)}"><title>${esc(c.occurred_at + ' · ' + c.summary)}</title></circle>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 720 205" role="img" aria-label="Daily ${esc(metric)} with change markers">
        <line x1="40" y1="35" x2="680" y2="35"/><line x1="40" y1="100" x2="680" y2="100"/><line x1="40" y1="165" x2="680" y2="165"/>
        <text x="0" y="39">${number(max)}</text><text x="18" y="169">0</text>
        <path d="${path}"/>${markers}
        <text x="40" y="196">${dates[0]}</text><text x="680" y="196" text-anchor="end">${dates.at(-1)}</text>
    </svg>`;
}

function impactHTML(i, c) {
    const scored = i.scored && i.percent !== null;
    const dir = scored ? (i.percent > 0 ? 'up' : i.percent < 0 ? 'down' : '') : '';
    const overlaps = i.overlap_count ?? i.overlaps.length;
    return `<div class="impact-grid">
            <div>BEFORE · ${i.windows.days}D<strong>${number(i.pre)}</strong>${esc(i.windows.pre.start)} → ${esc(i.windows.pre.end)}</div>
            <div>AFTER · ${i.windows.days}D<strong>${number(i.post)}</strong>${esc(i.windows.post.start)} → ${esc(i.windows.post.end)}</div>
            <div class="${dir}">CHANGE<strong>${scored ? (i.percent >= 0 ? '+' : '') + number(i.percent) + '%' : 'Pending'}</strong>${esc(i.confidence)} confidence</div>
        </div>
        ${chart(i.series, [c], i.metric)}
        <p class="impact-note">${esc(i.metric.replace('_', ' '))} · ${scored ? 'Observed change' : 'Awaiting comparable final windows'} · ${i.windows.lag}-day lag${i.control ? ` · Control ${number(i.control.pre)} → ${number(i.control.post)}, adjusted ${number(i.adjustedPercent)} pts` : ''}</p>
        ${overlaps ? `<div class="warning">${plural(overlaps, 'overlapping change')} in the same window, so this is not a clean read.<br>${i.overlaps.map(esc).join('<br>')}</div>` : ''}
        ${i.warnings.length ? `<details><summary>Measurement notes (${i.warnings.length})</summary><p>${i.warnings.map(esc).join('<br>')}</p></details>` : ''}
        <p class="caveat">${esc(i.caveat)} GSC recent days may be revised; query totals exclude anonymized queries.</p>`;
}

async function fillDetail(id, control = '') {
    const box = document.querySelector('#detail-' + CSS.escape(id));
    const c = state.changes.find(x => x.id === id);
    if (!box || !c)
        return;
    const key = id + '|' + control;
    if (!state.impacts[key]) {
        try {
            state.impacts[key] = await api('/v1/impact/' + encodeURIComponent(id) + (control ? '?control=' + encodeURIComponent(control) : ''));
        }
        catch (e) {
            box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
            return;
        }
    }
    const groups = state.contexts[c.client_id]?.groups ?? [];
    const current = document.querySelector('#detail-' + CSS.escape(id));
    if (!current)
        return;
    current.innerHTML = `${impactHTML(state.impacts[key], c)}
        ${groups.length ? `<label>Compare with a control group<select data-change="control" data-id="${esc(id)}">${opt('', 'No control group')}${groups.map(g => opt(g.id, g.name, g.id === control)).join('')}</select></label>` : ''}
        ${c.evidence.length ? `<p class="impact-note">Evidence: ${c.evidence.map(u => `<a href="${esc(u)}" rel="noreferrer" target="_blank">${esc(shortURL(u))}</a>`).join(' · ')}</p>` : ''}
        <div class="detail-actions">
            <button class="secondary small" data-action="edit" data-value="${esc(id)}">Edit</button>
            ${c.status === 'planned' ? `<button class="secondary small" data-action="ship" data-value="${esc(id)}">Mark shipped</button>` : ''}
            ${c.status !== 'reverted' ? `<button class="secondary small" data-action="revert" data-value="${esc(id)}">Revert</button>` : ''}
        </div>`;
}

// One delegated handler for the whole app; elements carry data-action / data-change.
async function handle(e, type) {
    const el = e.target.closest(type === 'click' ? '[data-action]' : '[data-change]');
    if (!el || !root.contains(el))
        return;
    const v = el.dataset.value ?? el.value;
    const f = state.filter;
    try {
        if (type === 'change')
            return await onChange(el.dataset.change, el);
        switch (el.dataset.action) {
            case 'menu':
                state.menuOpen = !state.menuOpen;
                document.querySelector('.shell').classList.toggle('open', state.menuOpen);
                return;
            case 'view':
                state.activityView = v;
                return render();
            case 'site':
                f.site = v;
                state.page = '';
                state.expanded = null;
                state.menuOpen = false;
                await loadMetrics();
                return render();
            case 'tag':
            case 'day':
            case 'status':
                f[el.dataset.action] = f[el.dataset.action] === v ? '' : v;
                state.menuOpen = false;
                return render();
            case 'clear-page':
                state.page = '';
                await loadMetrics();
                return render();
            case 'expand':
                state.expanded = state.expanded === v ? null : v;
                return render();
            case 'marker':
                state.expanded = v;
                f.day = f.status = f.tag = f.q = '';
                render();
                return document.querySelector('#change-' + CSS.escape(v))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            case 'edit':
                return changeForm(state.changes.find(c => c.id === v));
            case 'ship':
            case 'revert':
                await api('/v1/changes/' + encodeURIComponent(v), 'PATCH', { status: el.dataset.action === 'ship' ? 'shipped' : 'reverted' });
                state.impacts = {};
                return await refresh();
            case 'new-change':
                return changeForm();
            case 'agents':
                return await agents();
            case 'share':
                return share();
            case 'tools':
                return tools();
            case 'google':
                return await connectGoogle(f.site || defaultSite());
            case 'retry-sync':
                return await retrySync(v);
        }
    }
    catch (err) {
        toast(err.message);
    }
}

async function onChange(kind, el) {
    if (kind === 'control')
        return fillDetail(el.dataset.id, el.value);
    state[kind] = el.value;
    const ctx = state.contexts[state.filter.site];
    if (kind === 'property')
        state.metric = ctx.properties.find(p => p.id === state.property)?.type === 'ga4' ? 'sessions' : 'clicks';
    if (kind === 'metric') {
        const ga = ['sessions', 'key_events'].includes(state.metric);
        state.property = pickProperty(ctx, ga) ?? state.property;
    }
    await loadMetrics();
    render();
}

function modal(title, html, submit, label = 'Save') {
    const container = document.createElement('div');
    container.className = 'modal';
    container.innerHTML = `<section class="panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="row between"><h2>${esc(title)}</h2><button class="ghost" type="button" data-close>Close</button></div>
        <form id="modal-form">${html}<button>${esc(label)}</button></form></section>`;
    const close = () => { container.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    container.onclick = e => { if (e.target === container || e.target.closest('[data-close]')) close(); };
    document.addEventListener('keydown', onKey);
    document.body.append(container);
    container.querySelector('input,select,textarea')?.focus();
    container.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const button = e.target.querySelector(':scope > button:last-child');
        button.disabled = true;
        try {
            const fd = new FormData(e.target);
            await submit(Object.fromEntries(fd), fd);
            close();
        }
        catch (err) {
            toast(err.message);
        }
        finally {
            button.disabled = false;
        }
    };
    return container;
}

// A dialog without a form, for read-only content.
function sheet(title, html) {
    const container = document.createElement('div');
    container.className = 'modal';
    container.innerHTML = `<section class="panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="row between"><h2>${esc(title)}</h2><button class="ghost" type="button" data-close>Close</button></div>${html}</section>`;
    const close = () => { container.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    container.onclick = e => { if (e.target === container || e.target.closest('[data-close]')) close(); };
    document.addEventListener('keydown', onKey);
    document.body.append(container);
    return container;
}

const input = (name, label, type = 'text', value = '', required = true) => `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''}></label>`;
const siteSelect = (selected, name = 'site') => `<label>Site<select name="${name}">${state.sites.map(s => opt(s.id, s.domain ?? s.name, s.id === selected)).join('')}</select></label>`;
const defaultSite = () => state.filter.site || state.sites[0]?.id;
const scopeOptions = (ctx, selected) => opt('sitewide', 'Sitewide', selected === 'sitewide')
    + ctx.pages.map(p => opt(p.id, pageLabel(ctx, p), p.id === selected)).join('')
    + ctx.groups.map(g => opt('group:' + g.id, 'Group · ' + g.name, 'group:' + g.id === selected)).join('');

function changeForm(existing) {
    const c = existing ?? {};
    let site = c.client_id ?? defaultSite();
    if (!site)
        return toast('Add a site first.');
    const ctx = () => state.contexts[site];
    const scopeValue = c.sitewide ? 'sitewide' : c.group_id ? 'group:' + c.group_id : c.page_ids?.[0] ?? ctx().pages[0]?.id ?? 'sitewide';
    const box = modal(existing ? 'Edit change' : 'Log a change', `<div class="form-grid">
        ${existing ? '' : siteSelect(site)}
        <label>Scope<select name="scope">${scopeOptions(ctx(), scopeValue)}</select></label>
        ${input('occurred_at', 'Date', 'date', c.occurred_at ?? today())}
        <label>Status<select name="status">${['shipped', 'planned', 'reverted'].map(t => opt(t, t, t === (c.status ?? 'shipped'))).join('')}</select></label>
        <label>Change type<select name="type">${TYPES.map(t => opt(t, typeLabel(t), t === (c.type ?? 'content'))).join('')}</select></label>
        <label>Expected metric<select name="expected_metric">${METRICS.map(m => opt(m, m.replace('_', ' '), m === (c.expected_metric ?? 'clicks'))).join('')}</select></label>
        <label class="wide">What changed?<input name="summary" required maxlength="500" value="${esc(c.summary ?? '')}"></label>
        <label class="wide">Why? Hypothesis<textarea name="rationale" required>${esc(c.rationale ?? '')}</textarea></label>
        ${existing ? '' : `<label>Field changed (optional)<select name="field">${opt('', '—')}${FIELDS.map(x => opt(x, fieldLabel(x))).join('')}</select></label>
        <span></span>
        ${input('before', 'Old value', 'text', '', false)}
        ${input('after', 'New value', 'text', '', false)}`}
        ${input('tags', 'Tags (comma separated)', 'text', (c.tags ?? []).join(', '), false)}
        ${input('evidence', 'Evidence link (optional)', 'url', c.evidence?.[0] ?? '', false)}
    </div>`, async (b) => {
        const data = {
            client_id: site,
            occurred_at: b.occurred_at,
            timezone: ctx().client.timezone,
            status: b.status,
            type: b.type,
            summary: b.summary,
            rationale: b.rationale,
            expected_metric: b.expected_metric,
            evidence: b.evidence ? [b.evidence] : [],
            tags: [...new Set(b.tags.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean))],
            sitewide: b.scope === 'sitewide',
            page_ids: b.scope === 'sitewide' || b.scope.startsWith('group:') ? [] : [b.scope],
            group_id: b.scope.startsWith('group:') ? b.scope.slice(6) : null,
        };
        if (existing) {
            delete data.client_id;
            await api('/v1/changes/' + encodeURIComponent(c.id), 'PATCH', data);
            delete state.impacts[c.id + '|'];
        }
        else {
            if (b.field)
                data.diff = [{ field: b.field, before: b.before || null, after: b.after || null }];
            await api('/v1/changes', 'POST', data);
        }
        await refresh();
    });
    box.querySelector('[name=site]')?.addEventListener('change', e => {
        site = e.target.value;
        box.querySelector('[name=scope]').innerHTML = scopeOptions(ctx(), ctx().pages[0]?.id ?? 'sitewide');
    });
}

function tools() {
    const box = sheet('Imports & data', `<p class="muted">Agents usually create sites and pages for you when they log a change. Google data syncs daily; new pages get their history pulled automatically.</p>
        <form>${siteSelect(defaultSite())}</form>
        <div class="tools">
            <button class="wide" data-tool="google">Connect Google data (Search Console + GA4)</button>
            <button class="secondary" data-tool="sync">↻ Sync last 7 days</button>
            <button class="secondary" data-tool="backfill">↻ Backfill 16 months</button>
            <button class="secondary" data-tool="upload">↑ Upload CSV</button>
            ${state.me.auth === 'local' ? '<button class="secondary" data-tool="property">+ Connect fixture property</button>' : ''}
            <button class="secondary" data-tool="page">+ Add page</button>
            <button class="secondary" data-tool="group">+ Create page group</button>
            <button class="secondary" data-tool="site">+ Add site</button>
            <button class="secondary" data-tool="agent">+ Connect an agent</button>
        </div>`);
    box.querySelectorAll('[data-tool]').forEach(b => b.onclick = async () => {
        const site = box.querySelector('[name=site]').value;
        box.remove();
        try {
            await ({ google: () => connectGoogle(site), sync: () => sync(site, false), backfill: () => sync(site, true), upload: () => upload(site), property: () => addProperty(site), page: () => addPage(site), group: () => addGroup(site), site: addSite, agent: newAgent })[b.dataset.tool]();
        }
        catch (e) {
            toast(e.message);
        }
    });
}

async function sync(site, backfill) {
    const props = state.contexts[site].properties.filter(p => ['gsc_domain', 'gsc_url_prefix', 'ga4'].includes(p.type));
    if (!props.length)
        return toast('Connect a property first.');
    let queued = 0;
    for (const p of props)
        queued += (await api(`/v1/properties/${encodeURIComponent(p.id)}/sync${backfill ? '?backfill=true' : ''}`, 'POST')).queued;
    toast(`${queued} sync jobs queued. Refresh shortly to view results.`);
}

function upload(site) {
    modal('Import a CSV', `<label>Import type<select name="kind">${opt('metrics', 'Daily metrics')}${opt('changes', 'Past changes')}</select></label>
        <label>CSV file<input name="file" type="file" accept=".csv,text/csv" required></label>
        <p class="muted">Use the examples in fixtures/. Maximum 1 MB / 5,000 rows. Raw uploads are stored in R2 and parsed by the queue.</p>`, async (b) => {
        const r = await api(`/v1/${b.kind}/import?client=${encodeURIComponent(site)}`, 'POST', await b.file.text(), true);
        toast('Import queued: ' + r.id);
        pollImport(r.id);
    }, 'Upload');
}

async function pollImport(id) {
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const j = await api('/v1/imports/' + id);
        if (j.status === 'completed') {
            toast(`${j.row_count} rows imported.`);
            await refresh();
            return;
        }
        if (j.status === 'failed') {
            toast('Import failed: ' + j.error);
            return;
        }
    }
    toast('Import is still queued. Check /v1/imports/' + id);
}

/** The last live sync's Google error, with a link to the console page it names and a retry. */
function syncWarning(p) {
    if (!p?.last_sync_error)
        return '';
    const link = p.last_sync_error.match(/https:\/\/console\.(?:cloud|developers)\.google\.com\/[^\s"'<>]*/)?.[0]?.replace(/[.,;)]+$/, '');
    return `<div class="warning sync-error">
        <span><strong>Last sync failed${p.last_sync_at ? ' · ' + esc(shortDate(p.last_sync_at.slice(0, 10))) : ''}:</strong> ${esc(p.last_sync_error)}</span>
        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open in Google Cloud</a>` : ''}
        <button class="secondary small" type="button" data-action="retry-sync" data-value="${esc(p.id)}">Retry backfill</button>
    </div>`;
}

async function retrySync(id) {
    const r = await api(`/v1/properties/${encodeURIComponent(id)}/sync?backfill=true`, 'POST');
    toast(`${r.queued} backfill jobs queued. Refresh in a few minutes.`);
}

const propertyLabel = p => ({ gsc_domain: 'Search Console', gsc_url_prefix: 'Search Console', ga4: 'GA4' }[p.type] ?? p.type) + ' · ' + p.external_id + (p.mode === 'live' ? '' : ' (fixture)');

async function connectGoogle(site) {
    const ctx = state.contexts[site];
    const g = await api('/v1/google');
    const connected = ctx.properties.length ? `<div class="connected"><div class="nav-title">Connected to ${esc(ctx.client.domain)}</div>${ctx.properties.map(p => `<div class="row between">
        <span>${esc(propertyLabel(p))}</span><button class="secondary small" type="button" data-remove="${esc(p.id)}">Remove</button></div>${syncWarning(p)}`).join('')}</div>` : '';
    const bindRemove = box => {
        box.querySelectorAll('[data-action="retry-sync"]').forEach(b => b.onclick = async (e) => {
            e.stopPropagation();
            try {
                await retrySync(b.dataset.value);
                b.disabled = true;
            }
            catch (err) {
                toast(err.message);
            }
        });
        bindRemoveButtons(box);
    };
    const bindRemoveButtons = box => box.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
        if (!confirm('Remove this property and its stored metrics?'))
            return;
        try {
            await api('/v1/properties/' + encodeURIComponent(b.dataset.remove), 'DELETE');
            box.remove();
            await refresh();
            await connectGoogle(site);
        }
        catch (e) {
            toast(e.message);
        }
    });
    if (!g.configured) {
        const box = sheet('Connect Google data', `<p>This notebook reads Search Console and GA4 with a Google service account. Its JSON key is stored as a Worker secret, never in the database.</p>
            <ol class="steps">
                <li>In Google Cloud, enable the <strong>Search Console API</strong>, <strong>Google Analytics Data API</strong> and (for the pick list) <strong>Google Analytics Admin API</strong>.</li>
                <li>Store the key as a secret, then reload this page:<pre>npx wrangler secret put GOOGLE_SERVICE_ACCOUNT &lt; service-account.json</pre>
                Running locally? Add it to <code>.dev.vars</code> as one line: <code>GOOGLE_SERVICE_ACCOUNT='…'</code> (<code>jq -c . service-account.json</code> prints it).</li>
            </ol>${connected}`);
        bindRemove(box);
        return;
    }
    const domain = ctx.client.domain;
    const have = new Set(ctx.properties.filter(p => p.mode === 'live').map(p => p.external_id));
    const matchesSite = url => url === 'sc-domain:' + domain || (() => { try { return siteDomainOf(url) === domain; } catch { return false; } })();
    const gscOptions = g.gsc.filter(x => !have.has(x.siteUrl));
    const suggested = gscOptions.find(x => x.siteUrl === 'sc-domain:' + domain) ?? gscOptions.find(x => matchesSite(x.siteUrl));
    const ga4Options = g.ga4.filter(x => !have.has(x.id));
    const box = modal('Connect Google data · ' + domain, `<p class="muted">Give the service account read access, then pick the properties for this site.
            Search Console: <em>Settings → Users and permissions → Add user</em> (Restricted is enough). GA4: <em>Admin → Property access management</em> (Viewer).</p>
        <label>Service account<pre id="sa-email">${esc(g.email)}</pre></label>
        <button class="secondary small" type="button" data-copy="sa-email">Copy email</button>
        <label>Search Console property<select name="gsc">${opt('', gscOptions.length ? 'Don’t connect' : 'None visible to the service account yet')}${gscOptions.map(x => opt(x.siteUrl, x.siteUrl, x === suggested)).join('')}</select></label>
        ${g.errors.gsc ? `<div class="warning">Search Console: ${esc(g.errors.gsc)}</div>` : ''}
        ${ga4Options.length ? `<label>GA4 property<select name="ga4">${opt('', 'Don’t connect')}${ga4Options.map(x => opt(x.id, `${x.name} · ${x.account} (${x.id})`)).join('')}</select></label>` : ''}
        <label>${ga4Options.length ? 'Or enter a GA4 property ID' : 'GA4 property ID (optional)'}<input name="ga4_id" inputmode="numeric" pattern="[0-9]+" placeholder="e.g. 312345678"></label>
        ${g.errors.ga4 ? `<div class="warning">GA4 list unavailable: ${esc(g.errors.ga4)} You can still enter the property ID.</div>` : ''}
        <p class="muted">Connecting pulls 16 months of history for this site’s pages. GA4 numbers are Organic Search sessions and key events by landing page.</p>
        ${connected}`, async (b) => {
        const picks = [];
        if (b.gsc)
            picks.push({ type: b.gsc.startsWith('sc-domain:') ? 'gsc_domain' : 'gsc_url_prefix', external_id: b.gsc });
        const ga4 = (b.ga4_id || b.ga4 || '').trim();
        if (ga4)
            picks.push({ type: 'ga4', external_id: ga4 });
        if (!picks.length)
            throw new Error('Pick a Search Console or GA4 property.');
        let queued = 0;
        for (const p of picks)
            queued += (await api('/v1/properties', 'POST', { client_id: site, ...p, mode: 'live', auth_type: 'service_account' })).queued;
        toast(`Connected. ${queued} history jobs queued; data appears over the next few minutes.`);
        await refresh();
    }, 'Connect');
    box.querySelector('[data-copy]').onclick = async (e) => {
        await navigator.clipboard.writeText(g.email);
        e.target.textContent = 'Copied';
    };
    bindRemove(box);
}

const siteDomainOf = url => new URL(url).hostname.toLowerCase().replace(/^www\./, '');

function addPage(site) {
    modal('Add a page', input('url', 'Page URL', 'url') + input('canonical', 'Canonical URL (optional)', 'url', '', false), async (b) => {
        await api('/v1/pages', 'POST', { client_id: site, url: b.url, ...(b.canonical ? { canonical: b.canonical } : {}) });
        await refresh();
    });
}

function addProperty(site) {
    modal('Connect a fixture property', `<label>Type<select name="type">${['gsc_domain', 'gsc_url_prefix', 'ga4', 'custom'].map(t => opt(t, t)).join('')}</select></label>
        ${input('external_id', 'External ID (fictional)')}
        <label>Mock auth flow<select name="auth_type">${opt('oauth', 'OAuth fixture')}${opt('service_account', 'Service-account fixture')}</select></label>`, async (b) => {
        await api('/v1/properties', 'POST', { client_id: site, ...b });
        await refresh();
    });
}

function addGroup(site) {
    const pages = state.contexts[site].pages;
    if (!pages.length)
        return toast('Add a page first.');
    modal('Create a page group', input('name', 'Group name') + `<fieldset class="form-grid"><legend class="muted">Pages</legend>${pages.map(p => `<label class="row"><input type="checkbox" name="page" value="${esc(p.id)}">${esc(pageLabel(state.contexts[site], p))}</label>`).join('')}</fieldset>`, async (b, fd) => {
        const ids = fd.getAll('page');
        if (!ids.length)
            throw new Error('Pick at least one page.');
        await api('/v1/groups', 'POST', { client_id: site, name: b.name, page_ids: ids });
        await refresh();
    });
}

function share() {
    const site = defaultSite();
    if (!site)
        return toast('Add a site first.');
    modal('Create a read-only report', siteSelect(site)
        + input('title', 'Report title', 'text', domainOf(site) + ' · Progress report')
        + `<div class="form-grid">${input('since', 'From', 'date', iso(addDays(new Date(), -90)))}${input('until', 'Through', 'date', today())}</div>`, async (b) => {
        const r = await api('/v1/reports', 'POST', { client_id: b.site, title: b.title, since: b.since, until: b.until });
        setTimeout(() => sheet('Your read-only report', `<p>Anyone with this link can read this site’s changes for the selected period. It is shown once.</p>
            <p><a href="${esc(r.url)}" target="_blank">${esc(location.origin + r.url)}</a></p>
            <p><a href="/public${esc(r.url)}/export.csv">Download CSV</a></p>`), 0);
    }, 'Create link');
}

function addSite() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const box = modal('Add a site', input('domain', 'Domain', 'text', '') + input('timezone', 'Reporting timezone', 'text', zone), async (b) => {
        const c = await api('/v1/clients', 'POST', b);
        state.filter.site = c.id;
        state.started = true;
        await refresh();
    });
    box.querySelector('[name=domain]').placeholder = 'example.com';
}

async function agents() {
    const list = await api('/v1/agents');
    const rows = list.map(a => `<tr><td>${esc(a.name)}</td><td>${esc(a.model ?? '')}</td>
        <td>${a.revoked ? '<span class="pill reverted">revoked</span>' : `<button class="secondary small" data-revoke="${esc(a.id)}">Revoke</button>`}</td></tr>`).join('');
    const box = sheet('Agents', `<p class="muted">Each agent has its own token, so its changes are attributed to it and it can be revoked on its own.</p>
        ${list.length ? `<table class="agents"><thead><tr><th>Agent</th><th>Model / tool</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No agents connected yet.</div>'}
        <button id="connect-agent">+ Connect an agent</button>`);
    box.querySelector('#connect-agent').onclick = () => { box.remove(); newAgent(); };
    box.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
        try {
            await api('/v1/agents/' + b.dataset.revoke, 'DELETE');
            box.remove();
            await agents();
            await refresh();
        }
        catch (e) {
            toast(e.message);
        }
    });
}

function newAgent() {
    const box = modal('Connect an agent', input('name', 'Agent name', 'text', '') + input('model', 'Model / tool (optional)', 'text', '', false), async (b) => {
        const a = await api('/v1/agents', 'POST', { name: b.name, ...(b.model ? { model: b.model } : {}), scopes: ['write:changes', 'read:metrics'] });
        setTimeout(() => agentSetup(b.name, a.token), 0);
        if (state.sites.length)
            await refresh();
    }, 'Create token');
    box.querySelector('[name=name]').placeholder = 'e.g. Claude Code · brightwax-site repo';
}

function agentSetup(name, token) {
    const url = location.origin + '/mcp';
    const claude = `claude mcp add --transport http seo-notebook ${url} --header "Authorization: Bearer ${token}"`;
    const json = JSON.stringify({ mcpServers: { 'seo-notebook': { url, headers: { Authorization: 'Bearer ' + token } } } }, null, 2);
    const rule = 'After you change any page on a website (titles, meta descriptions, headings, content, schema, redirects, links), call the seo-notebook log_change tool with the page URL, a one-line summary, why you made the change, and the old and new value of each field you changed.';
    const block = (id, label, text) => `<label>${esc(label)}<pre id="${id}">${esc(text)}</pre></label><button class="secondary small" type="button" data-copy="${id}">Copy</button>`;
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

const brandHTML = (extra = '') => `<div class="page-head"><a class="brand" href="/"><span class="logo">N</span>SEO Notebook</a>${extra}</div>`;

function signedOut(e) {
    root.innerHTML = `<div class="page">${brandHTML()}<section class="panel welcome">
        <div class="eyebrow">Not signed in</div>
        <h1>Open your notebook through its sign-in URL.</h1>
        <p class="muted">${esc(e.message)}. Use this notebook’s Cloudflare Access URL, or run it locally with <code>npm run dev</code>.</p>
    </section></div>`;
}

function welcome() {
    root.innerHTML = `<div class="page">${brandHTML(state.me.auth === 'access' ? '<a class="button secondary small" href="/cdn-cgi/access/logout">Sign out</a>' : '<span class="pill quiet">LOCAL</span>')}
        <section class="panel welcome">
        <h1>Let your agents keep the log.</h1>
        <p class="muted">Connect the AI agents that edit your sites. Every time one changes a title, meta description or page content,
        it records what changed and why here, so you can see the before and after in Search Console and Analytics.</p>
        <ol>
            <li><strong>Connect an agent.</strong> You get a token and a copy-paste MCP config.</li>
            <li><strong>Tell it to log its changes.</strong> We give you a one-line instruction for its project rules.</li>
            <li><strong>Watch the notebook fill in.</strong> Sites and pages are created from the URLs it sends.</li>
        </ol>
        <div class="row"><button data-welcome="agent">+ Connect an agent</button><button class="secondary" data-welcome="site">Add a site manually</button></div>
    </section></div>`;
    root.querySelector('[data-welcome=agent]').onclick = newAgent;
    root.querySelector('[data-welcome=site]').onclick = addSite;
}

async function report() {
    const token = location.pathname.split('/')[2];
    try {
        const r = await api('/public/reports/' + encodeURIComponent(token));
        const shipped = r.changes.filter(x => x.change.status === 'shipped').length;
        root.innerHTML = `<div class="page">${brandHTML('<span class="pill quiet">READ-ONLY REPORT</span>')}
            <header class="report-hero">
                <div class="eyebrow">${esc(r.client)}</div>
                <h1>${esc(r.title)}</h1>
                <p class="muted">${esc(shortDate(r.since))} – ${esc(shortDate(r.until))} · ${plural(r.changes.length, 'change')}, ${shipped} shipped</p>
                <a class="button secondary small" href="/public/reports/${encodeURIComponent(token)}/export.csv">↓ Export CSV</a>
            </header>
            <div class="report-list">${r.changes.map(({ change: c, impact: i }) => `<article class="card entry">
                ${entryBody(c, { interactive: false })}
                <div class="detail">${impactHTML(i, c)}</div>
                <div class="entry-foot"><span>${esc(c.author_name)}${c.model ? ` · ${esc(c.model)}` : ''}</span></div>
            </article>`).join('') || '<div class="card empty">No changes in this period.</div>'}</div>
            <p class="page-foot">Made with SEO Notebook · Observations, not attribution.</p>
        </div>`;
    }
    catch (e) {
        root.innerHTML = `<div class="page">${brandHTML()}<p class="error">${esc(e.message)}</p></div>`;
    }
}

boot();
