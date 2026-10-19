# Security policy

SEO Notebook is self-hosted: each deployment runs in its owner's Cloudflare account, and there is no hosted service. Security fixes land on `main`; deploy the latest `main` to pick them up.

## Reporting a vulnerability

Please report vulnerabilities privately, not in public issues or pull requests:

1. Open [Report a vulnerability](https://github.com/evankrob/seo-notebook/security/advisories/new) (the repository's **Security** tab → **Advisories** → **Report a vulnerability**).
2. Describe the issue, the affected version or commit, and steps to reproduce. A proof of concept against a local `npm run dev` instance is ideal; please don't test against notebooks you don't own.

You should hear back within a week. We'll agree on a fix and a disclosure date with you, and credit you in the advisory unless you prefer otherwise.

## Scope

Especially interesting:

- Reading or changing another workspace's data (tenant isolation).
- Getting into a notebook without a valid Cloudflare Access JWT or agent token, including via forged identity headers, the loopback local mode, or the `/mcp` bypass path.
- Agent tokens doing more than their scopes allow, or setting author fields.
- Server-side request forgery through redirect following or Google connectors.
- Leaking the `GOOGLE_SERVICE_ACCOUNT` secret or report-link tokens.

Out of scope: misconfigured Cloudflare Access policies on a particular deployment, the fictional demo token in `fixtures/seed.sql` (it is public on purpose and must never be loaded into a deployed notebook), and denial of service against your own deployment.
