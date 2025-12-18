/**
 * L8 Sitemap Generator - V6.1+ Scalable Sitemap System
 * 
 * Features:
 * - Entity-type sharded sitemaps (models, papers, datasets, etc.)
 * - XML special character escaping
 * - Priority/changefreq based on FNI score
 * - XSLT stylesheet for human-readable display
 * - Incremental update support
 * 
 * Constitution Art 6.3 Compliance:
 * - Daily updates via L8 Precompute
 * - lastmod timestamps
 * - Max 45,000 URLs per file (below 50K limit)
 */

import { writeToR2 } from './gzip';

const BASE_URL = 'https://free2aitools.com';
const URLS_PER_FILE = 45000; // Leave 10% buffer below 50K limit

// XML special character escaping (prevents XML structure corruption)
function escapeXml(unsafe: string): string {
    if (!unsafe) return '';
    return unsafe.replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}

// Generate ISO date string for lastmod
function toISODate(date?: string | null): string {
    if (date) {
        try {
            return new Date(date).toISOString();
        } catch {
            // Fall through to default
        }
    }
    return new Date().toISOString();
}

// Generate single URL entry with priority based on FNI score
function generateUrlEntry(
    loc: string,
    lastmod: string,
    priority: string,
    changefreq: string
): string {
    return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

// Calculate priority based on FNI score
function calculatePriority(fniScore: number | null): string {
    const score = fniScore || 0;
    if (score >= 90) return '0.9'; // Top tier
    if (score >= 80) return '0.8'; // High value
    if (score >= 60) return '0.7'; // Above average
    if (score >= 40) return '0.6'; // Average
    return '0.5'; // Long tail
}

// Generate sitemap XML header with XSLT reference
function sitemapHeader(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="${BASE_URL}/sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
}

// Generate sitemap index header
function sitemapIndexHeader(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="${BASE_URL}/sitemap.xsl"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
}

interface SitemapConfig {
    type: string;
    query: string;
    pathPrefix: string;
    changefreq: 'daily' | 'weekly' | 'monthly';
}

// Entity type configurations
const SITEMAP_CONFIGS: SitemapConfig[] = [
    {
        type: 'models',
        query: `SELECT slug, first_indexed, fni_score FROM models WHERE archived = 0 ORDER BY fni_score DESC`,
        pathPrefix: '/model/',
        changefreq: 'weekly'
    }
    // Future: Add papers, datasets, knowledge, etc.
];

/**
 * Main sitemap generation function
 * Called by L8 Precompute daily
 */
export async function generateSitemaps(env: any): Promise<void> {
    console.log('[L8] 🗺️ Starting Sitemap Generation...');

    const allSitemapFiles: { loc: string; lastmod: string }[] = [];
    const now = new Date().toISOString();

    // 1. Generate static pages sitemap
    const staticUrls = [
        { path: '/', priority: '1.0', changefreq: 'daily' },
        { path: '/text-generation/', priority: '0.9', changefreq: 'daily' },
        { path: '/knowledge-retrieval/', priority: '0.9', changefreq: 'daily' },
        { path: '/vision-multimedia/', priority: '0.9', changefreq: 'daily' },
        { path: '/automation-workflow/', priority: '0.9', changefreq: 'daily' },
        { path: '/infrastructure-ops/', priority: '0.9', changefreq: 'daily' },
        { path: '/explore', priority: '0.8', changefreq: 'daily' },
        { path: '/ranking', priority: '0.8', changefreq: 'daily' },
        { path: '/knowledge', priority: '0.7', changefreq: 'weekly' },
        { path: '/compare', priority: '0.6', changefreq: 'weekly' },
        { path: '/methodology', priority: '0.5', changefreq: 'monthly' },
        { path: '/about', priority: '0.4', changefreq: 'monthly' },
    ];

    let staticContent = sitemapHeader() + '\n';
    for (const url of staticUrls) {
        staticContent += generateUrlEntry(
            `${BASE_URL}${url.path}`,
            now,
            url.priority,
            url.changefreq
        ) + '\n';
    }
    staticContent += '</urlset>';

    await env.R2_ASSETS.put('sitemaps/sitemap-static.xml', staticContent, {
        httpMetadata: { contentType: 'application/xml' }
    });
    allSitemapFiles.push({ loc: `${BASE_URL}/sitemaps/sitemap-static.xml`, lastmod: now });
    console.log('[L8] ✅ Generated sitemap-static.xml');

    // 2. Generate entity-type sitemaps (models, etc.)
    for (const config of SITEMAP_CONFIGS) {
        console.log(`[L8] Generating ${config.type} sitemaps...`);

        // Get total count
        const countResult = await env.DB.prepare(
            `SELECT COUNT(*) as count FROM models WHERE archived = 0`
        ).first();
        const totalEntities = (countResult as any)?.count || 0;
        const totalPages = Math.ceil(totalEntities / URLS_PER_FILE);

        console.log(`[L8] Total ${config.type}: ${totalEntities}, Pages: ${totalPages}`);

        // Generate paginated sitemaps
        for (let page = 1; page <= totalPages; page++) {
            const offset = (page - 1) * URLS_PER_FILE;

            const entities = await env.DB.prepare(`
        SELECT slug, first_indexed, fni_score 
        FROM models 
        WHERE archived = 0 
        ORDER BY fni_score DESC 
        LIMIT ? OFFSET ?
      `).bind(URLS_PER_FILE, offset).all();

            let content = sitemapHeader() + '\n';

            for (const entity of entities.results) {
                const e = entity as any;
                content += generateUrlEntry(
                    `${BASE_URL}${config.pathPrefix}${escapeXml(e.slug)}`,
                    toISODate(e.first_indexed),
                    calculatePriority(e.fni_score),
                    config.changefreq
                ) + '\n';
            }

            content += '</urlset>';

            const filename = `sitemaps/sitemap-${config.type}-${page}.xml`;
            await env.R2_ASSETS.put(filename, content, {
                httpMetadata: { contentType: 'application/xml' }
            });

            allSitemapFiles.push({ loc: `${BASE_URL}/${filename}`, lastmod: now });
            console.log(`[L8] ✅ Generated ${filename} (${entities.results.length} URLs)`);
        }
    }

    // 3. Generate sitemap index
    let indexContent = sitemapIndexHeader() + '\n';

    for (const file of allSitemapFiles) {
        indexContent += `  <sitemap>
    <loc>${file.loc}</loc>
    <lastmod>${file.lastmod}</lastmod>
  </sitemap>\n`;
    }

    indexContent += '</sitemapindex>';

    await env.R2_ASSETS.put('sitemap-index.xml', indexContent, {
        httpMetadata: { contentType: 'application/xml' }
    });
    console.log('[L8] ✅ Generated sitemap-index.xml');

    // 4. Ping Google (optional, comment out if not needed)
    try {
        const pingUrl = `https://www.google.com/ping?sitemap=${encodeURIComponent(BASE_URL + '/sitemap-index.xml')}`;
        await fetch(pingUrl);
        console.log('[L8] 📡 Pinged Google about sitemap update');
    } catch (err) {
        console.log('[L8] ⚠️ Google ping failed (non-critical):', err);
    }

    // 5. Store last update timestamp for incremental updates
    await env.KV.put('sitemap:lastUpdate', now);

    console.log('[L8] 🎉 Sitemap generation complete!');
}
