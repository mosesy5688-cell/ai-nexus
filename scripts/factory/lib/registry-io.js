/**
 * Registry IO Module V16.2.7
 * Constitution Reference: Art 3.1 (Aggregator), Art 5.1 (Modular)
 * 
 * Handles sharded storage operations for the 294k entity global registry.
 */

import fs from 'fs/promises';
import { loadWithFallback, saveWithBackup } from './cache-manager.js';

/**
 * Load Global Registry for stateful factory (V16.3.1 Unified)
 */
export async function loadGlobalRegistry() {
    const filename = 'global-registry.json';

    console.log(`[CACHE] Restoring authoritative memory from ${filename}...`);
    const registry = await loadWithFallback(filename, { entities: [] });

    const count = registry.entities?.length || 0;
    if (count > 0) {
        console.log(`[CACHE] ✅ Successfully restored ${count} entities from storage.`);
        return {
            entities: registry.entities,
            lastUpdated: registry.lastUpdated || new Date().toISOString(),
            count: count
        };
    }

    console.log('[CACHE] ❌ Cold start: No registry found in Cache or R2.');
    return {
        entities: [],
        lastUpdated: new Date().toISOString(),
        count: 0
    };
}

/**
 * Save Global Registry (V16.3.1 Unified)
 */
export async function saveGlobalRegistry(registry) {
    const filename = 'global-registry.json';
    const entities = registry.entities || [];

    console.log(`[CACHE] Saving ${entities.length} entities to unified registry...`);

    await saveWithBackup(filename, {
        entities: entities,
        count: entities.length,
        lastUpdated: new Date().toISOString()
    });
}
