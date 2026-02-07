/**
 * Entity Deduplicator for Ingestion Pipeline
 * V15.8: Augmentative Merging Logic
 */
import { mergeEntities } from './lib/entity-merger.js';

export function deduplicateEntities(entities, config) {
    if (!config.enabled) return entities;

    const seen = new Map();

    for (const entity of entities) {
        if (!entity.id) continue;

        if (seen.has(entity.id)) {
            if (config.mergeStats) {
                const existing = seen.get(entity.id);
                // V16.96.2: Centralized Single-Entity Merging
                const merged = mergeEntities(existing, entity);
                seen.set(entity.id, merged);
            }
        } else {
            seen.set(entity.id, entity);
        }
    }

    return Array.from(seen.values());
}
