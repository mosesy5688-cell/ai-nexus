/**
 * Sitemap Files Proxy (V26.12)
 * SSR — returns 302 redirect to R2 CDN for shard files (zero body, instant).
 * sitemap-index.xml proxied inline (small, needs URL rewriting).
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

        const xmlName = filename.replace('.xml.gz', '.xml');
        const r2Url = `${R2_CDN_BASE}/sitemaps/${xmlName}`;
        const res = await fetch(r2Url);
        if (!res.ok) return new Response(`Sitemap ${filename} not found`, { status: 404 });
        return new Response(res.body, { status: 200, headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        }});
    } catch (error) {
        console.error(`[Sitemap] Error fetching ${filename}:`, error);
        return new Response('Internal Server Error', { status: 500 });
    }
};
