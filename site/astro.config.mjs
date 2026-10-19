import { defineConfig } from 'astro/config';

// Fully static: the build is plain HTML and CSS served by Workers static assets.
export default defineConfig({
    build: { inlineStylesheets: 'always' },
});
