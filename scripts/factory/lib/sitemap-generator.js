/**
 * Sitemap Generator Module V19.2 (VFS Streaming)
 * 
 * Features:
 * - VFS High-Parity: Queries content.db directly for entity routes.
 * - Memory Efficiency: Uses streaming cursor (O(1) Memory).
 * - Multi-Index Paging: 45,000 URLs per file limit.
 * - Gzip compression.
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import { getRouteFromId, getTypeFromId } from '../../../src/utils/mesh-routing-core.js';

const gzip = promisify(zlib.gzip);

const BASE_URL = 'https://free2aitools.com';
const MAX_URLS_PER_FILE = 45000;
const BATCH_SIZE = 5000;

const STATIC_PAGES = [
    { path: '/', priority: '1.0', changefreq: 'daily' },
    { path: '/ranking', priority: '0.9', changefreq: 'daily' },
    { path: '/models', priority: '0.9', changefreq: 'daily' },
    { path: '/search', priority: '0.8', changefreq: 'daily' },
    { path: '/knowledge', priority: '0.7', changefreq: 'daily' },
    { path: '/agents', priority: '0.7', changefreq: 'daily' },
    { path: '/spaces', priority: '0.7', changefreq: 'daily' },
    { path: '/datasets', priority: '0.7', changefreq: 'daily' },
    { path: '/papers', priority: '0.7', changefreq: 'daily' },
    { path: '/reports', priority: '0.6', changefreq: 'daily' },
    { path: '/methodology', priority: '0.5', changefreq: 'monthly' },
    { path: '/about', priority: '0.4', changefreq: 'monthly' },
    { path: '/text-generation', priority: '0.8', changefreq: 'daily' },
    { path: '/knowledge-retrieval', priority: '0.7', changefreq: 'daily' },
    { path: '/vision-multimedia', priority: '0.7', changefreq: 'daily' },
    { path: '/automation-workflow', priority: '0.7', changefreq: 'daily' },
    { path: '/infrastructure-ops', priority: '0.7', changefreq: 'daily' },
];

function calculatePriority(fniScore) {
    if (!fniScore || fniScore <= 0) return '0.3';
    if (fniScore >= 80) return '0.9';
    if (fniScore >= 60) return '0.8';
    if (fniScore >= 40) return '0.7';
    if (fniScore >= 20) return '0.5';
    return '0.4';
}

function sitemapHeader() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="${BASE_URL}/sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;
}

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
 * @param {Array|string} source - Either an entity array (legacy) or path to content.db (new VFS)
 */
export async function generateSitemap(source, outputDir = './output') {
    console.log('[SITEMAP] 🗺️ Commencing VFS-Parity Sitemap Generation...');

    const sitemapDir = path.join(outputDir, 'sitemaps');
    await fs.mkdir(sitemapDir, { recursive: true });

    const sitemapFiles = [];
    let currentUrlBatch = [];
    let fileIndex = 1;
    let totalUrls = 0;

    const flushBatch = async () => {
        if (currentUrlBatch.length === 0) return;

        const filename = `sitemap-${fileIndex}.xml`;
        let content = sitemapHeader();
        for (const url of currentUrlBatch) {
            content += urlEntry(url.loc, url.priority, url.changefreq, url.lastmod);
        }
        content += '</urlset>';

        await fs.writeFile(path.join(sitemapDir, filename), content);
        const gzipped = await gzip(content);
        await fs.writeFile(path.join(sitemapDir, `${filename}.gz`), gzipped);

        sitemapFiles.push(filename);
        console.log(`  [SITEMAP] Generated ${filename} with ${currentUrlBatch.length} URLs.`);

        currentUrlBatch = [];
        fileIndex++;
    };

    const addUrl = async (url) => {
        currentUrlBatch.push(url);
        totalUrls++;
        if (currentUrlBatch.length >= MAX_URLS_PER_FILE) {
            await flushBatch();
        }
    };

    // 1. Add static pages to the first batch
    for (const page of STATIC_PAGES) {
        await addUrl({
            loc: page.path,
            priority: page.priority,
            changefreq: page.changefreq
        });
    }

    // 2. Add entity pages from source
    if (typeof source === 'string' && source.endsWith('.db')) {
        // VFS Mode: Streaming from SQLite
        console.log(`[SITEMAP] Mode: VFS Streaming (DB: ${source})`);
        const db = new Database(source, { readonly: true });

        const stmt = db.prepare('SELECT id, type, fni_score, last_modified FROM entities');
        const cursor = stmt.iterate();

        for (const entity of cursor) {
            const id = entity.id;
            const entityType = entity.type || getTypeFromId(id);
            const route = getRouteFromId(id, entityType);

            if (!route || route === '#') continue;

            await addUrl({
                loc: route,
                priority: calculatePriority(entity.fni_score),
                changefreq: 'daily',
                lastmod: entity.last_modified
            });
        }
        db.close();
    } else if (Array.isArray(source)) {
        // Legacy Mode: Memory array
        console.log(`[SITEMAP] Mode: Legacy Array (Size: ${source.length})`);
        for (const entity of source) {
            const id = entity.id || entity.slug || '';
            const entityType = entity.type || entity.entity_type || getTypeFromId(id);
            const route = getRouteFromId(id, entityType);

            if (!route || route === '#') continue;

            await addUrl({
                loc: route,
                priority: calculatePriority(entity.fni || entity.fni_score),
                changefreq: 'daily',
                lastmod: entity.last_modified || entity._updated || entity.lastModified
            });
        }
    }

    await flushBatch();

    // 3. Generate sitemap index
    if (sitemapFiles.length > 0) {
        const today = new Date().toISOString().split('T')[0];

        // Always generate index for stability, even if only 1 file
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

        // Final SEO Root Mirror
        const mirrorSource = sitemapFiles.length === 1 ? sitemapFiles[0] : 'sitemap-index.xml';
        await fs.copyFile(
            path.join(sitemapDir, mirrorSource),
            path.join(outputDir, 'sitemap.xml')
        );
    }

    console.log(`[SITEMAP] ✅ Complete: ${totalUrls} URLs in ${sitemapFiles.length} file(s).`);
}
