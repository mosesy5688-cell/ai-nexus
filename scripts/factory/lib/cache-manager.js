/**
 * Cache Manager Module V14.5
 * Constitution Reference: Art 2.3 (Cache Safety Net), V14.5 Architecture
 * 
 * Unified cache management for GitHub Actions Cache and R2 backup
 * Implements priority chain: GH Cache → R2 Backup → Cold Start
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

// V14.5 Cache Key Patterns
const CACHE_KEYS = {
    FNI_HISTORY: 'fni-history-v14',
    WEEKLY_ACCUM: 'weekly-accum-v14',
    ENTITY_CHECKSUMS: 'entity-checksums-v14',
    RELATIONS_CACHE: 'relations-cache-v14',
    BENCHMARK_DATA: 'benchmark-cache-v14',
    TREND_HISTORY: 'trend-history-v14',
    SEARCH_FULL: 'search-full-v14',
};

// Default paths
const CACHE_DIR = './cache';
const R2_BACKUP_PREFIX = 'meta/backup/';
const R2_BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';

/**
 * Load data with priority chain (Art 2.3)
 * 1. Try local cache (from GH Cache restore)
 * 2. Try R2 backup
 * 3. Return default if not found
 * 
 * @param {string} filename - File name to load
 * @param {any} defaultValue - Default value if not found
 * @returns {Promise<any>} Loaded data or default
 */
export async function loadWithFallback(filename, defaultValue = {}) {
    const localPath = path.join(CACHE_DIR, filename);

    // Priority 1: Local cache (GH Cache)
    try {
        const data = await fs.readFile(localPath, 'utf-8');
        console.log(`[CACHE] ✅ Loaded from local: ${filename}`);
        return JSON.parse(data);
    } catch {
        console.log(`[CACHE] Local cache miss: ${filename}`);
    }

    // Priority 2: R2 Backup
    try {
        const r2Key = `${R2_BACKUP_PREFIX}${filename}`;
        const result = execSync(
            `npx wrangler r2 object get ${R2_BUCKET}/${r2Key} --pipe`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        console.log(`[CACHE] ✅ Restored from R2 backup: ${filename}`);

        // Save to local for next time
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(localPath, result);

        return JSON.parse(result);
    } catch {
        console.log(`[CACHE] R2 backup miss: ${filename}`);
    }

    // Priority 3: Cold start with default
    console.log(`[CACHE] ⚠️ Cold start: ${filename} using default`);
    return defaultValue;
}

/**
 * Save data to local cache and R2 backup
 * @param {string} filename - File name to save
 * @param {any} data - Data to save
 */
export async function saveWithBackup(filename, data) {
    const localPath = path.join(CACHE_DIR, filename);
    const content = JSON.stringify(data, null, 2);

    // Save to local (will be captured by GH Cache save)
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(localPath, content);
    console.log(`[CACHE] Saved to local: ${filename}`);

    // Also save to R2 backup (for recovery if cache expires)
    try {
        const os = await import('os');
        const r2Key = `${R2_BACKUP_PREFIX}${filename}`;
        const tempFile = path.join(os.tmpdir(), filename);
        await fs.writeFile(tempFile, content);
        execSync(
            `npx wrangler r2 object put ${R2_BUCKET}/${r2Key} --file=${tempFile}`,
            { stdio: 'pipe' }
        );
        console.log(`[CACHE] Backed up to R2: ${r2Key}`);
    } catch (err) {
        console.warn(`[CACHE] ⚠️ R2 backup failed: ${err.message}`);
    }
}

/**
 * Load FNI History with fallback
 * @returns {Promise<Object>} FNI history data
 */
export async function loadFniHistory() {
    return loadWithFallback('fni-history.json', {
        entities: {},
        lastUpdated: null,
    });
}

/**
 * Save FNI History
 * @param {Object} history - FNI history data
 */
export async function saveFniHistory(history) {
    history.lastUpdated = new Date().toISOString();
    await saveWithBackup('fni-history.json', history);
}

/**
 * Load Weekly Accumulator with fallback
 * @returns {Promise<Object>} Weekly accumulator data
 */
export async function loadWeeklyAccum() {
    return loadWithFallback('weekly-accum.json', {
        week: null,
        entries: [],
        startDate: null,
    });
}

/**
 * Save Weekly Accumulator
 * @param {Object} accum - Weekly accumulator data
 */
export async function saveWeeklyAccum(accum) {
    await saveWithBackup('weekly-accum.json', accum);
}

/**
 * Load Entity Checksums for Smart Write
 * @returns {Promise<Object>} Entity checksums map
 */
export async function loadEntityChecksums() {
    return loadWithFallback('entity-checksums.json', {});
}

/**
 * Save Entity Checksums
 * @param {Object} checksums - Entity checksums map
 */
export async function saveEntityChecksums(checksums) {
    await saveWithBackup('entity-checksums.json', checksums);
}

/**
 * Load Global Registry for stateful factory
 * @returns {Promise<Object>} Registry data
 */
export async function loadGlobalRegistry() {
    return loadWithFallback('global-registry.json', {
        entities: [],
        lastUpdated: null,
        count: 0
    });
}

/**
 * Save Global Registry
 * @param {Object} registry - Registry data
 */
export async function saveGlobalRegistry(registry) {
    registry.lastUpdated = new Date().toISOString();
    registry.count = registry.entities?.length || 0;
    await saveWithBackup('global-registry.json', registry);
}

// Export cache key constants
export { CACHE_KEYS };
