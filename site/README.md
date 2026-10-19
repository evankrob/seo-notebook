# SEO Notebook marketing site

Static [Astro](https://astro.build) site for [seonotebook.dev](https://seonotebook.dev), served by Cloudflare Workers static assets. Separate from the notebook Worker at the repository root.

```sh
cd site
npm ci
npm run dev       # http://localhost:4321
npm run deploy    # astro build && wrangler deploy (Worker: seo-notebook-site)
```

The share preview `public/og.png` is rendered from `og/card.html`: edit the HTML, then run `node og/render.mjs` (needs Chrome; set `CHROME` if it isn't in the macOS default location).
