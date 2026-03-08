/**
 * Sitemap Files Proxy (V23.10)
 * Serves sitemap-index.xml and compressed shard files (.xml.gz) from R2 CDN.
 * Only .xml.gz format for shards — zero SSR decompression overhead.
 *
 * Routes: /sitemaps/[filename]
 */

import type { APIRoute, GetStaticPaths } from 'astro';

export const prerender = true;

const R2_CDN_BASE = 'https://cdn.free2aitools.com';
const SHARD_COUNT = 9;

export const getStaticPaths: GetStaticPaths = async () => {
    const paths = [{ params: { filename: 'sitemap-index.xml' } }];
    for (let i = 1; i <= SHARD_COUNT; i++) {
        paths.push({ params: { filename: `sitemap-${i}.xml.gz` } });
    }
    return paths;
};

export const GET: APIRoute = async ({ params }) => {
    const { filename } = params;
    if (!filename) return new Response('Not found', { status: 404 });

    try {
        // sitemap-index.xml: rewrite <loc> to point to .xml.gz routes
        if (filename === 'sitemap-index.xml') {
            const res = await fetch(`${R2_CDN_BASE}/sitemaps/${filename}`, {
                headers: { 'Accept-Encoding': 'identity' }
            });
            if (!res.ok) return new Response('Sitemap index not found', { status: 404 });

            let xml = await res.text();
            xml = xml.replace(/<loc>([^<]*sitemap-\d+)\.xml<\/loc>/g, '<loc>$1.xml.gz</loc>');
            return new Response(xml, { status: 200, headers: {
                'Content-Type': 'application/xml',
                'Cache-Control': 'public, max-age=3600, s-maxage=86400',
            }});
        }

        // Shard files: pass through .gz compressed content directly
        const r2Url = `${R2_CDN_BASE}/sitemaps/${filename}`;
        const response = await fetch(r2Url, {
            headers: { 'Accept-Encoding': 'identity' }
        });

        if (!response.ok) {
            return new Response(`Sitemap ${filename} not found`, { status: 404 });
        }

        return new Response(await response.arrayBuffer(), { status: 200, headers: {
            'Content-Type': 'application/gzip',
            'Content-Encoding': 'gzip',
            'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        }});
    } catch (error) {
        console.error(`[Sitemap] Error fetching ${filename}:`, error);
        return new Response('Internal Server Error', { status: 500 });
    }
};
