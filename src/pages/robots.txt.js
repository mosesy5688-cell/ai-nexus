export const prerender = true;

export async function GET() {
    const robotsTxt = `
User-agent: *
Allow: /
Crawl-delay: 1

# Sitemaps - V6.2 SEO Optimization
Sitemap: https://free2aitools.com/sitemap.xml

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
