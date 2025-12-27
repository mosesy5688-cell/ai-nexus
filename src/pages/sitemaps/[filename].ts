/**
 * Sitemap Files Proxy
 * V6.2: Serves all sitemap files from R2 via CDN
 * 
 * Routes: /sitemaps/[filename]
 * Examples:
 *   /sitemaps/sitemap-static.xml
 *   /sitemaps/models-1.xml.gz
 */

import type { APIRoute, GetStaticPaths } from 'astro';

const R2_CDN_BASE = 'https://cdn.free2aitools.com';

// Static paths for build time (SSR will handle dynamic)
export const getStaticPaths: GetStaticPaths = async () => {
    // Known sitemap files
    return [
        { params: { filename: 'sitemap-static.xml' } },
        { params: { filename: 'models-1.xml.gz' } },
        { params: { filename: 'sitemap-index.xml' } },
    ];
};

export const GET: APIRoute = async ({ params }) => {
    const { filename } = params;

    if (!filename) {
        return new Response('Not found', { status: 404 });
    }

    try {
        const r2Url = `${R2_CDN_BASE}/sitemaps/${filename}`;
        const response = await fetch(r2Url);

        if (!response.ok) {
            return new Response(`Sitemap ${filename} not found`, {
                status: 404,
                headers: { 'Content-Type': 'text/plain' }
            });
        }

        // Get response body
        const body = await response.arrayBuffer();

        // For gzip files, decompress and return XML
        // (Cloudflare strips Content-Encoding, so we decompress server-side)
        if (filename.endsWith('.gz')) {
            try {
                const decompressed = new Response(body).body;
                if (decompressed) {
                    const decompressedStream = decompressed.pipeThrough(new DecompressionStream('gzip'));
                    return new Response(decompressedStream, {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/xml',
                            'Cache-Control': 'public, max-age=3600',
                        },
                    });
                }
            } catch (e) {
                console.error('Decompression failed:', e);
            }
        }

        // Non-gzip files or fallback
        return new Response(body, {
            status: 200,
            headers: {
                'Content-Type': 'application/xml',
                'Cache-Control': 'public, max-age=3600',
            },
        });
    } catch (error) {
        console.error(`Error fetching sitemap ${filename}:`, error);
        return new Response('Internal Server Error', {
            status: 500,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
};
