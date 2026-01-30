/**
 * Registry Manager V16.2
 * SPEC: SPEC-REGISTRY-V16.2
 * 
 * Manages the persistent list of all 140k+ entities in R2.
 */

import { loadGlobalRegistry, saveGlobalRegistry } from './cache-manager.js';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { mergeEntities } from '../../ingestion/lib/entity-merger.js';

export class RegistryManager {
    constructor() {
        this.registry = { entities: [], lastUpdated: null, count: 0 };
    }

    /**
     * Load the registry from cache/R2
     */
    async load() {
        console.log('[REGISTRY] Loading global registry...');
        this.registry = await loadGlobalRegistry();
        console.log(`  [REGISTRY] Found ${this.registry.count} entities in archive`);
        return this.registry;
    }

    /**
     * Merge individual entity metadata intelligently
     */
    mergeEntityMetadata(existing, incoming) {
        return mergeEntities(existing, incoming);
    }

    /**
     * Merge current batch entities into the registry
     * Priority: Balanced Merge (v16.2.3)
     */
    async mergeCurrentBatch(batchEntities) {
        console.log(`[REGISTRY] Merging ${batchEntities.length} batch entities into registry...`);

        const registryMap = new Map();
        let archivedCount = 0;
        let activeCount = 0;
        let mergedCount = 0;

        // 1. Seed with existing registry
        for (const e of this.registry.entities) {
            const id = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
            registryMap.set(id, { ...e, status: 'archived' });
            archivedCount++;
        }

        // 2. Intelligence Merge with current batch
        for (const e of batchEntities) {
            const id = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
            const existing = registryMap.get(id);

            if (existing) {
                const merged = this.mergeEntityMetadata(existing, e);
                registryMap.set(id, {
                    ...merged,
                    status: 'active', // Promotion to active
                    _last_seen: new Date().toISOString()
                });
                mergedCount++;
            } else {
                registryMap.set(id, {
                    ...e,
                    status: 'active',
                    _last_seen: new Date().toISOString()
                });
                activeCount++;
            }
        }

        // 3. Convert back to array and apply FNI decay for archived entities
        const finalEntities = Array.from(registryMap.values()).map(e => {
            if (e.status === 'archived') {
                // FNI Decay: Historical entities sink naturally
                return { ...e, fni_score: (e.fni_score || 0) * 0.95 };
            }
            return e;
        });

        // 4. Sort by FNI and update state
        this.registry.entities = finalEntities.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));
        this.registry.count = this.registry.entities.length;

        console.log(`  [REGISTRY] Merge Stats:`);
        console.log(`    - Archived (Persistent): ${archivedCount}`);
        console.log(`    - Active (Newly Harvested): ${activeCount}`);
        console.log(`    - Merged (Updated): ${mergedCount}`);
        console.log(`    - Final Deduplicated Total: ${this.registry.count}`);

        return this.registry;
    }

    /**
     * Save the registry to cache/R2
     */
    async save() {
        console.log('[REGISTRY] Saving global registry...');
        await saveGlobalRegistry(this.registry);
    }

    /**
     * Get the full list for indexing (Sitemap/Search)
     */
    getEntitiesForIndexing() {
        return this.registry.entities;
    }
}
