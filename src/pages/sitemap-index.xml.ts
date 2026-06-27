/**
 * /sitemap-index.xml — Canonical-index redirect (D-140 Lane S-C, §13)
 *
 * The SINGLE canonical sitemap index is /sitemaps/sitemap-index.xml (served by
 * src/pages/sitemaps/[filename].ts and referenced by robots.txt). This route is
 * a legacy orphan path; it now does ONE thing — a permanent 301 redirect to the
 * canonical endpoint.
 *
 * It deliberately no longer proxies R2, no longer carries a hard-coded shard
 * range, no longer references a non-existent /sitemaps/sitemap-static.xml child,
 * and no longer emits an empty <sitemapindex> at HTTP 200. A second proxy with
 * divergent cache/failure semantics is a duplicate authority and is removed.
 */

import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
    return new Response(null, {
        status: 301,
        headers: {
            'Location': '/sitemaps/sitemap-index.xml',
        },
    });
};
