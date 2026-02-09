/**
 * Sitemap Files Proxy
 * V6.2: Serves all sitemap files from R2 via CDN
 * 
 * Routes: /sitemaps/[filename]
 * Examples:
 *   /sitemaps/sitemap-static.xml
 *   /sitemaps/sitemap-1.xml.gz
 */

import type { APIRoute, GetStaticPaths } from 'astro';

export const prerender = true;

const R2_CDN_BASE = 'https://cdn.free2aitools.com';

export const getStaticPaths: GetStaticPaths = async () => {
    return [
        { params: { filename: 'sitemap-1.xml.gz' } },
        { params: { filename: 'sitemap-2.xml.gz' } },
        { params: { filename: 'sitemap-3.xml.gz' } },
        { params: { filename: 'sitemap-4.xml.gz' } },
        { params: { filename: 'sitemap-5.xml.gz' } },
        { params: { filename: 'sitemap-6.xml.gz' } },
        { params: { filename: 'sitemap-7.xml.gz' } },
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

        // V18.2: Force identity to skip transparent decompression by some fetch clients.
        // This ensures the magic number check is reliable across all environments.
        const response = await fetch(r2Url, {
            headers: { 'Accept-Encoding': 'identity' }
        });

        if (!response.ok) {
            return new Response(`Sitemap ${filename} not found`, {
                status: 404,
                headers: { 'Content-Type': 'text/plain' }
            });
        }

        // Get response body
        const body = await response.arrayBuffer();
        const bytes = new Uint8Array(body);

        // For gzip files, decompress and return XML
        // We detect the magic number (1f 8b) to handle both compressed and uncompressed files safely.
        if (filename.endsWith('.gz') && bytes[0] === 0x1f && bytes[1] === 0x8b) {
            try {
                const decompressedStream = new Response(body).body?.pipeThrough(new DecompressionStream('gzip'));
                if (decompressedStream) {
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
