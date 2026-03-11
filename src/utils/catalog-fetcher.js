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
    const SSR_TIMEOUT_MS = 15000; // 15s max — prevents Cloudflare 524 timeout

    try {
        const result = await Promise.race([
            _fetchCatalogDataInner(type, runtime, start),
            new Promise((_, reject) => setTimeout(() => reject(new Error('SSR timeout')), SSR_TIMEOUT_MS))
        ]);
        return result;
    } catch (e) {
        console.error(`[CatalogFetcher] ${e.message} after ${Date.now() - start}ms for ${type}`);
        return { items: [], totalPages: 1, totalEntities: 0, error: e.message, source: 'vfs-timeout' };
    }
}

async function _fetchCatalogDataInner(type, runtime, start) {
    const env = (runtime)?.env || (runtime) || {};
    const r2Bucket = env.R2_ASSETS;

    // V23.1 Simulation Guard
    const isDev = !!import.meta.env?.DEV;
    const shouldSimulate = !!env.SIMULATE_PRODUCTION || (isDev && env.NODE_ENV !== 'production');

    // V23.6: Detect category vs entity type
    const isCategory = !ENTITY_TYPES.includes(type);

    const manifest = await loadManifest(r2Bucket, shouldSimulate);

    let sql, sqlParams, shardList;
    if (isCategory) {
        sql = `SELECT id, name, type, author, SUBSTR(summary, 1, 200) as summary, fni_score, downloads, stars, params_billions, context_length, last_modified as last_updated, category, pipeline_tag, license, vram_estimate_gb, architecture, task_categories, num_rows, primary_language, forks, citation_count FROM entities WHERE category = ? ORDER BY fni_score DESC LIMIT 48`; // V25.1: Aligned with Tabular Density spec
        sqlParams = [type];
        const { priority } = determineTargetDbs('all', '', 1, manifest);
        shardList = priority.slice(0, 3);
    } else {
        sql = `SELECT id, name, type, author, SUBSTR(summary, 1, 200) as summary, fni_score, downloads, stars, params_billions, context_length, last_modified as last_updated, pipeline_tag, license, vram_estimate_gb, architecture, task_categories, num_rows, primary_language, forks, citation_count FROM entities WHERE type = ? ORDER BY fni_score DESC LIMIT 48`; // V25.1: Aligned with Tabular Density spec
        sqlParams = [type];
        const { priority } = determineTargetDbs(type, '', 1, manifest);
        // V24.10d: Only query 1 shard for SSR speed — client lazy-loads the rest
        shardList = priority.slice(0, 1);
    }

    // Query single priority shard for SSR (speed-safe)
    let allRows = [];
    for (const dbName of shardList) {
        try {
            const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
            const rows = await executeSql(engine.sqlite3, engine.db, sql, sqlParams);
            allRows = allRows.concat(rows);
        } catch (e) {
            console.warn(`[CatalogFetcher] Shard ${dbName} failed:`, e.message);
        }
    }

    // Sort & Deduplicate
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
        totalEntities: normalized.length,
        error: null,
        source: 'vfs-federated'
    };
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
        vram_est: item.vram_estimate_gb || item.vram_est || 0,
        license: item.license || '',
        architecture: item.architecture || '',
        last_updated: item.last_updated || '',
        task_categories: item.task_categories || '',
        num_rows: item.num_rows || 0,
        primary_language: item.primary_language || '',
        forks: item.forks || 0,
        citation_count: item.citation_count || 0
    };
}
