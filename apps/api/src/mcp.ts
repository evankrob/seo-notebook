import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { changeInputSchema, changeSchema, getImpact, listChanges, listSites, logChange, updateChange } from './service';
import type { Actor, Env } from './types';

const LOG_CHANGE = `Record an SEO or content change you made to a website, right after you make it.
Send the page URL(s) you changed in "url" or "urls"; the site and pages are created automatically from the domain. For a sitewide change send "site" (e.g. "example.com") with "sitewide": true.
Required: "summary" (what changed, one line) and "rationale" (why: the hypothesis).
Include "diff" with the old and new value of each field you edited, e.g. [{"field":"title","before":"Old title","after":"New title"}]. Fields: title, meta_description, h1, headings, content, canonical, robots, schema, redirect, internal_links, images, url, other. Excerpt long content (max 5000 chars per value).
Optional: occurred_at (YYYY-MM-DD, defaults to today in "timezone", default UTC), status (shipped by default; use planned before deploying), type (inferred from diff), expected_metric (clicks by default), evidence (URLs such as the PR or commit), tags.
Pass the same idempotency_key when retrying so the change is not recorded twice.`;

const c = changeSchema.shape;

export async function mcp(request: Request, env: Env, actor: Actor) {
    const server = new McpServer({ name: 'seo-notebook', version: '0.2.0' });
    const wrap = (fn: () => Promise<unknown>) => fn()
        .then(r => ({ content: [{ type: 'text' as const, text: JSON.stringify(r) }] }))
        .catch(e => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof z.ZodError ? e.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ') : e.message }] }));
    server.registerTool('log_change', { description: LOG_CHANGE, inputSchema: { ...changeInputSchema.shape, idempotency_key: z.string().max(200).optional() } }, async ({ idempotency_key, ...args }) => wrap(() => logChange(env, actor, args, idempotency_key, 'mcp')));
    server.registerTool('update_change', {
        description: 'Update a change you logged: mark a planned change as shipped once it is live, mark it reverted if it was undone, or correct its details. Only send the fields that change.',
        // No defaults here: the SDK applies them, and a default would overwrite the stored value.
        inputSchema: { change_id: z.string(), status: c.status.unwrap().optional(), occurred_at: c.occurred_at.optional(), summary: c.summary.optional(), rationale: c.rationale.optional(), type: c.type.optional(), diff: c.diff.unwrap().optional(), evidence: c.evidence.unwrap().optional(), tags: c.tags.unwrap().optional(), expected_metric: c.expected_metric.unwrap().optional() },
    }, async ({ change_id, ...patch }) => wrap(() => updateChange(env, actor, change_id, patch)));
    server.registerTool('list_sites', { description: 'List the sites in this notebook with page and change counts and the date of the latest change.', inputSchema: {} }, async () => wrap(() => listSites(env, actor)));
    server.registerTool('list_changes', {
        description: 'List recorded changes, newest first. Check this before editing a page to see recent or competing work. Filter by site domain, page URL, or date range (YYYY-MM-DD).',
        inputSchema: { site: z.string().optional(), url: z.string().optional(), since: z.string().optional(), until: z.string().optional() },
    }, async (args) => wrap(() => listChanges(env, actor, args)));
    server.registerTool('get_impact', {
        description: 'Before/after metrics for one change (default 28 days each side, skipping 3 days after the change), with a confidence label and caveats. Results stay inconclusive until both windows have final data. Report the caveats; this is not proof of causation.',
        inputSchema: { change_id: z.string(), control: z.string().optional(), property: z.string().optional(), metric: z.string().optional(), days: z.number().int().optional(), lag: z.number().int().optional() },
    }, async ({ change_id, days, lag, ...q }) => wrap(() => getImpact(env, actor, change_id, { ...q, days: days?.toString(), lag: lag?.toString() })));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
}
