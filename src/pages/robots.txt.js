export const prerender = false;

export async function GET() {
    const robotsTxt = `
User-agent: *
Allow: /

# Sitemaps
Sitemap: https://free2aitools.com/sitemap.xml
`.trim();

    return new Response(robotsTxt, {
        headers: {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=86400, s-maxage=86400'
        }
    });
}
