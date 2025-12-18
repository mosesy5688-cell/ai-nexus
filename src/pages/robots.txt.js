export const prerender = false;

export async function GET() {
    const robotsTxt = `
User-agent: *
Allow: /

# Sitemaps - V6.1+ SEO Optimization
Sitemap: https://free2aitools.com/sitemap-index.xml
`.trim();

    return new Response(robotsTxt, {
        headers: {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=86400, s-maxage=86400'
        }
    });
}
