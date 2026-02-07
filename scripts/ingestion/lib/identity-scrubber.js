import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { mergeEntities } from './entity-merger.js';

/**
 * Performs a final pass of ID normalization for all entities.
 * Ensures V2.1 prefix compliance.
 */
export function scrubIdentities(entities) {
    console.log(`\n🛡️ [Merge] Performing Final Identity Scrub (V2.1 Alignment)...`);

    let migratedCount = 0;
    const finalSet = entities.map(e => {
        const oldId = e.id;
        const source = getNodeSource(oldId, e.type);
        const newId = normalizeId(oldId, source, e.type);
        if (oldId !== newId) {
            migratedCount++;
        }
        return { ...e, id: newId };
    });

    // Deduplicate again after scrubbing
    const dedupedMap = new Map();
    for (const entity of finalSet) {
        if (!dedupedMap.has(entity.id)) {
            dedupedMap.set(entity.id, entity);
        } else {
            // V16.96.2: Safe Collision Handling
            // If duplicate after normalization, merge with existing entry to prevent data loss
            const existing = dedupedMap.get(entity.id);
            dedupedMap.set(entity.id, mergeEntities(existing, entity));
        }
    }

    const dedupedSet = Array.from(dedupedMap.values());
    if (dedupedSet.length !== finalSet.length) {
        console.log(`   ⚠️ [Merge] Deduplicated ${finalSet.length - dedupedSet.length} collisions after normalization.`);
    }

    console.log(`   ✓ Identity Scrub Complete: ${migratedCount} IDs migrated to V2.1 Standard.`);
    return dedupedSet;
}
