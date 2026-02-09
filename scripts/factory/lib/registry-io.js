/**
 * Registry IO Module V16.7.2 (V2.0 Optimization)
 * Constitution Reference: Art 3.1 (Aggregator), Art 5.1 (Modular)
 * 
 * Handles sharded storage operations for 1M+ entities to prevent OOM
 * and GitHub Cache stability issues.
 */

import fs from 'fs/promises';
import path from 'path';
import { loadWithFallback, saveWithBackup } from './cache-core.js';

const SHARD_SIZE = 25000;
const REGISTRY_DIR = 'registry';
const MONOLITH_FILE = 'global-registry.json';

/**
 * Load Global Registry with Transparent Sharding (V2.0 Core)
 */
export async function loadGlobalRegistry() {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const shardDirPath = path.join(cacheDir, REGISTRY_DIR);

    // V16.96.2: Shard Purge on Force Restore
    if (process.env.FORCE_R2_RESTORE === 'true') {
        console.log(`[CACHE] 🧹 Force Restore: Purging local shards in ${shardDirPath}...`);
        await fs.rm(shardDirPath, { recursive: true, force: true }).catch(() => { });
        // Fall back directly to monolith/R2
    } else {
        try {
            // 1. Check for sharded directory
            const files = await fs.readdir(shardDirPath);
            const shards = files.filter(f => f.startsWith('part-') && f.endsWith('.json')).sort();

            if (shards.length > 0) {
                console.log(`[CACHE] 🧩 Sharded registry found (${shards.length} parts). Merging...`);
                let allEntities = [];
                let lastUpdated = null;

                for (const shard of shards) {
                    const data = await fs.readFile(path.join(shardDirPath, shard), 'utf-8');
                    const parsed = JSON.parse(data);
                    allEntities = allEntities.concat(parsed.entities || []);
                    if (!lastUpdated) lastUpdated = parsed.lastUpdated;
                }

                console.log(`[CACHE] ✅ Successfully restored ${allEntities.length} entities from shards.`);
                return {
                    entities: allEntities,
                    lastUpdated: lastUpdated || new Date().toISOString(),
                    count: allEntities.length,
                    didLoadFromStorage: true
                };
            }
        } catch (e) {
            if (process.env.FORCE_R2_RESTORE !== 'true') {
                console.log(`[CACHE] No sharded registry found in ${shardDirPath}. Falling back to monolith.`);
            }
        }
    }

    // 2. Monolith Fallback (V16.7 Compatibility)
    console.log(`[CACHE] Restoring authoritative memory from ${MONOLITH_FILE}...`);
    const registry = await loadWithFallback(MONOLITH_FILE, { entities: [] }, true);

    const count = registry.entities?.length || 0;
    if (count > 0) {
        console.log(`[CACHE] ✅ Successfully restored ${count} entities from monolith.`);
        return {
            entities: registry.entities,
            lastUpdated: registry.lastUpdated || new Date().toISOString(),
            count: count,
            didLoadFromStorage: true
        };
    }

    console.log('[CACHE] ❌ Cold start: No registry found in Shards or Monolith.');
    return {
        entities: [],
        lastUpdated: new Date().toISOString(),
        count: 0,
        didLoadFromStorage: false
    };
}

/**
 * Save Global Registry with Dual-Write Support (V2.0 Core)
 */
export async function saveGlobalRegistry(registry) {
    const entities = registry.entities || [];
    const count = entities.length;
    const timestamp = new Date().toISOString();

    console.log(`[CACHE] Saving ${count} entities to sharded registry...`);

    // 1. Save Shards
    const shardCount = Math.ceil(count / SHARD_SIZE);
    for (let i = 0; i < shardCount; i++) {
        const shardEntities = entities.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        const shardData = {
            entities: shardEntities,
            count: shardEntities.length,
            part: i,
            total: shardCount,
            lastUpdated: timestamp
        };
        await saveWithBackup(`${REGISTRY_DIR}/part-${String(i).padStart(3, '0')}.json`, shardData);
    }

    // 2. Dual-Write Monolith (Compatibility Mode)
    if (count < 50000) {
        await saveWithBackup(MONOLITH_FILE, {
            entities,
            count,
            lastUpdated: timestamp
        });
    } else {
        await saveWithBackup(MONOLITH_FILE, {
            status: 'migrated_to_shards',
            shardCount,
            count,
            lastUpdated: timestamp
        });
    }
}

/**
 * Sync entire cache directory for GitHub Cache persistence
 * V2.0: Robust directory-level sync
 */
export async function syncCacheState(sourceDir, targetDir) {
    console.log(`[CACHE] Syncing state: ${sourceDir} → ${targetDir}...`);
    try {
        await fs.mkdir(targetDir, { recursive: true });

        // Use recursive copy if available (Node 16.7+)
        if (fs.cp) {
            await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
        } else {
            // Manual recursive copy for older environments if needed
            const entries = await fs.readdir(sourceDir, { withFileTypes: true });
            for (const entry of entries) {
                const src = path.join(sourceDir, entry.name);
                const dest = path.join(targetDir, entry.name);
                if (entry.isDirectory()) {
                    await syncCacheState(src, dest);
                } else {
                    await fs.copyFile(src, dest);
                }
            }
        }
    } catch (e) {
        console.warn(`[CACHE] Sync failed: ${e.message}`);
    }
}

/**
 * Load FNI History with Sharding Support (V2.0)
 */
export async function loadFniHistory() {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const historyDir = path.join(cacheDir, 'fni-history');

    try {
        const files = await fs.readdir(historyDir);
        const shards = files.filter(f => f.startsWith('part-') && f.endsWith('.json')).sort();

        if (shards.length > 0) {
            console.log(`[CACHE] 🧩 Sharded FNI history found (${shards.length} parts). Merging...`);
            let allEntities = {};
            let lastUpdated = null;

            for (const shard of shards) {
                const data = await fs.readFile(path.join(historyDir, shard), 'utf-8');
                const parsed = JSON.parse(data);
                Object.assign(allEntities, parsed.entities || {});
                if (!lastUpdated) lastUpdated = parsed.lastUpdated;
            }

            return { entities: allEntities, lastUpdated: lastUpdated || new Date().toISOString() };
        }
    } catch { /* fallback to monolith */ }

    return loadWithFallback('fni-history.json', { entities: {}, lastUpdated: null });
}

/**
 * Save FNI History with Sharding Support (V2.0)
 */
export async function saveFniHistory(history) {
    const entities = history.entities || {};
    const keys = Object.keys(entities);
    const count = keys.length;
    const timestamp = new Date().toISOString();

    console.log(`[CACHE] Saving ${count} history entries to shards...`);

    const shardCount = Math.ceil(count / SHARD_SIZE);
    for (let i = 0; i < shardCount; i++) {
        const shardKeys = keys.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        const shardEntities = {};
        for (const k of shardKeys) shardEntities[k] = entities[k];

        await saveWithBackup(`fni-history/part-${String(i).padStart(3, '0')}.json`, {
            entities: shardEntities,
            part: i,
            total: shardCount,
            lastUpdated: timestamp
        });
    }

    // Monolith fallback
    if (count < 50000) {
        await saveWithBackup('fni-history.json', { ...history, lastUpdated: timestamp });
    }
}

export { loadDailyAccum, saveDailyAccum } from './registry-accum.js';
