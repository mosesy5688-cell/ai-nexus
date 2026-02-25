/**
 * Sitemap Static Pages
 * V6.1: Generates static pages sitemap
 */

import type { APIRoute } from 'astro';

const BASE_URL = 'https://free2aitools.com';

const STATIC_PAGES = [
    { path: '/', priority: '1.0', changefreq: 'daily' },
    { path: '/ranking', priority: '0.9', changefreq: 'daily' },
    { path: '/leaderboard', priority: '0.9', changefreq: 'daily' },
    { path: '/models', priority: '0.9', changefreq: 'daily' },
    { path: '/explore', priority: '0.8', changefreq: 'daily' },
    { path: '/search', priority: '0.8', changefreq: 'daily' },
    { path: '/agents', priority: '0.7', changefreq: 'daily' },
    { path: '/spaces', priority: '0.7', changefreq: 'daily' },
    { path: '/datasets', priority: '0.7', changefreq: 'daily' },
    { path: '/papers', priority: '0.7', changefreq: 'daily' },
    { path: '/tools', priority: '0.7', changefreq: 'daily' },
    { path: '/prompts', priority: '0.7', changefreq: 'daily' },
    { path: '/knowledge', priority: '0.7', changefreq: 'daily' },
    { path: '/reports', priority: '0.6', changefreq: 'daily' },
    { path: '/methodology', priority: '0.5', changefreq: 'monthly' },
    { path: '/about', priority: '0.4', changefreq: 'monthly' },
];

export const GET: APIRoute = async () => {
    const now = new Date().toISOString().split('T')[0];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="${BASE_URL}/sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;

    for (const page of STATIC_PAGES) {
        xml += `  <url>
    <loc>${BASE_URL}${page.path}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>
`;
    }

    xml += '</urlset>';

    return new Response(xml, {
        status: 200,
        headers: {
            'Content-Type': 'application/xml',
            'Cache-Control': 'public, max-age=3600',
        },
    });
};
