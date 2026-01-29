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
    console.log('[CACHE] Loading sharded global registry...');

    // V16.2.4: Priority 0 - Local GitHub Seed (One-time Restoration Guide)
    const seedPath = 'data/global-registry.json';
    try {
        const seedData = await fs.readFile(seedPath, 'utf-8');
        const parsed = JSON.parse(seedData);
        if (parsed.entities && parsed.entities.length > 50000) {
            console.log(`[CACHE] 🏆 Found GitHub Seed: ${seedPath} (${parsed.entities.length} entities)`);
            console.log(`        Using this as the authoritative memory for this run.`);
            return {
                entities: parsed.entities,
                lastUpdated: parsed.lastUpdated || new Date().toISOString(),
                count: parsed.entities.length
            };
        }
    } catch (e) {
        // No seed found, continue to normal flow
    }

    const manifest = await loadWithFallback('global-registry-manifest.json', { totalShards: 0, count: 0 });

    const allEntities = [];
    if (manifest.totalShards > 0) {
        for (let i = 0; i < manifest.totalShards; i++) {
            const shard = await loadWithFallback(`global-registry-part-${i}.json`, { entities: [] });
            allEntities.push(...(shard.entities || []));
        }
    } else {
        // V16.2.7 Bridge: Fallback to legacy single-file registry for the first sharded run
        console.log('[CACHE] Sharded registry not found. Attempting legacy bridge to global-registry.json...');
        const legacy = await loadWithFallback('global-registry.json', { entities: [] });
        allEntities.push(...(legacy.entities || []));
    }

    return {
        entities: allEntities,
        lastUpdated: manifest.lastUpdated || new Date().toISOString(),
        count: allEntities.length
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
