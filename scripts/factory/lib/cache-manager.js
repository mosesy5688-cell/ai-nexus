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

// Configuration & Overrides
const getCacheDir = () => process.env.CACHE_DIR || './cache';
const getR2Prefix = () => process.env.R2_BACKUP_PREFIX || 'meta/backup/';
const getR2Bucket = () => process.env.R2_BUCKET || 'ai-nexus-assets';

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
    const localPath = path.join(getCacheDir(), filename);

    // Priority 1: Local cache (GH Cache)
    try {
        const data = await fs.readFile(localPath, 'utf-8');
        console.log(`[CACHE] ✅ Loaded from local: ${filename}`);
        return JSON.parse(data);
    } catch {
        console.log(`[CACHE] Local cache miss: ${filename}`);
    }

    // Priority 2: R2 Backup
    const r2Key = `${getR2Prefix()}${filename}`;
    const os = await import('os');
    const tempFile = path.join(os.tmpdir(), `r2-${filename}-${Date.now()}.json`);

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`[CACHE] R2 Restore Attempt ${attempt}/3: ${filename}...`);
            // Use --file instead of --pipe for stability with large objects (54MB)
            execSync(
                `npx wrangler r2 object get ${getR2Bucket()}/${r2Key} --file=${tempFile}`,
                { stdio: 'pipe', timeout: 300000 } // 5min timeout
            );

            const result = await fs.readFile(tempFile, 'utf-8');
            console.log(`[CACHE] ✅ Restored from R2 backup: ${filename}`);

            // Save to local for next time
            await fs.mkdir(getCacheDir(), { recursive: true });
            await fs.writeFile(localPath, result);

            // Cleanup
            await fs.unlink(tempFile).catch(() => { });
            return JSON.parse(result);
        } catch (err) {
            console.warn(`[CACHE] Attempt ${attempt} failed: ${err.message}`);
            if (attempt < 3) {
                console.log('        Retrying in 5s...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    // Cleanup on total failure
    await fs.unlink(tempFile).catch(() => { });

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
    const localPath = path.join(getCacheDir(), filename);
    const content = JSON.stringify(data, null, 2);

    // Save to local (will be captured by GH Cache save)
    await fs.mkdir(getCacheDir(), { recursive: true });
    await fs.writeFile(localPath, content);
    console.log(`[CACHE] Saved to local: ${filename}`);

    // Also save to R2 backup (for recovery if cache expires)
    // V16.2.5: Architecture Guard - Only upload if explicitly enabled
    if (process.env.ENABLE_R2_BACKUP !== 'true') {
        return;
    }

    try {
        const os = await import('os');
        const r2Key = `${getR2Prefix()}${filename}`;
        const tempFile = path.join(os.tmpdir(), filename);
        await fs.writeFile(tempFile, content);
        execSync(
            `npx -y wrangler r2 object put ${getR2Bucket()}/${r2Key} --file=${tempFile}`,
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
 * Re-export sharded registry IO (Art 5.1 modularization)
 */
export { loadGlobalRegistry, saveGlobalRegistry } from './registry-io.js';

// Export cache key constants
export { CACHE_KEYS };
