/**
 * Sitemap Files Proxy (V26.11)
 * Serves sitemap-index.xml and shard XML files from R2 CDN.
 * Prerendered at build time — shards served as uncompressed XML.
 * Shard count derived from sitemap-index.xml at build time (no hardcode).
 */

import type { APIRoute, GetStaticPaths } from 'astro';

export const prerender = true;

const R2_CDN_BASE = 'https://cdn.free2aitools.com';

async function discoverShardFilenames(): Promise<string[]> {
    try {
        const res = await fetch(`${R2_CDN_BASE}/sitemaps/sitemap-index.xml`, {
            headers: { 'Accept-Encoding': 'identity' }
        });
        if (!res.ok) return [];
        const xml = await res.text();
        const matches = [...xml.matchAll(/<loc>[^<]*\/sitemaps\/(sitemap-\d+\.xml)[^<]*<\/loc>/g)];
        return matches.map(m => m[1]);
    } catch { return []; }
}

export const getStaticPaths: GetStaticPaths = async () => {
    const shardFiles = await discoverShardFilenames();
    const paths = [{ params: { filename: 'sitemap-index.xml' } }];
    for (const name of shardFiles) {
        paths.push({ params: { filename: name } });
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
            return new Response(xml, { status: 200, headers: {
                'Content-Type': 'application/xml',
                'Cache-Control': 'public, max-age=3600, s-maxage=86400',
            }});
        }

        // Shard files: serve as uncompressed XML (prerender + Node.js fetch auto-decompresses gzip)
        const xmlName = filename.replace('.xml.gz', '.xml');
        const r2Url = `${R2_CDN_BASE}/sitemaps/${xmlName}`;
        const response = await fetch(r2Url);

        if (!response.ok) {
            return new Response(`Sitemap ${filename} not found`, { status: 404 });
        }

        return new Response(response.body, { status: 200, headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        }});
    } catch (error) {
        console.error(`[Sitemap] Error fetching ${filename}:`, error);
        return new Response('Internal Server Error', { status: 500 });
    }
};
