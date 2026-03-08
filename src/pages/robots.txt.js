export const prerender = true;

export async function GET() {
    const robotsTxt = `
User-agent: *
Allow: /
Crawl-delay: 1

# Sitemaps - V23.6 Sharded Sitemap Index
Sitemap: https://free2aitools.com/sitemaps/sitemap-index.xml

# Block legacy/sensitive paths
Disallow: /api/
Disallow: /_astro/
`.trim();

    return new Response(robotsTxt, {
        headers: {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=86400, s-maxage=86400'
        }
    });
}
