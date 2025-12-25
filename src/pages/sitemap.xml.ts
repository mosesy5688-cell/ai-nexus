/**
 * Sitemap.xml Redirect
 * V6.1: Redirects to sitemap-index.xml for compatibility
 */

import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
    return new Response(null, {
        status: 301,
        headers: {
            'Location': '/sitemap-index.xml',
        },
    });
};
