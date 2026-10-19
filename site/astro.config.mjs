import { defineConfig } from 'astro/config';

// Fully static: the build is plain HTML and CSS served by Workers static assets.
export default defineConfig({
    site: 'https://www.seonotebook.dev',
    build: { inlineStylesheets: 'always' },
});
