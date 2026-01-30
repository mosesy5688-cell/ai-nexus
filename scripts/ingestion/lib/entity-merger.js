/**
 * Entity Merger Utility V15.8 (CES Compliant)
 * 
 * Handles augmentative merging of two entity objects, preserving
 * content length, technical specs, and consolidated tags.
 * V16.4.3: Fixed missing raw_image_url / quality_score merge loss.
 */

export function mergeEntities(existing, incoming) {
    const mergedObj = { ...existing };

    // 1. Content Priority (Readme)
    if ((incoming.body_content?.length || 0) > (existing.body_content?.length || 0)) {
        mergedObj.body_content = incoming.body_content;
        mergedObj.description = incoming.description || existing.description;
    }

    // 2. Metadata Augmentation (Deep Merge meta_json)
    try {
        const existingMeta = typeof existing.meta_json === 'string' ? JSON.parse(existing.meta_json) : (existing.meta_json || {});
        const newMeta = typeof incoming.meta_json === 'string' ? JSON.parse(incoming.meta_json) : (incoming.meta_json || {});

        const mergedMeta = { ...existingMeta };
        for (const [key, value] of Object.entries(newMeta)) {
            if (value !== null && value !== undefined) {
                if (typeof value === 'object' && !Array.isArray(value) && existingMeta[key]) {
                    mergedMeta[key] = { ...existingMeta[key], ...value };
                } else {
                    mergedMeta[key] = value;
                }
            }
        }
        mergedObj.meta_json = JSON.stringify(mergedMeta);

        // V16.4.3 Update: Include image and compliance fields
        const techFields = [
            'params_billions', 'architecture', 'context_length', 'hidden_size', 'num_layers',
            'fni', 'fni_score', 'quality_score', 'compliance_status',
            'raw_image_url', 'cover_image_url', 'image_url'
        ];
        for (const field of techFields) {
            if (incoming[field] !== undefined && incoming[field] !== null && incoming[field] !== '') {
                mergedObj[field] = incoming[field];
            }
        }
    } catch (e) {
        // Fallback
    }

    // 4. Tags & Metrics
    const tagSet = new Set([...(existing.tags || []), ...(incoming.tags || [])]);
    mergedObj.tags = Array.from(tagSet);
    mergedObj.likes = Math.max(existing.likes || 0, incoming.likes || 0);
    mergedObj.downloads = Math.max(existing.downloads || 0, incoming.downloads || 0);

    // 5. Source Trail Merging
    try {
        const existingTrail = typeof existing.source_trail === 'string' ? JSON.parse(existing.source_trail) : (existing.source_trail || []);
        const newTrail = typeof incoming.source_trail === 'string' ? JSON.parse(incoming.source_trail) : (incoming.source_trail || []);
        mergedObj.source_trail = JSON.stringify([...existingTrail, ...newTrail]);
    } catch (e) {
        // Fallback
    }

    return mergedObj;
}
