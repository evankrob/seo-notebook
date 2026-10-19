// Shown to browsers when a deployed notebook has no Cloudflare Access configuration yet.
// Static on purpose: it reads nothing from the database and needs no identity.

export const SETUP_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const README = 'https://github.com/evankrob/seo-notebook#after-you-deploy';

const escape = (s: string) => s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

export function setupPage(host: string): string {
    const h = escape(host);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Finish setting up SEO Notebook</title>
<style>
body { font: 16px/1.55 system-ui, -apple-system, sans-serif; color: #1f2328; background: #f6f7f9; margin: 0; padding: 32px 16px; }
main { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 28px; }
h1 { font-size: 22px; margin: 0 0 8px; }
code { background: #f0f2f5; padding: 1px 5px; border-radius: 4px; font-size: 14px; }
li { margin: 8px 0; }
a { color: #0b5cad; }
.note { color: #57606a; font-size: 14px; }
@media (prefers-color-scheme: dark) {
  body { color: #e6e8eb; background: #111317; }
  main { background: #1a1d22; border-color: #2c3038; }
  code { background: #262a31; }
  a { color: #6cb6ff; }
  .note { color: #9aa4af; }
}
</style>
</head>
<body>
<main>
<h1>Almost there: protect this notebook with Cloudflare Access</h1>
<p>SEO Notebook is deployed, but it does not open to anyone until Cloudflare Access decides who may use it. Nothing in the notebook is reachable from this page.</p>
<ol>
<li>In Cloudflare Zero Trust → Access → Applications, add a <strong>self-hosted application</strong> for <code>${h}</code> with an Allow policy listing the people who may use the notebook.</li>
<li>Add a second application for <code>${h}</code> with path <code>mcp</code> and a <strong>Bypass</strong> policy, so AI agents can connect with their own bearer tokens.</li>
<li>Set the Worker variables <code>ACCESS_TEAM_DOMAIN</code> (e.g. <code>yourteam.cloudflareaccess.com</code>) and <code>ACCESS_AUD</code> (the first application's <em>Application Audience (AUD) Tag</em>) in your repository's <code>wrangler.toml</code>, then deploy again.</li>
<li>Optional: add the <code>GOOGLE_SERVICE_ACCOUNT</code> secret to chart Search Console and GA4 data.</li>
</ol>
<p>Step-by-step instructions: <a href="${README}">After you deploy</a>.</p>
<p class="note">Running locally? Open <code>http://localhost:8787</code> instead; loopback requests work without Access.</p>
</main>
</body>
</html>
`;
}
