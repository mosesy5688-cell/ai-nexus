/**
 * Sitemap Generator Module V19.2 (VFS Streaming)
 * 
 * Features:
 * - VFS High-Parity: Queries content.db directly for entity routes.
 * - Memory Efficiency: Uses streaming cursor (O(1) Memory).
 * - Multi-Index Paging: 45,000 URLs per file limit.
 * - Gzip compression (SEO standard for sitemap.xml.gz, not migrated to Zstd).
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import Database from 'better-sqlite3';
import { getEntityRoute, getTypeFromId } from '../../../src/utils/mesh-routing-core.js';

// D-140 Lane S-A §4.1 — DETERMINISTIC TRUE-GZIP. Produce a REAL single-member
// gzip of the XML: bytes 1f 8b, `gzip -t` OK, ONE decompress yields <urlset>, a
// SECOND fails (not double-gzipped). zlib's header embeds mtime + OS byte; mtime:0
// + fixed level + Node's fixed OS=0xff (unknown) makes identical XML -> identical
// bytes. gzipSync (no promisify) = explicit single-shot deterministic encode.
const GZIP_OPTS = { level: zlib.constants.Z_BEST_COMPRESSION, mtime: 0 };
export function gzipSitemapXml(xml) {
    return zlib.gzipSync(Buffer.from(xml, 'utf8'), GZIP_OPTS);
}

const BASE_URL = 'https://free2aitools.com';
const MAX_URLS_PER_FILE = 45000;
const BATCH_SIZE = 5000;

const STATIC_PAGES = [
    { path: '/', priority: '1.0', changefreq: 'daily' },
    { path: '/ranking', priority: '0.9', changefreq: 'daily' },
    { path: '/models', priority: '0.9', changefreq: 'daily' },
    { path: '/explore', priority: '0.8', changefreq: 'daily' },
    { path: '/search', priority: '0.8', changefreq: 'daily' },
    { path: '/knowledge', priority: '0.7', changefreq: 'daily' },
    { path: '/agents', priority: '0.7', changefreq: 'daily' },
    { path: '/spaces', priority: '0.7', changefreq: 'daily' },
    { path: '/datasets', priority: '0.7', changefreq: 'daily' },
    { path: '/papers', priority: '0.7', changefreq: 'daily' },
    { path: '/tools', priority: '0.7', changefreq: 'daily' },
    // /prompts removed — prompt entity type cancelled (page 301s to /agents).
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

function normalizeLastmod(raw) {
    if (!raw) return '';
    const d = new Date(raw);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function urlEntry(loc, priority, changefreq, lastmod) {
    const safeLastmod = normalizeLastmod(lastmod);
    return `  <url>
    <loc>${BASE_URL}${loc}</loc>
    <priority>${priority}</priority>
    <changefreq>${changefreq}</changefreq>
    ${safeLastmod ? `<lastmod>${safeLastmod}</lastmod>` : ''}
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

        // §4.1: uncompressed XML must stay <50MB (45,000-URL cap is far under).
        const xmlBytes = Buffer.byteLength(content, 'utf8');
        if (xmlBytes >= 50 * 1024 * 1024) {
            throw new Error(`[SITEMAP] ${filename} uncompressed XML ${xmlBytes} bytes >= 50MB`);
        }
        // §4.2: publish ONLY ONE canonical child representation — the `.gz`. We do
        // NOT write the public plain `sitemap-N.xml` (would be a competing child).
        const gzipped = gzipSitemapXml(content);
        // §4.1 fail-loud canary: artifact MUST be real gzip (1f 8b), not plain XML.
        if (gzipped.length < 2 || gzipped[0] !== 0x1f || gzipped[1] !== 0x8b) {
            throw new Error(`[SITEMAP] ${filename}.gz is not a valid gzip member (missing 1f 8b)`);
        }
        await fs.writeFile(path.join(sitemapDir, `${filename}.gz`), gzipped);

        sitemapFiles.push(filename);
        console.log(`  [SITEMAP] Generated ${filename}.gz (${currentUrlBatch.length} URLs, ${xmlBytes}B XML -> ${gzipped.length}B gzip).`);

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

    // 2. Add entity pages from meta-NN.db shards
    if (typeof source === 'string' && source.endsWith('.db')) {
        const { readdirSync } = await import('fs');
        const dir = path.dirname(source);
        const shardFiles = readdirSync(dir).filter(f => /^meta-\d+\.db$/.test(f)).sort();
        const dbPaths = shardFiles.length > 0 ? shardFiles.map(f => path.join(dir, f)) : [source];
        console.log(`[SITEMAP] Mode: VFS Streaming (${dbPaths.length} entity shard(s))`);

        for (const dbPath of dbPaths) {
            const db = new Database(dbPath, { readonly: true });
            const stmt = db.prepare(`
                SELECT id, slug, type, fni_score, last_modified FROM entities
                WHERE (LENGTH(COALESCE(readme_html, '')) + LENGTH(COALESCE(summary, ''))) > 3600
                   OR fni_score >= 20
                   OR type = 'paper'
            `);
            for (const entity of stmt.iterate()) {
                const id = entity.id;
                const entityType = entity.type || getTypeFromId(id);
                // prompt/space/agent types cancelled — never emit their /*/* URLs.
                // Defensive: the packer drops them on re-pack, but already-baked
                // shards may still carry them until then. (space->model merge +
                // agent cancelled; mcp-server rows are type=tool and pass through.)
                if (entityType === 'prompt' || entityType === 'space' || entityType === 'agent') continue;
                const route = getEntityRoute(entity, entityType);
                if (!route || route === '#') continue;
                await addUrl({ loc: route, priority: calculatePriority(entity.fni_score), changefreq: 'daily', lastmod: entity.last_modified });
            }
            db.close();
        }

        // 2b. Add reports + knowledge articles from anchor DBs
        for (const anchorFile of ['meta-report.db', 'meta-knowledge.db']) {
            const anchorPath = path.join(dir, anchorFile);
            try {
                const { existsSync } = await import('fs');
                if (!existsSync(anchorPath)) continue;
                const db = new Database(anchorPath, { readonly: true });
                const rows = db.prepare('SELECT slug, category, published_at FROM articles WHERE status = ?').all('published');
                for (const r of rows) {
                    const prefix = r.category === 'daily-report' ? '/reports/' : '/knowledge/';
                    await addUrl({ loc: `${prefix}${r.slug}`, priority: '0.6', changefreq: 'weekly', lastmod: r.published_at || '' });
                }
                console.log(`  [SITEMAP] ${anchorFile}: ${rows.length} articles`);
                db.close();
            } catch { }
        }
    } else if (Array.isArray(source)) {
        // Legacy Mode: Memory array
        console.log(`[SITEMAP] Mode: Legacy Array (Size: ${source.length})`);
        for (const entity of source) {
            const id = entity.id || entity.slug || '';
            const entityType = entity.type || entity.entity_type || getTypeFromId(id);
            // prompt/space/agent types cancelled — never emit their URLs (see VFS loop).
            if (entityType === 'prompt' || entityType === 'space' || entityType === 'agent') continue;
            const route = getEntityRoute(entity, entityType);

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
    <loc>${BASE_URL}/sitemaps/${file}.gz</loc>
    <lastmod>${today}</lastmod>
  </sitemap>
`;
        }
        indexContent += '</sitemapindex>';

        await fs.writeFile(path.join(sitemapDir, 'sitemap-index.xml'), indexContent);

        // Final SEO Root Mirror. §4.2: the public plain child `.xml` is no longer
        // emitted, so the root `sitemap.xml` always mirrors the index (a valid
        // <sitemapindex> for both single- and multi-shard cases; served inline as
        // uncompressed application/xml, never as a competing canonical child).
        await fs.writeFile(path.join(outputDir, 'sitemap.xml'), indexContent);
    }

    console.log(`[SITEMAP] ✅ Complete: ${totalUrls} URLs in ${sitemapFiles.length} file(s).`);
}
