# SEO Notebook marketing site

Static [Astro](https://astro.build) site, served by Cloudflare Workers static assets. Separate from the notebook Worker at the repository root.

```sh
cd site
npm ci
npm run dev       # http://localhost:4321
npm run deploy    # astro build && wrangler deploy (Worker: seo-notebook-site)
```
