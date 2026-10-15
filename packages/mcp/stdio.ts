import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { changeSchema } from '../../apps/api/src/service';
const base = process.env.NOTEBOOK_URL ?? 'http://localhost:8787';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
    throw new Error('Local stdio bridge requires a loopback Wrangler URL');
const token = process.env.NOTEBOOK_TOKEN;
if (!token)
    throw new Error('Set NOTEBOOK_TOKEN');
async function api(path: string, method = 'GET', data?: unknown, key?: string) { const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: data ? JSON.stringify(data) : undefined }); const body = await r.text(); return { isError: !r.ok, content: [{ type: 'text' as const, text: body }] }; }
const server = new McpServer({ name: 'seo-notebook-local', version: '0.1.0' });
server.registerTool('log_change', { inputSchema: { ...changeSchema.shape, idempotency_key: z.string().optional() } }, async ({ idempotency_key, ...data }) => api('/v1/changes', 'POST', data, idempotency_key));
server.registerTool('list_changes', { inputSchema: { client: z.string().optional(), url: z.string().optional(), since: z.string().optional() } }, async (q) => api('/v1/changes?' + new URLSearchParams(Object.entries(q).filter((v): v is [
    string,
    string
] => v[1] !== undefined)).toString()));
server.registerTool('get_impact', { inputSchema: { change_id: z.string(), control: z.string().optional() } }, async ({ change_id, control }) => api('/v1/impact/' + encodeURIComponent(change_id) + (control ? '?control=' + encodeURIComponent(control) : '')));
await server.connect(new StdioServerTransport());
