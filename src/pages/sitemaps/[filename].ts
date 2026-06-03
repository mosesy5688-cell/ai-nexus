/**
 * Sitemap Files Proxy (V26.12 / V27.102)
 * SSR — shard files return a 302 redirect to the static R2 CDN object (zero
 * body, instant, worker OUT of the read path). Google fetches the CDN file
 * directly, avoiding SSR cold-open / streaming the full ~8.77MB shard through
 * the worker. The redirect targets the `.xml.gz` variant (~12x smaller;
 * Google natively supports gzipped sitemaps identified by the `.gz` extension).
 * sitemap-index.xml is proxied inline (small, served as application/xml).
 */

import type { APIRoute } from 'astro';

const R2_CDN_BASE = 'https://cdn.free2aitools.com';

export const GET: APIRoute = async ({ params }) => {
    const { filename } = params;
    if (!filename) return new Response('Not found', { status: 404 });

    try {
        if (filename === 'sitemap-index.xml') {
            const res = await fetch(`${R2_CDN_BASE}/sitemaps/${filename}`);
            if (!res.ok) return new Response('Sitemap index not found', { status: 404 });
            const xml = await res.text();
            return new Response(xml, { status: 200, headers: {
                'Content-Type': 'application/xml',
                'Cache-Control': 'public, max-age=3600, s-maxage=86400',
            }});
        }

        // Shard files: 302 redirect to the static CDN .xml.gz object so the
        // worker stays out of the read path (no cold-open, no 8.77MB stream).
        // Incoming name may be `sitemap-N.xml` or `sitemap-N.xml.gz`.
        if (/^sitemap-\d+\.xml(\.gz)?$/.test(filename)) {
            const gzName = filename.endsWith('.gz') ? filename : filename.replace(/\.xml$/, '.xml.gz');
            return Response.redirect(`${R2_CDN_BASE}/sitemaps/${gzName}`, 302);
        }

        return new Response(`Sitemap ${filename} not found`, { status: 404 });
    } catch (error) {
        console.error(`[Sitemap] Error fetching ${filename}:`, error);
        return new Response('Internal Server Error', { status: 500 });
    }
};
