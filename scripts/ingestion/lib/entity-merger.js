/**
 * Entity Merger Utility V15.8 (CES Compliant)
 * 
 * Handles augmentative merging of two entity objects, preserving
 * content length, technical specs, and consolidated tags.
 * V16.4.3: Fixed missing raw_image_url / quality_score merge loss.
 */

export function mergeEntities(existing, incoming, options = {}) {
    const { slim = false } = options;
    // 1. Base Inclusive Merge
    const mergedObj = { ...existing, ...incoming };

    if (slim) {
        // V18.12.5.14: In Slim Mode, do NOT merge or parse heavy fields
        // This prevents "Slow Leakage" during satellite tasks.
        mergedObj.meta_json = existing.meta_json || incoming.meta_json || null;
        mergedObj.source_trail = existing.source_trail || incoming.source_trail || null;
        mergedObj.body_content = existing.body_content || incoming.body_content || null;
        mergedObj.readme = null;
        mergedObj.content = null;
    } else {
        // 2. Content Quality Guard (Readme) - V18.2.4: Freshness Priority
        const existingLen = existing.body_content?.length || 0;
        const incomingLen = incoming.body_content?.length || 0;
        const isNewer = new Date(incoming._updated || 0) > new Date(existing._updated || 0);

        let useIncoming = true;
        if (existingLen > incomingLen * 1.2 && !isNewer) {
            useIncoming = false;
        }

        if (!useIncoming) {
            mergedObj.body_content = existing.body_content;
            mergedObj.description = existing.description;
        }

        // 3. Metadata Deep Merge (meta_json)
        try {
            const existingMeta = typeof existing.meta_json === 'string' ? JSON.parse(existing.meta_json) : (existing.meta_json || {});
            const newMeta = typeof incoming.meta_json === 'string' ? JSON.parse(incoming.meta_json) : (incoming.meta_json || {});

            const mergedMeta = { ...existingMeta, ...newMeta };
            if (existingMeta.extended && newMeta.extended) {
                mergedMeta.extended = { ...existingMeta.extended, ...newMeta.extended };
            }
            mergedObj.meta_json = JSON.stringify(mergedMeta);
        } catch (e) { /* ignore parse errors */ }

        // 6. Source Trail Consolidation
        try {
            const existingTrail = typeof existing.source_trail === 'string' ? JSON.parse(existing.source_trail) : (existing.source_trail || []);
            const newTrail = typeof incoming.source_trail === 'string' ? JSON.parse(incoming.source_trail) : (incoming.source_trail || []);
            mergedObj.source_trail = JSON.stringify([...existingTrail, ...newTrail].slice(-10));
        } catch (e) { /* fallback */ }
    }

    // 4. Specialized Metric Handling (Stickiness Logic)
    const metricFields = ['fni_score', 'fni', 'quality_score', 'likes', 'downloads'];
    for (const field of metricFields) {
        mergedObj[field] = Math.max(existing[field] || 0, incoming[field] || 0);
    }

    // 5. Tags Union
    const tagSet = new Set([...(existing.tags || []), ...(incoming.tags || [])]);
    mergedObj.tags = Array.from(tagSet);

    // Always preserve identity fields
    mergedObj.id = existing.id || incoming.id;
    mergedObj._updated = incoming._updated || new Date().toISOString();

    return mergedObj;
}
