/**
 * V19.2 VFS Packing Utilities
 * Extracted to satisfy CES Monolith Ban (Art 5.1).
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import zlib from 'zlib';
import { PackAccumulator } from './pack-accumulator.js';
import { autoDecompress } from './zstd-helper.js';
import { partitionMonolithStreamingly } from './aggregator-stream-utils.js';
/**
 * Load Trending Context for entity prioritization
 */
export async function loadTrendingMap(cacheDir) {
    // V19.2 Path Fallback: Check both output/cache and output/ (Artifact download target)
    const paths = [
        path.join(cacheDir, 'trending.json.zst'),
        path.join(cacheDir, 'trending.json.gz'),
        path.join(path.dirname(cacheDir), 'trending.json.zst'),
        path.join(path.dirname(cacheDir), 'trending.json.gz'),
    ];

    const trendingMap = new Map();
    let loaded = false;

    for (const trendingPath of paths) {
        try {
            const trendingRaw = await fs.readFile(trendingPath);
            const trendingData = JSON.parse(await autoDecompress(trendingRaw));

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
        console.warn(`[VFS] ⚠️ No trending.json.zst found in ${cacheDir} or parent. Proceeding without trending flags.`);
    }
    return trendingMap;
}

/**
 * Load 7d Trend Sparklines for DB embedding
 */
export async function loadTrendMap(cacheDir) {
    // V19.2 Path Fallback
    const paths = [
        path.join(cacheDir, 'trend-data.json.zst'),
        path.join(cacheDir, 'trend-data.json.gz'),
        path.join(path.dirname(cacheDir), 'trend-data.json.zst'),
        path.join(path.dirname(cacheDir), 'trend-data.json.gz'),
    ];

    const trendMap = new Map();
    let loaded = false;

    for (const trendPath of paths) {
        try {
            const trendRaw = await fs.readFile(trendPath);
            const trendData = JSON.parse(await autoDecompress(trendRaw));

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
 * V26.7: Stream fused entities directly — O(1) memory, no accumulator.
 * Calls consumer(entity) for each entity, with trending/trend context baked in.
 */
export async function streamFusedEntities(cacheDir, trendingMap, trendMap, consumer) {
    const fusedDir = path.join(cacheDir, 'fused');
    const fusedFiles = (await fs.readdir(fusedDir).catch(() => []))
        .filter(f => f.endsWith('.json') || f.endsWith('.json.gz') || f.endsWith('.json.zst'));

    if (fusedFiles.length === 0) throw new Error(`No fused entities found at ${fusedDir}`);

    const compressOrder = (f) => f.endsWith('.json') ? 0 : 1;
    fusedFiles.sort((a, b) => compressOrder(a) - compressOrder(b));

    let count = 0;
    for (const file of fusedFiles) {
        const fullPath = path.join(fusedDir, file);
        try {
            const prev = count;
            await partitionMonolithStreamingly(fullPath, (entity) => {
                const ti = trendingMap.get(entity.id || entity.slug) || { rank: 999999, is_trending: false };
                entity._trending_rank = ti.rank;
                entity.is_trending = ti.is_trending;
                entity._trend_7d = trendMap.get(entity.id || entity.slug) || '';
                consumer(entity);
                count++;
            });
            if (count % 50000 < (count - prev) && count > 0) console.log(`[VFS] Streamed ${count} entities...`);
        } catch (e) {
            console.error(`[VFS] Failed to read ${file}:`, e.message);
        }
    }
    console.log(`[VFS] Streaming complete: ${count} entities.`);
    return count;
}

// V23.1: Builders extracted to satisfy CES Art 5.1
export { buildBundleJson, buildEntityRow } from './row-builders.js';

// ── V23.1: Shard DB Extracted Utilities ─────────

/**
 * Configure SQLite pragmas for high-density 16KB VFS operations
 * V5.8 §2.2: WAL mode + explicit checkpoints for atomic reliability
 */
export function setupDatabasePragmas(db, { wal = false, vfsPageSize = true } = {}) {
    if (vfsPageSize) {
        const currentPageSize = db.pragma('page_size', { simple: true });
        db.pragma('page_size = 16384');
        if (currentPageSize !== 16384) db.exec('VACUUM');
    }
    db.pragma('auto_vacuum = 0');
    db.pragma(wal ? 'journal_mode = WAL' : 'journal_mode = DELETE');
    db.pragma('synchronous = OFF');
    db.pragma('encoding = "UTF-8"');
}

/**
 * V5.8 §1.1: Configure FTS5-specific pragmas for incremental merge
 */
export function setupFtsPragmas(db) {
    setupDatabasePragmas(db, { wal: true });
}

/**
 * Inject essential site metadata into all database partitions
 */
export async function injectMetadata(metaDbs, searchDb, cacheDir) {
    const metaFiles = [
        { key: 'category_stats', file: 'category_stats.json' },
        { key: 'trending', file: 'trending.json' },
        { key: 'trend_data', file: 'trend-data.json' },
        { key: 'relations', file: 'relations/explicit.json' },
        { key: 'knowledge_links', file: 'relations/knowledge-links.json' },
        { key: 'mesh_stats', file: 'mesh/stats.json' },
        { key: 'mesh_graph', file: 'mesh/graph.json' },
        { key: 'search_core', file: 'search-core.json' },
        { key: 'search_manifest', file: 'search-manifest.json' }
    ];

    for (const meta of metaFiles) {
        try {
            const possiblePaths = [path.join(cacheDir, meta.file), path.join(cacheDir, `${meta.file}.zst`), path.join(cacheDir, `${meta.file}.gz`)];
            let content = null;
            for (const p of possiblePaths) {
                try {
                    const raw = await fs.readFile(p);
                    content = (await autoDecompress(raw)).toString('utf-8');
                    break;
                } catch (err) { continue; }
            }
            if (content) {
                Object.values(metaDbs).forEach(db => {
                    db.prepare('INSERT OR REPLACE INTO site_metadata (key, value) VALUES (?, ?)').run(meta.key, content);
                });
                if (searchDb) searchDb.prepare('INSERT OR REPLACE INTO site_metadata (key, value) VALUES (?, ?)').run(meta.key, content);
            }
        } catch (e) { }
    }
}

/**
 * Generate a formatted build summary report for the V23.1 Shard-DB architecture
 */
export function printBuildSummary(metaDbs, searchDb, stats, currentShardId) {
    console.log('\n' + '='.repeat(70));
    console.log('           💎 V23.1 SHARD-DB BUILD SUMMARY REPORT 💎');
    console.log('='.repeat(70));
    console.log(`${'Partition Name'.padEnd(25)} | ${'Entities'.padEnd(12)} | ${'Size (MB)'.padEnd(12)} | ${'Status'}`);
    console.log('-'.repeat(70));

    const finalReportDbs = searchDb ? { ...metaDbs, "full-search": searchDb } : { ...metaDbs };
    const offenders = [];
    for (const [name, db] of Object.entries(finalReportDbs)) {
        const fileStats = fsSync.statSync(db.name);
        const sizeMB = (fileStats.size / 1024 / 1024).toFixed(2);
        const count = db.prepare('SELECT count(*) as c FROM entities').get().c;
        const limitMB = 2048;
        const isOver = fileStats.size > limitMB * 1024 * 1024;
        const status = isOver ? `🛑 OVER ${limitMB}MB` : '✅ OK';
        if (isOver) offenders.push({ name, sizeMB, limitMB });
        console.log(`${name.padEnd(25)} | ${String(count).padEnd(12)} | ${String(sizeMB).padEnd(12)} | ${status}`);
    }
    console.log('='.repeat(70));
    console.log(`[VFS] Fused Binary Shards : ${currentShardId + 1}`);
    console.log(`[VFS] Total Heavy Entities : ${stats.heavy} (${(stats.bytes / 1024 / 1024).toFixed(2)} MB)`);
    console.log('='.repeat(70) + '\n');

    if (offenders.length > 0) {
        offenders.forEach(o => console.error(`[CRITICAL] Shard ${o.name} (${o.sizeMB} MB) exceeds ${o.limitMB}MB!`));
        console.error('[CRITICAL] Circuit breaker triggered.');
        process.exit(1);
    }
}
