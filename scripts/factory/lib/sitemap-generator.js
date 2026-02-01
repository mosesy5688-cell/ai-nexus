/**
 * Sitemap Generator Module V14.4
 * Constitution Reference: Art 3.1 (Aggregator Phase 2)
 * 
 * Generates sitemap XML files from entity data
 * - 45,000 URL limit per file (below Google's 50K limit)
 * - Gzip compression
 * - Auto-pagination
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { getRouteFromId, getTypeFromId } from '../../../src/utils/mesh-routing-core.js';

const gzip = promisify(zlib.gzip);

const BASE_URL = 'https://free2aitools.com';
const MAX_URLS_PER_FILE = 45000;

// Static pages configuration
const STATIC_PAGES = [
    { path: '/', priority: '1.0', changefreq: 'daily' },
    { path: '/models', priority: '0.9', changefreq: 'daily' },
    { path: '/search', priority: '0.8', changefreq: 'daily' },
    { path: '/knowledge', priority: '0.7', changefreq: 'daily' },
    { path: '/agent', priority: '0.7', changefreq: 'daily' },
    { path: '/space', priority: '0.7', changefreq: 'daily' },
    { path: '/dataset', priority: '0.7', changefreq: 'daily' },
    { path: '/paper', priority: '0.7', changefreq: 'daily' },
    { path: '/reports', priority: '0.6', changefreq: 'daily' },
    { path: '/compare', priority: '0.6', changefreq: 'daily' },
    { path: '/methodology', priority: '0.5', changefreq: 'monthly' },
    { path: '/about', priority: '0.4', changefreq: 'monthly' },
    // Category pages
    { path: '/text-generation', priority: '0.8', changefreq: 'daily' },
    { path: '/knowledge-retrieval', priority: '0.7', changefreq: 'daily' },
    { path: '/vision-multimedia', priority: '0.7', changefreq: 'daily' },
    { path: '/automation-workflow', priority: '0.7', changefreq: 'daily' },
    { path: '/infrastructure-ops', priority: '0.7', changefreq: 'daily' },
];

/**
 * Calculate priority based on FNI score
 */
function calculatePriority(fniScore) {
    if (!fniScore || fniScore <= 0) return '0.3';
    if (fniScore >= 80) return '0.9';
    if (fniScore >= 60) return '0.8';
    if (fniScore >= 40) return '0.7';
    if (fniScore >= 20) return '0.5';
    return '0.4';
}

/**
 * Generate sitemap XML header
 */
function sitemapHeader() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="${BASE_URL}/sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;
}

/**
 * Generate URL entry
 */
function urlEntry(loc, priority, changefreq, lastmod) {
    return `  <url>
    <loc>${BASE_URL}${loc}</loc>
    <priority>${priority}</priority>
    <changefreq>${changefreq}</changefreq>
    ${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}
  </url>
`;
}

/**
 * Generate sitemap files
 */
export async function generateSitemap(entities, outputDir = './output') {
    console.log('[SITEMAP] Generating sitemap...');

    const sitemapDir = path.join(outputDir, 'sitemaps');
    await fs.mkdir(sitemapDir, { recursive: true });

    // Collect all URLs
    const urls = [];

    // Add static pages
    for (const page of STATIC_PAGES) {
        urls.push({
            loc: page.path,
            priority: page.priority,
            changefreq: page.changefreq,
        });
    }

    // Add entity pages
    for (const entity of entities) {
        const id = entity.id || entity.slug || '';
        const entityType = entity.type || entity.entity_type || getTypeFromId(id);
        const route = getRouteFromId(id, entityType);

        if (!route || route === '#') continue;

        urls.push({
            loc: route,
            priority: calculatePriority(entity.fni || entity.fni_score),
            changefreq: 'daily',
            lastmod: entity._updated || entity.lastModified,
        });
    }

    console.log(`  [SITEMAP] Total URLs: ${urls.length}`);

    // Split into files (max 45K per file)
    const sitemapFiles = [];
    const totalFiles = Math.ceil(urls.length / MAX_URLS_PER_FILE);

    for (let i = 0; i < totalFiles; i++) {
        const start = i * MAX_URLS_PER_FILE;
        const end = start + MAX_URLS_PER_FILE;
        const pageUrls = urls.slice(start, end);

        let content = sitemapHeader();
        for (const url of pageUrls) {
            content += urlEntry(url.loc, url.priority, url.changefreq, url.lastmod);
        }
        content += '</urlset>';

        // Write regular XML
        const filename = totalFiles === 1 ? 'sitemap.xml' : `sitemap-${i + 1}.xml`;
        await fs.writeFile(path.join(sitemapDir, filename), content);

        // Write gzipped version
        const gzipped = await gzip(content);
        await fs.writeFile(path.join(sitemapDir, `${filename}.gz`), gzipped);

        sitemapFiles.push(filename);
        console.log(`  [SITEMAP] ${filename}: ${pageUrls.length} URLs`);
    }

    // Generate sitemap index if multiple files
    if (totalFiles > 1) {
        const today = new Date().toISOString().split('T')[0];
        let indexContent = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;
        for (const file of sitemapFiles) {
            indexContent += `  <sitemap>
    <loc>${BASE_URL}/sitemaps/${file}</loc>
    <lastmod>${today}</lastmod>
  </sitemap>
`;
        }
        indexContent += '</sitemapindex>';

        await fs.writeFile(path.join(sitemapDir, 'sitemap-index.xml'), indexContent);
        console.log(`  [SITEMAP] Index: ${sitemapFiles.length} sitemap files`);
    }

    // Copy main sitemap to root for compatibility
    const mainSitemap = totalFiles === 1 ? 'sitemap.xml' : 'sitemap-index.xml';
    await fs.copyFile(
        path.join(sitemapDir, mainSitemap),
        path.join(outputDir, 'sitemap.xml')
    );

    console.log(`[SITEMAP] Complete: ${urls.length} URLs in ${totalFiles} file(s)`);
}
