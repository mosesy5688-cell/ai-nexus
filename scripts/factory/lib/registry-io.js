/**
 * Registry IO Module V16.2.7
 * Constitution Reference: Art 3.1 (Aggregator), Art 5.1 (Modular)
 * 
 * Handles sharded storage operations for the 294k entity global registry.
 */

import fs from 'fs/promises';
import { loadWithFallback, saveWithBackup } from './cache-manager.js';

/**
 * Load Global Registry for stateful factory (V16.2.3 Sharded)
 */
export async function loadGlobalRegistry() {
    const manifestFilename = 'global-registry-manifest.json';
    const legacyFilename = 'global-registry.json';

    // V16.2.14 Update: USER confirmed the authoritative source is meta/backup/global-registry.json
    // We attempt loading the single-file registry first to restore the 200k+ existing entities.
    console.log(`[CACHE] Restoring authoritative memory from ${legacyFilename}...`);
    const legacy = await loadWithFallback(legacyFilename, { entities: [] });

    if (legacy.entities && legacy.entities.length > 50000) {
        console.log(`[CACHE] ✅ Successfully restored ${legacy.entities.length} entities from storage.`);
        return {
            entities: legacy.entities,
            lastUpdated: legacy.lastUpdated || new Date().toISOString(),
            count: legacy.entities.length
        };
    }

    // Fallback: Check for sharded manifest if legacy is unavailable or small
    console.log('[CACHE] Legacy registry not found or empty. Checking for sharded manifest...');
    const manifest = await loadWithFallback(manifestFilename, { totalShards: 0, count: 0 });

    const allEntities = [];
    if (manifest.totalShards > 0) {
        console.log(`[CACHE] Found sharded index: ${manifest.totalShards} shards.`);
        for (let i = 0; i < manifest.totalShards; i++) {
            const shard = await loadWithFallback(`global-registry-part-${i}.json`, { entities: [] });
            allEntities.push(...(shard.entities || []));
        }
        return {
            entities: allEntities,
            lastUpdated: manifest.lastUpdated || new Date().toISOString(),
            count: allEntities.length
        };
    }

    console.log('[CACHE] ⚠️ Cold start: No registry found in R2. Returning empty context.');
    return {
        entities: [],
        lastUpdated: new Date().toISOString(),
        count: 0
    };
}

/**
 * Save Global Registry (V16.2.3 Sharded)
 */
export async function saveGlobalRegistry(registry) {
    const TOTAL_SHARDS = 20;
    const entities = registry.entities || [];
    const shardSize = Math.ceil(entities.length / TOTAL_SHARDS);

    console.log(`[CACHE] Saving ${entities.length} entities into ${TOTAL_SHARDS} registry shards...`);

    for (let i = 0; i < TOTAL_SHARDS; i++) {
        const slice = entities.slice(i * shardSize, (i + 1) * shardSize);
        await saveWithBackup(`global-registry-part-${i}.json`, {
            shard: i,
            entities: slice,
            count: slice.length
        });
    }

    const manifest = {
        totalShards: TOTAL_SHARDS,
        count: entities.length,
        lastUpdated: new Date().toISOString()
    };
    await saveWithBackup('global-registry-manifest.json', manifest);
}
