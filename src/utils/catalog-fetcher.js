/**
 * catalog-fetcher.js (V23.6 - SHARD-DB 4.0 Standard)
 * ARCHITECTURE: PURE VFS (Zero JSON Mandate)
 */
import { DataNormalizer } from '../scripts/lib/DataNormalizer.js';
import { getCachedDbConnection, loadManifest, executeSql } from '../lib/sqlite-engine';
import { determineTargetDbs } from './search-query-builder';

/**
 * Fetches catalog data using the Federated VFS Engine (wa-sqlite)
 * Optimized for 128MB Workers SSR (No large file loads)
 */
const ENTITY_TYPES = ['model', 'dataset', 'agent', 'tool', 'space', 'paper', 'prompt'];

export async function fetchCatalogData(type, runtime = null) {
    const start = Date.now();
    const env = (runtime)?.env || (runtime) || {};
    const r2Bucket = env.R2_ASSETS;

    // V23.1 Simulation Guard
    const isDev = !!import.meta.env?.DEV;
    const shouldSimulate = !!env.SIMULATE_PRODUCTION || (isDev && env.NODE_ENV !== 'production');

    // V23.6: Detect category vs entity type
    const isCategory = !ENTITY_TYPES.includes(type);

    try {
        const manifest = await loadManifest(r2Bucket, shouldSimulate);

        let sql, sqlParams, shardList;
        if (isCategory) {
            // Category query: search across priority shards with WHERE category = ?
            sql = `SELECT id, name, type, author, SUBSTR(summary, 1, 200) as summary, fni_score, downloads, stars, params_billions, context_length, last_modified as last_updated, category, pipeline_tag FROM entities WHERE category = ? ORDER BY fni_score DESC LIMIT 24`;
            sqlParams = [type];
            const { priority } = determineTargetDbs('all', '', 1, manifest);
            shardList = priority.slice(0, 3);
        } else {
            sql = `SELECT id, name, type, author, SUBSTR(summary, 1, 200) as summary, fni_score, downloads, stars, params_billions, context_length, last_modified as last_updated FROM entities WHERE type = ? ORDER BY fni_score DESC LIMIT 24`;
            sqlParams = [type];
            const { priority } = determineTargetDbs(type, '', 1, manifest);
            shardList = priority.slice(0, 2);
        }

        // Query priority shards only for SSR (memory-safe)
        let allRows = [];
        const promises = shardList.map(async (dbName) => {
            const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
            return await executeSql(engine.sqlite3, engine.db, sql, sqlParams);
        });

        const results = await Promise.all(promises);
        allRows = results.flat();

        // Federated Sort & Deduplicate
        allRows.sort((a, b) => b.fni_score - a.fni_score);

        const uniqueItems = [];
        const seen = new Set();
        for (const item of allRows) {
            if (!seen.has(item.id)) {
                seen.add(item.id);
                uniqueItems.push(item);
            }
        }

        const normalized = DataNormalizer.normalizeCollection(uniqueItems, type);
        console.log(`[CatalogFetcher] VFS Resolved ${normalized.length} items for ${type} in ${Date.now() - start}ms`);

        return {
            items: normalized,
            totalPages: Math.ceil(manifest.partitions?.[type] || 1),
            totalEntities: normalized.length, // Placeholder for SSR
            error: null,
            source: 'vfs-federated'
        };

    } catch (e) {
        console.error(`[CatalogFetcher] VFS Failed:`, e.message);
        return { items: [], totalPages: 1, totalEntities: 0, error: e.message, source: 'vfs-error' };
    }
}

/**
 * Truncates and cleans data for lightweight SSR injection
 */
export function truncateListingItem(item) {
    if (!item) return null;
    return {
        id: item.id,
        name: item.name,
        author: item.author,
        description: item.summary || item.description || '',
        type: item.type,
        downloads: item.downloads || 0,
        likes: item.likes || 0,
        stars: item.stars || 0,
        fni_score: item.fni_score || 0,
        pipeline_tag: item.pipeline_tag || item.task || '',
        typeLabel: item.typeLabel || (item.pipeline_tag || item.type || '').replace(/-/g, ' '),
        params_billions: item.params_billions || 0,
        context_length: item.context_length || 0,
        vram_est: item.vram_est || 0,
        last_updated: item.last_updated || ''
    };
}
