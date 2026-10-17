// usage: node wrap.mjs <workerEntry> <assetsDir> <spa:0|1> <workerFirstPrefixes(comma) or "*"> <out>
import fs from 'fs'; import path from 'path';
const [entry, dir, spa, wf, out] = process.argv.slice(2);
const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.txt':'text/plain','.webmanifest':'application/manifest+json'};
const assets = {};
const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d,f); if (fs.statSync(p).isDirectory()) walk(p); else if (!f.startsWith('.')) assets['/'+path.relative(dir,p)] = [types[path.extname(f)]||'application/octet-stream', fs.readFileSync(p).toString('base64')]; } };
walk(dir);
const src = `import worker from ${JSON.stringify(path.resolve(entry))};
const A = ${JSON.stringify(assets)};
const SPA = ${spa==='1'}; const WF = ${JSON.stringify(wf)};
const dec = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
function serve(req) { const u = new URL(req.url); let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
  let a = A[p] || A[p + '.html'] || A[p + '/index.html']; let status = 200;
  if (!a) { if (SPA) a = A['/index.html']; else return new Response('Not found', {status:404}); }
  const h = {'content-type': a[0]}; if (p.startsWith('/assets/')) h['cache-control'] = 'public, max-age=31536000, immutable'; else h['cache-control'] = 'no-cache';
  return new Response(req.method === 'HEAD' ? null : dec(a[1]), {status, headers: h}); }
const ASSETS = { fetch: (input, init) => serve(input instanceof Request ? input : new Request(input, init)) };
const withA = env => ({ ...env, ASSETS });
export default {
  fetch(req, env, ctx) { const p = new URL(req.url).pathname;
    if (WF === '*' || WF.split(',').some(x => p === x || p.startsWith(x.endsWith('*') ? x.slice(0,-1) : x + '/'))) return worker.fetch(req, withA(env), ctx);
    const r = serve(req); if (r.status === 404) return worker.fetch(req, withA(env), ctx); return r; },
  ...(worker.queue ? { queue: (b, env, ctx) => worker.queue(b, withA(env), ctx) } : {}),
  ...(worker.scheduled ? { scheduled: (e, env, ctx) => worker.scheduled(e, withA(env), ctx) } : {}),
};`;
fs.writeFileSync(out + '.entry.mjs', src);
