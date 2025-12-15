export const prerender = false;

export async function GET({ locals, request }) {
  // V4.9.1 Optimization: Sitemap D1 Ejection
  // Load strict "Content Reality" from R2 Index
  const r2 = locals.runtime?.env?.R2_ASSETS;

  try {
    let models = [];
    const siteUrl = new URL(request.url).origin;

    // Try R2 First (Strict Source of Truth)
    if (r2) {
      const indexObj = await r2.get('cache/meta/entity_index.json');
      if (indexObj) {
        models = await indexObj.json();
      }
    }

    // Fallback: If R2 missing (local dev?), we return empty or fail gracefully.
    // We do NOT fall back to D1 to enforce the Iron Law.
    if (models.length === 0) {
      console.warn('[Sitemap] R2 Index empty or unavailable.');
    }

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
  ${models.map(model => {
      const slug = model.slug || model.id.replace('/', '--');
      // Index has 'last_updated'
      const date = model.last_updated ? new Date(model.last_updated).toISOString() : new Date().toISOString();
      // Entity Type routing
      let prefix = 'model';
      if (model.type === 'dataset') prefix = 'dataset';
      // Default to model if type missing or 'model'

      return `
  <url>
    <loc>${siteUrl}/${prefix}/${slug}</loc>
    <lastmod>${date}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
    }).join('')}
</urlset>`;

    return new Response(sitemap, {
      headers: {
        'Content-Type': 'application/xml',
        // Cache for 24 hours (86400 seconds)
        'Cache-Control': 'public, max-age=3600, s-maxage=86400'
      }
    });

  } catch (e) {
    console.error('Sitemap Generation Error:', e);
    return new Response('Error generating sitemap', { status: 500 });
  }
}
