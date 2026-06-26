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
import { SitemapUrlSet, escapeXml, normalizeLastmod, childMaxLastmod } from './sitemap-url-set.js';

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
    // D-140 Lane S-B §9 C5 — DEAD-ROUTE REMOVAL. /agents + /spaces are cancelled
    // canonicals (live evidence 2026-06-27: /agents -> 301 /tools, /spaces -> 301
    // /models) and /reports is 410 Gone + noindex (live 410, /reports/* whole
    // surface discontinued V27.42). A 301/410 page is NOT a valid canonical, so it
    // must NOT appear in the sitemap. Reversible: restore here only if the route is
    // re-promoted to a live 200 canonical.
    { path: '/datasets', priority: '0.7', changefreq: 'daily' },
    { path: '/papers', priority: '0.7', changefreq: 'daily' },
    { path: '/tools', priority: '0.7', changefreq: 'daily' },
    // /prompts removed — prompt entity type cancelled (page 301s to /agents).
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

// D-140 Lane S-B §9 C7 — XML-ESCAPE every generated value. The absolute <loc>,
// priority, changefreq and lastmod are all escaped so a stray &/<>/quote in a slug
// can never produce malformed XML (audit: urlEntry previously did no escaping).
function urlEntry(loc, priority, changefreq, lastmod) {
    const safeLastmod = normalizeLastmod(lastmod);
    return `  <url>
    <loc>${escapeXml(BASE_URL + loc)}</loc>
    <priority>${escapeXml(priority)}</priority>
    <changefreq>${escapeXml(changefreq)}</changefreq>
    ${safeLastmod ? `<lastmod>${escapeXml(safeLastmod)}</lastmod>` : ''}
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

    // D-140 Lane S-B §8 C3 — DETERMINISTIC DEDUP. Candidates from every source are
    // accumulated into ONE canonical set keyed by the FULL absolute <loc>, so a URL
    // duplicated across OR within source DBs collapses to a single entry. On a
    // collision the LATEST VALID lastmod is retained (invalid never overrides
    // valid); the emitted order is deterministic (lexicographic on the absolute
    // loc) for identical inputs. We collect-then-emit (not stream-flush) so dedup
    // is correct across the whole set — bounded; see sitemap-url-set.js scale note.
    const urlSet = new SitemapUrlSet(BASE_URL);
    const addUrl = (url) => { urlSet.add(url); };

    // 1. Add static pages.
    for (const page of STATIC_PAGES) {
        addUrl({ loc: page.path, priority: page.priority, changefreq: page.changefreq });
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
                addUrl({ loc: route, priority: calculatePriority(entity.fni_score), changefreq: 'daily', lastmod: entity.last_modified });
            }
            db.close();
        }

        // 2b. Add knowledge articles from the anchor DB. D-140 Lane S-B §9 C5: the
        // daily-report (`/reports/*`) surface is 410 Gone (live 410 + noindex), so
        // per-article report URLs are dead canonicals and are NOT emitted — only
        // live `/knowledge/<slug>` articles are.
        {
            const anchorPath = path.join(dir, 'meta-knowledge.db');
            try {
                const { existsSync } = await import('fs');
                if (existsSync(anchorPath)) {
                    const db = new Database(anchorPath, { readonly: true });
                    const rows = db.prepare('SELECT slug, category, published_at FROM articles WHERE status = ?').all('published');
                    for (const r of rows) {
                        if (r.category === 'daily-report') continue; // 410 Gone — never emit
                        addUrl({ loc: `/knowledge/${r.slug}`, priority: '0.6', changefreq: 'weekly', lastmod: r.published_at || '' });
                    }
                    console.log(`  [SITEMAP] meta-knowledge.db: ${rows.length} articles`);
                    db.close();
                }
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

            addUrl({
                loc: route,
                priority: calculatePriority(entity.fni || entity.fni_score),
                changefreq: 'daily',
                lastmod: entity.last_modified || entity._updated || entity.lastModified
            });
        }
    }

    // 3. Emit deduped, deterministically-ordered URLs into child shards. The shard
    // count is DERIVED from the unique URL count (never hard-coded); the index
    // entry list is built from the SAME children, so it always matches exactly.
    const sortedUrls = urlSet.toSortedArray();
    const totalUrls = sortedUrls.length;
    const sitemapFiles = [];      // child filenames, in order
    const childLastmods = [];     // honest per-child MAX valid lastmod ('' = omit)

    for (let offset = 0, fileIndex = 1; offset < sortedUrls.length; offset += MAX_URLS_PER_FILE, fileIndex++) {
        const batch = sortedUrls.slice(offset, offset + MAX_URLS_PER_FILE);
        const filename = `sitemap-${fileIndex}.xml`;
        let content = sitemapHeader();
        for (const url of batch) {
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
        childLastmods.push(childMaxLastmod(batch)); // C6 honest lastmod, per child
        console.log(`  [SITEMAP] Generated ${filename}.gz (${batch.length} URLs, ${xmlBytes}B XML -> ${gzipped.length}B gzip).`);
    }

    // 4. Generate sitemap index (entries DERIVED from the children emitted above).
    if (sitemapFiles.length > 0) {
        // D-140 Lane S-B §9 C6 — HONEST INDEX lastmod. Each child's <lastmod> is its
        // own MAXIMUM valid URL modification timestamp, or OMITTED when that child
        // has none. We do NOT stamp every child with the current run date.
        let indexContent = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;
        for (let i = 0; i < sitemapFiles.length; i++) {
            const childLoc = escapeXml(`${BASE_URL}/sitemaps/${sitemapFiles[i]}.gz`);
            const lm = childLastmods[i];
            indexContent += `  <sitemap>
    <loc>${childLoc}</loc>
    ${lm ? `<lastmod>${escapeXml(lm)}</lastmod>` : ''}
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
