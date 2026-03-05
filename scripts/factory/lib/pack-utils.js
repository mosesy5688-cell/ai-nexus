/**
 * V19.2 VFS Packing Utilities
 * Extracted to satisfy CES Monolith Ban (Art 5.1).
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

/**
 * Load Trending Context for entity prioritization
 */
export async function loadTrendingMap(cacheDir) {
    // V19.2 Path Fallback: Check both output/cache and output/ (Artifact download target)
    const paths = [
        path.join(cacheDir, 'trending.json.gz'),
        path.join(path.dirname(cacheDir), 'trending.json.gz'),
    ];

    const trendingMap = new Map();
    let loaded = false;

    for (const trendingPath of paths) {
        try {
            const trendingRaw = await fs.readFile(trendingPath);
            const trendingData = JSON.parse(zlib.gunzipSync(trendingRaw));

            // V18.2.1: Unified Tiered Structure (models, papers, etc.)
            const items = [
                ...(trendingData.items || []),
                ...(trendingData.trending || []),
                ...(trendingData.models || []),
                ...(trendingData.papers || []),
                ...(trendingData.agents || []),
                ...(trendingData.spaces || []),
                ...(trendingData.datasets || []),
                ...(trendingData.tools || [])
            ];

            items.forEach((item, index) => {
                if (!item.id && !item.slug) return;
                trendingMap.set(item.id || item.slug, {
                    rank: index + 1,
                    is_trending: true
                });
            });
            console.log(`[VFS] Loaded ${trendingMap.size} trending context items from ${path.basename(trendingPath)}.`);
            loaded = true;
            break;
        } catch (e) {
            continue;
        }
    }

    if (!loaded) {
        console.warn(`[VFS] ⚠️ No trending.json.gz found in ${cacheDir} or parent. Proceeding without trending flags.`);
    }
    return trendingMap;
}

/**
 * Load 7d Trend Sparklines for DB embedding
 */
export async function loadTrendMap(cacheDir) {
    // V19.2 Path Fallback
    const paths = [
        path.join(cacheDir, 'trend-data.json.gz'),
        path.join(path.dirname(cacheDir), 'trend-data.json.gz'),
    ];

    const trendMap = new Map();
    let loaded = false;

    for (const trendPath of paths) {
        try {
            const trendRaw = await fs.readFile(trendPath);
            const trendData = JSON.parse(zlib.gunzipSync(trendRaw));

            // V18.2.3: Handle object-based structure (id -> { scores: [], ... })
            for (const [id, value] of Object.entries(trendData)) {
                if (Array.isArray(value)) {
                    trendMap.set(id, value.join(','));
                } else if (value && value.scores) {
                    trendMap.set(id, value.scores.join(','));
                }
            }
            console.log(`[VFS] Loaded ${trendMap.size} trend sparklines from ${path.basename(trendPath)}.`);
            loaded = true;
            break;
        } catch (e) {
            continue;
        }
    }

    if (!loaded) {
        console.warn(`[VFS] ⚠️ No trend-data.json.gz found in ${cacheDir} or parent. Proceeding without sparklines.`);
    }
    return trendMap;
}

/**
 * Collect all fused metadata and apply stable sorting
 */
export async function collectAndSortMetadata(cacheDir, trendingMap, trendMap) {
    const fusedDir = path.join(cacheDir, 'fused');
    const fusedFiles = (await fs.readdir(fusedDir).catch(() => []))
        .filter(f => f.endsWith('.json') || f.endsWith('.json.gz'));

    if (fusedFiles.length === 0) throw new Error(`No fused entities found at ${fusedDir}`);

    const metadataMap = new Map();
    for (const file of fusedFiles) {
        const fullPath = path.join(fusedDir, file);
        try {
            const raw = await fs.readFile(fullPath);
            const parsed = file.endsWith('.gz') ? JSON.parse(zlib.gunzipSync(raw)) : JSON.parse(raw);

            // V22.8: Fused shards contain { shardId, entities: [...], _ts }
            const entities = parsed.entities || (parsed.id ? [parsed] : [parsed]);

            for (const entity of entities) {
                const id = entity.id || entity.slug;
                if (!id) continue;

                // Deduplication: Prefer more recent or compressed if collision
                if (metadataMap.has(id) && file.endsWith('.json')) continue;

                const trendingInfo = trendingMap.get(id) || { rank: 999999, is_trending: false };

                metadataMap.set(id, {
                    ...entity,
                    _trending_rank: trendingInfo.rank,
                    is_trending: trendingInfo.is_trending,
                    _trend_7d: trendMap.get(id) || ''
                });
            }

            if (metadataMap.size % 50000 === 0 && metadataMap.size > 0) console.log(`[VFS] Collected ${metadataMap.size} unique items...`);
        } catch (e) {
            console.error(`[VFS] Failed to read ${file}:`, e.message);
        }
    }

    const metadataBatch = Array.from(metadataMap.values());
    metadataMap.clear();

    // Stable Popularity Sorting
    console.log(`[VFS] Performing Stable Popularity Sorting for ${metadataBatch.length} entities...`);
    return metadataBatch.sort((a, b) => {
        const scoreA = a.fni_score ?? a.fni ?? 0;
        const scoreB = b.fni_score ?? b.fni ?? 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        if (a._trending_rank !== b._trending_rank) return a._trending_rank - b._trending_rank;
        return (a.id || '').localeCompare(b.id || '');
    });
}

// V23.1: Builders extracted to satisfy CES Art 5.1
export { buildBundleJson, buildEntityRow } from './row-builders.js';

// ── V23.1: Shard DB Extracted Utilities ─────────

/**
 * Configure SQLite pragmas for high-density 16KB VFS operations
 */
export function setupDatabasePragmas(db) {
    db.pragma('page_size = 16384');
    db.pragma('auto_vacuum = 0');
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = OFF');
    db.pragma('encoding = "UTF-8"');
}

/**
 * Inject essential site metadata into all database partitions
 */
export async function injectMetadata(metaDbs, searchDb, cacheDir) {
    const metaFiles = [
        { key: 'category_stats', file: 'category_stats.json' },
        { key: 'trending', file: 'trending.json' },
        { key: 'relations', file: 'relations/explicit.json' },
        { key: 'knowledge_links', file: 'relations/knowledge-links.json' }
    ];

    for (const meta of metaFiles) {
        try {
            const possiblePaths = [path.join(cacheDir, meta.file), path.join(cacheDir, `${meta.file}.gz`)];
            let content = null;
            for (const p of possiblePaths) {
                try {
                    const raw = await fs.readFile(p);
                    content = (p.endsWith('.gz') || (raw[0] === 0x1f && raw[1] === 0x8b)) ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
                    break;
                } catch (err) { continue; }
            }
            if (content) {
                Object.values(metaDbs).forEach(db => {
                    db.prepare('INSERT OR REPLACE INTO site_metadata (key, value) VALUES (?, ?)').run(meta.key, content);
                });
                searchDb.prepare('INSERT OR REPLACE INTO site_metadata (key, value) VALUES (?, ?)').run(meta.key, content);
            }
        } catch (e) { }
    }
}

/**
 * Generate a formatted build summary report for the V23.1 Shard-DB architecture
 */
export function printBuildSummary(metaDbs, searchDb, stats, currentShardId) {
    const fsSync = (await import('fs')).default;
    console.log('\n' + '='.repeat(70));
    console.log('           💎 V23.1 SHARD-DB BUILD SUMMARY REPORT 💎');
    console.log('='.repeat(70));
    console.log(`${'Partition Name'.padEnd(25)} | ${'Entities'.padEnd(12)} | ${'Size (MB)'.padEnd(12)} | ${'Status'}`);
    console.log('-'.repeat(70));

    const finalReportDbs = { ...metaDbs, "full-search": searchDb };
    for (const [name, db] of Object.entries(finalReportDbs)) {
        const fileStats = fsSync.statSync(db.name);
        const sizeMB = (fileStats.size / 1024 / 1024).toFixed(2);
        const count = db.prepare('SELECT count(*) as c FROM entities').get().c;
        const status = (fileStats.size > 125 * 1024 * 1024) ? '⚠️ OOM RISK' : '✅ OK';
        console.log(`${name.padEnd(25)} | ${String(count).padEnd(12)} | ${String(sizeMB).padEnd(12)} | ${status}`);
    }
    console.log('='.repeat(70));
    console.log(`[VFS] Fused Binary Shards : ${currentShardId + 1}`);
    console.log(`[VFS] Total Heavy Entities : ${stats.heavy} (${(stats.bytes / 1024 / 1024).toFixed(2)} MB)`);
    console.log('='.repeat(70) + '\n');
}

export const cyrb53 = (str, seed = 0) => {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

export function getModelShardIndex(nameStr) {
    const hash = cyrb53(nameStr || '');
    return (hash % 5) + 1; // Returns 1, 2, 3, 4, 5
}


