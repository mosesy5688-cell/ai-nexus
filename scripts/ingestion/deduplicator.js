/**
 * Entity Deduplicator for Ingestion Pipeline
 * V15.8: Augmentative Merging Logic
 */
export function deduplicateEntities(entities, config) {
    if (!config.enabled) return entities;

    const seen = new Map();

    for (const entity of entities) {
        if (!entity.id) continue;

        if (seen.has(entity.id)) {
            if (config.mergeStats) {
                const existing = seen.get(entity.id);
                // 1. Content Priority (Readme)
                if ((entity.body_content?.length || 0) > (existing.body_content?.length || 0)) {
                    existing.body_content = entity.body_content;
                    existing.description = entity.description;
                }
                // 2. Metadata Augmentation (Tags)
                const tagSet = new Set([...(existing.tags || []), ...(entity.tags || [])]);
                existing.tags = Array.from(tagSet);
                // 3. Metric Max (Fairness)
                existing.popularity = Math.max(existing.popularity || 0, entity.popularity || 0);

                // 4. Merge source_trail (V15.8)
                if (entity.source_trail) {
                    try {
                        const existingTrail = typeof existing.source_trail === 'string' ? JSON.parse(existing.source_trail) : (existing.source_trail || []);
                        const newTrail = typeof entity.source_trail === 'string' ? JSON.parse(entity.source_trail) : (entity.source_trail || []);
                        existing.source_trail = JSON.stringify([...existingTrail, ...newTrail]);
                    } catch (e) {
                        // Silent fail
                    }
                }
            }
        } else {
            seen.set(entity.id, entity);
        }
    }

    return Array.from(seen.values());
}
