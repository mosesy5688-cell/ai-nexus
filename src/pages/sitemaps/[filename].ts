/**
 * Sitemap Files Proxy (V26.12 / V27.102 / V28 same-host pass-through)
 * SSR — shard files are served as a SAME-HOST 200 streaming pass-through of the
 * static R2 CDN `.xml.gz` object. The worker `fetch`es the compressed upstream
 * object and streams its body straight back (never reads/buffers/decompresses
 * it), advertising `Content-Type: application/xml; charset=utf-8` +
 * `Content-Encoding: gzip` so the client transparently decompresses to valid
 * <urlset> XML.
 *
 * Why not a cross-host 302 to `cdn.free2aitools.com/...xml.gz`: the CDN serves
 * the object as `application/gzip` with no transport encoding, which Google
 * reports as an unreadable sitemap. Keeping the response same-host with the
 * correct representation headers fixes the serving-layer defect without
 * touching the sitemap contents, producer, shard count, or URL selection.
 *
 * Cloudflare `encodeBody: 'manual'` is required so the runtime does NOT
 * re-compress or re-interpret the already-gzipped body — it forwards the opaque
 * gzip bytes while preserving our `Content-Encoding: gzip` header.
 *
 * sitemap-index.xml is proxied inline (small, served as application/xml).
 */

import type { APIRoute } from 'astro';

const R2_CDN_BASE = 'https://cdn.free2aitools.com';

// Approved cache policy used elsewhere in this file for sitemap responses.
const SITEMAP_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400';

const SHARD_RE = /^sitemap-\d+\.xml(\.gz)?$/;

// Cloudflare Workers extends ResponseInit with `encodeBody` ('automatic' |
// 'manual'). The DOM lib types don't include it, so we widen ResponseInit here
// rather than buffer the body. 'manual' = forward the already-gzipped bytes
// opaquely while keeping our Content-Encoding header (no re-compress/-interpret).
type CfResponseInit = ResponseInit & { encodeBody?: 'automatic' | 'manual' };

/**
 * Copy a small allow-list of upstream caching/validator headers when safely
 * present. We do NOT blindly forward upstream headers (the CDN sets
 * `Content-Type: application/gzip`, which must not leak into our XML response).
 */
function passThroughHeaders(upstream: Response): Headers {
    const headers = new Headers({
        // Representation headers — the body reaches the client as opaque gzip
        // bytes the client transparently decompresses to XML.
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': SITEMAP_CACHE_CONTROL,
    });
    let copiedCacheControl = false;
    for (const name of ['ETag', 'Last-Modified', 'Cache-Control'] as const) {
        const value = upstream.headers.get(name);
        if (value) {
            headers.set(name, value);
            if (name === 'Cache-Control') copiedCacheControl = true;
        }
    }
    // If the upstream supplied no Cache-Control, keep our approved policy.
    if (!copiedCacheControl) headers.set('Cache-Control', SITEMAP_CACHE_CONTROL);
    return headers;
}

/** Tiny text/plain error body; HEAD callers get the same status, no body. */
function errorResponse(status: number, message: string, isHead: boolean): Response {
    return new Response(isHead ? null : message, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
}

async function handle(filename: string | undefined, method: 'GET' | 'HEAD'): Promise<Response> {
    const isHead = method === 'HEAD';
    if (!filename) return errorResponse(404, 'Not found', isHead);

    try {
        if (filename === 'sitemap-index.xml') {
            const res = await fetch(`${R2_CDN_BASE}/sitemaps/${filename}`);
            if (!res.ok) return errorResponse(404, 'Sitemap index not found', isHead);
            const xml = await res.text();
            return new Response(isHead ? null : xml, {
                status: 200,
                headers: {
                    'Content-Type': 'application/xml',
                    'Cache-Control': SITEMAP_CACHE_CONTROL,
                },
            });
        }

        // Shard files: same-host 200 streaming pass-through of the static CDN
        // `.xml.gz` object. Incoming name may be `sitemap-N.xml` or `.xml.gz`.
        if (SHARD_RE.test(filename)) {
            const gzName = filename.endsWith('.gz') ? filename : filename.replace(/\.xml$/, '.xml.gz');
            const cdnUrl = `${R2_CDN_BASE}/sitemaps/${gzName}`;

            let upstream: Response;
            try {
                upstream = await fetch(cdnUrl);
            } catch {
                // Network failure / timeout reaching origin -> honest 503,
                // never laundered into a fake 200.
                return errorResponse(503, 'Sitemap temporarily unavailable', isHead);
            }

            if (!upstream.ok || !upstream.body) {
                // Origin-unavailable (503/504/0) -> 503; any other non-2xx -> 502.
                const transient = upstream.status === 503 || upstream.status === 504 || upstream.status === 0;
                return errorResponse(
                    transient ? 503 : 502,
                    'Sitemap temporarily unavailable',
                    isHead,
                );
            }

            const headers = passThroughHeaders(upstream);
            // HEAD: same status + representation headers, NO body.
            // GET: stream the upstream body straight back (do NOT read/buffer/
            // decompress/re-encode it). `encodeBody: 'manual'` keeps the runtime
            // from re-compressing the already-gzipped body.
            const init: CfResponseInit = { status: 200, headers, encodeBody: 'manual' };
            if (isHead) {
                // Consume nothing of the body; return it empty so no stream leaks.
                if (typeof upstream.body.cancel === 'function') {
                    try { upstream.body.cancel(); } catch { /* ignore */ }
                }
                return new Response(null, init);
            }
            return new Response(upstream.body, init);
        }

        return errorResponse(404, `Sitemap ${filename} not found`, isHead);
    } catch (error) {
        console.error(`[Sitemap] Error fetching ${filename}:`, error);
        return errorResponse(500, 'Internal Server Error', isHead);
    }
}

export const GET: APIRoute = async ({ params }) => handle(params.filename, 'GET');

export const HEAD: APIRoute = async ({ params }) => handle(params.filename, 'HEAD');
