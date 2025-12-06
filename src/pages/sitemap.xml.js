export const prerender = false;

export async function GET({ locals }) {
    const db = locals.runtime.env.DB;

    try {
        // Fetch all models suitable for indexing
        // Limit to 5000 (standard sitemap limit is 50k, but let's be safe with memory)
        // We select ID, Slug, and Last Updated time
        const { results } = await db.prepare(
            "SELECT id, slug, last_updated FROM models ORDER BY last_updated DESC LIMIT 5000"
        ).all();

        const siteUrl = 'https://free2aitools.com';

        const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${siteUrl}/explore</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  ${results.map(model => {
            const slug = model.slug || model.id.replace('/', '--');
            const date = model.last_updated ? new Date(model.last_updated).toISOString() : new Date().toISOString();
            return `
  <url>
    <loc>${siteUrl}/model/${slug}</loc>
    <lastmod>${date}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
        }).join('')}
</urlset>`;

        return new Response(sitemap, {
            headers: {
                'Content-Type': 'application/xml',
                // Cache for 24 hours (86400 seconds) in CDN to protect DB
                'Cache-Control': 'public, max-age=3600, s-maxage=86400'
            }
        });

    } catch (e) {
        console.error('Sitemap Generation Error:', e);
        return new Response('Error generating sitemap', { status: 500 });
    }
}
