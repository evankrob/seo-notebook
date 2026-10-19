// Agents often log the URL they typed (bare domain, http, old slug) while Search Console
// reports the URL it ends up on. Follow redirects to find that URL, safely and briefly.

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 3000;

/** Public http(s) hosts on default ports only: no loopback, private, link-local or internal names. */
export function isPublicURL(u: URL): boolean {
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port)
        return false;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!h.includes('.') && !h.includes(':'))
        return false;
    if (h === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(h))
        return false;
    const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
    }
    if (h.includes(':'))
        return !(h === '::' || h === '::1' || h.startsWith('::ffff:') || /^f[cd]/.test(h) || /^fe[89ab]/.test(h));
    return true;
}

async function hop(url: string, method: 'HEAD' | 'GET', signal: AbortSignal) {
    const r = await fetch(url, { method, redirect: 'manual', signal, headers: { 'User-Agent': 'SEO-Notebook (+redirect check)' } });
    // Only the status and Location matter; drop any body without waiting on it.
    r.body?.cancel().catch(() => undefined);
    return r;
}

/**
 * The URL `url` finally lands on after HTTP redirects (HEAD, falling back to GET when HEAD is
 * refused). Never throws: on any failure, timeout, loop or non-public hop it returns the last
 * public URL reached, which is `url` itself when nothing could be fetched.
 */
export async function followRedirects(url: string): Promise<string> {
    let current: URL;
    try {
        current = new URL(url);
    }
    catch {
        return url;
    }
    if (!isPublicURL(current))
        return url;
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
        for (let i = 0; i < MAX_REDIRECTS; i++) {
            let r = await hop(current.href, 'HEAD', signal);
            if (r.status === 405 || r.status === 501)
                r = await hop(current.href, 'GET', signal);
            const location = r.status >= 300 && r.status < 400 ? r.headers.get('Location') : null;
            if (!location)
                return current.href;
            const next = new URL(location, current);
            if (!isPublicURL(next))
                return current.href;
            current = next;
        }
    }
    catch {
        // Network error or timeout: keep the furthest URL we verified.
    }
    return current.href;
}
