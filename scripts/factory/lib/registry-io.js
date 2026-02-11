/**
 * Registry IO Module V16.7.2 (V2.0 Optimization)
 * Constitution Reference: Art 3.1 (Aggregator), Art 5.1 (Modular)
 * 
 * Handles sharded storage operations for 1M+ entities to prevent OOM
 * and GitHub Cache stability issues.
 */

import fs from 'fs/promises';
import path from 'path';
import { SHARD_SIZE, syncCacheState, purgeStaleShards } from './registry-utils.js';
import { loadWithFallback, saveWithBackup } from './cache-core.js';



const REGISTRY_DIR = 'registry';
const MONOLITH_FILE = 'global-registry.json.gz';

/**
 * Load Global Registry with Cache-First Integrity (V18.2.1)
 * Priority: Local Monolith -> Local Shards -> R2 Monolith Backup
 */
export async function loadGlobalRegistry() {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const shardDirPath = path.join(cacheDir, REGISTRY_DIR);
    const monolithPath = path.join(cacheDir, MONOLITH_FILE);
    const REGISTRY_FLOOR = 85000;

    const zlib = await import('zlib');
    const tryLoad = async (filepath) => {
        const data = await fs.readFile(filepath);
        if (filepath.endsWith('.gz') || (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b)) {
            return JSON.parse(zlib.gunzipSync(data).toString('utf-8'));
        }
        return JSON.parse(data.toString('utf-8'));
    };

    // 1. Try Local Monolith (GZ Preferred)
    if (process.env.FORCE_R2_RESTORE !== 'true') {
        try {
            const registry = await tryLoad(monolithPath);
            const count = registry.entities?.length || 0;
            if (count >= REGISTRY_FLOOR) {
                console.log(`[CACHE] ✅ Local Monolith hit: ${count} entities.`);
                return { entities: registry.entities, count, lastUpdated: registry.lastUpdated, didLoadFromStorage: true };
            }
        } catch { }

        console.log(`[CACHE] 🧩 Initializing Zero-Loss Registry Restoration...`);

        let allEntities = [];

        // 1. Try Local Shards (Primary Source of Truth)
        const shardFiles = await fs.readdir(shardDirPath).catch(() => []);
        const validShards = shardFiles.filter(f => f.startsWith('part-') && (f.endsWith('.json.gz') || f.endsWith('.json')));

        if (validShards.length > 0) {
            console.log(`[CACHE] 🧩 Found ${validShards.length} shards in local cache. Merging...`);
            for (const s of validShards.sort()) {
                try {
                    const recovered = await loadWithFallback(`registry/${s}`, null, false);
                    if (recovered && (recovered.entities || Array.isArray(recovered))) {
                        const entities = recovered.entities || recovered;
                        allEntities = allEntities.concat(entities);
                    } else {
                        throw new Error(`Shard ${s} returned empty content`);
                    }
                } catch (e) {
                    console.error(`[CACHE] ❌ CRITICAL: Shard corruption detected in ${s}: ${e.message}`);
                    // Zero-Loss Integrity: Halt unless lossy recovery is explicitly allowed
                    if (process.env.ALLOW_LOSSY_RECOVERY !== 'true') {
                        throw new Error(`Registry integrity breach at ${s}. Build halted to prevent permanent data loss.`);
                    }
                }
            }

            if (allEntities.length >= REGISTRY_FLOOR) {
                console.log(`[CACHE] ✅ Restored ${allEntities.length} entities from shards. (Baseline: 121,603)`);
                return { entities: allEntities, count: allEntities.length, didLoadFromStorage: true };
            }
        }
    }

    // 2. R2 Fallback (Emergency Recovery)
    if (allEntities.length < REGISTRY_FLOOR && (process.env.ALLOW_R2_RECOVERY === 'true' || process.env.FORCE_R2_RESTORE === 'true')) {
        console.log(`[CACHE] 🌐 Local Cache missed or forced. Attempting R2 Restoration...`);
        try {
            // Priority 1: Sharded R2 (V18.2.1+)
            let i = 0;
            while (i < 1000) {
                const shardName = `registry/part-${String(i).padStart(3, '0')}.json.gz`;
                // loadWithFallback handles R2 download to local cache
                const recovered = await loadWithFallback(shardName, null, false);
                if (recovered && (recovered.entities || Array.isArray(recovered))) {
                    const entities = recovered.entities || recovered;
                    allEntities = allEntities.concat(entities);
                    i++;
                } else break;
            }

            if (allEntities.length >= REGISTRY_FLOOR) {
                console.log(`[CACHE] ✅ R2 Shards restored: ${allEntities.length} entities.`);
                return { entities: allEntities, count: allEntities.length, didLoadFromStorage: true };
            }

            // Priority 2: Monolith R2 (Legacy Fallback)
            const registry = await loadWithFallback(MONOLITH_FILE, { entities: [] }, false);
            if (registry.entities?.length >= REGISTRY_FLOOR) {
                console.log(`[CACHE] ✅ R2 Monolith restored: ${registry.entities.length} entities.`);
                return { entities: registry.entities, count: registry.entities.length, didLoadFromStorage: true };
            }
        } catch (e) {
            console.error(`[CACHE] ❌ R2 Restoration failed: ${e.message}`);
        }
    }

    return { entities: [], count: 0, didLoadFromStorage: false };
}

/**
 * SAVE: Global Registry (Sharded ONLY)
 * V18.2.1: Bypassing RangeError: Invalid string length
 */
export async function saveGlobalRegistry(input) {
    const entities = Array.isArray(input) ? input : (input?.entities || []);
    const count = entities.length;
    const timestamp = new Date().toISOString();

    console.log(`[CACHE] 💾 Persisting Registry (${count} entities)...`);

    // 1. Sharded Save (Atomic Chunks)
    const cacheDir = process.env.CACHE_DIR || './cache';
    const shardDirPath = path.join(cacheDir, REGISTRY_DIR);
    const shardCount = Math.ceil(count / SHARD_SIZE);
    await fs.mkdir(shardDirPath, { recursive: true });

    for (let i = 0; i < shardCount; i++) {
        const shardData = entities.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        const shardName = `registry/part-${String(i).padStart(3, '0')}.json.gz`;
        await saveWithBackup(shardName, { entities: shardData, count: shardData.length, lastUpdated: timestamp }, { compress: true });
    }

    // 2. Monolith save skipped to prevent V8 string length limit crash
    console.log(`[CACHE] ✅ Sharded Registry saved (${shardCount} parts). Monolith skipped for V8 safety.`);

    // 3. Purge stale shards from R2
    await purgeStaleShards('registry', shardCount);

    return { count, shardCount, lastUpdated: timestamp };
}

export { loadFniHistory, saveFniHistory } from './registry-history.js';
export { loadDailyAccum, saveDailyAccum } from './registry-accum.js';
export { syncCacheState, purgeStaleShards };
