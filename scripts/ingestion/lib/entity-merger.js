/**
 * Entity Merger Utility V15.8 (CES Compliant)
 * 
 * Handles augmentative merging of two entity objects, preserving
 * content length, technical specs, and consolidated tags.
 * V16.4.3: Fixed missing raw_image_url / quality_score merge loss.
 */

export function mergeEntities(existing, incoming) {
    // 1. Base Inclusive Merge (V18.2.1 GA: Stop whitelisting to prevent data loss)
    const mergedObj = { ...existing, ...incoming };

    // 2. Content Quality Guard (Readme) - V18.2.4: Freshness Priority
    // Prefer incoming if it's newer, even if slightly shorter (down to 80% of existing length)
    const existingLen = existing.body_content?.length || 0;
    const incomingLen = incoming.body_content?.length || 0;
    const isNewer = new Date(incoming._updated || 0) > new Date(existing._updated || 0);

    let useIncoming = true;
    if (existingLen > incomingLen * 1.2 && !isNewer) {
        // Only stick to existing if it's significantly longer and NOT older
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
        // Deep merge 'extended' or other known sub-objects if they exist
        if (existingMeta.extended && newMeta.extended) {
            mergedMeta.extended = { ...existingMeta.extended, ...newMeta.extended };
        }
        mergedObj.meta_json = JSON.stringify(mergedMeta);
    } catch (e) { /* ignore parse errors */ }

    // 4. Specialized Metric Handling (Stickiness Logic)
    // High-water mark for scores and likes/downloads to prevent metric jitter
    const metricFields = ['fni_score', 'fni', 'quality_score', 'likes', 'downloads'];
    for (const field of metricFields) {
        mergedObj[field] = Math.max(existing[field] || 0, incoming[field] || 0);
    }

    // 5. Tags Union
    const tagSet = new Set([...(existing.tags || []), ...(incoming.tags || [])]);
    mergedObj.tags = Array.from(tagSet);

    // 6. Source Trail Consolidation
    try {
        const existingTrail = typeof existing.source_trail === 'string' ? JSON.parse(existing.source_trail) : (existing.source_trail || []);
        const newTrail = typeof incoming.source_trail === 'string' ? JSON.parse(incoming.source_trail) : (incoming.source_trail || []);
        // deduplicate trail entries by a unique key if possible, or just concat
        mergedObj.source_trail = JSON.stringify([...existingTrail, ...newTrail].slice(-10)); // Keep last 10 steps
    } catch (e) { /* fallback */ }

    // Always preserve identity fields
    mergedObj.id = existing.id || incoming.id;
    mergedObj._updated = incoming._updated || new Date().toISOString();

    return mergedObj;
}
