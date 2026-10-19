// Sends www to the bare domain (301, path and query kept); everything else is the static site.
const CANONICAL_HOST = 'seonotebook.dev';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.hostname === 'www.seonotebook.dev') {
            url.hostname = CANONICAL_HOST;
            return Response.redirect(url.toString(), 301);
        }
        return env.ASSETS.fetch(request);
    },
};
