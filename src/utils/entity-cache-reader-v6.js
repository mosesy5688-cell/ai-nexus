// src/utils/entity-cache-reader-v6.js
/**
 * V6.2 Universal Entity Cache Reader
 * Constitutional: Art.I-Extended - Frontend D1 = 0
 * 
 * Split from entity-cache-reader.js for CES compliance (250 line limit)
 * Handles V6.2 entity types: Spaces, Datasets, Entity Relations
 * 
 * V9.0: Copied normalizeForCache locally to break circular dependency
 */

export { getDatasetFromCache, getPaperFromCache } from './entity-cache-reader-depth.js';

import { fetchEntityFromR2, normalizeEntitySlug, hydrateEntity } from './entity-cache-reader-core.js';

/**
 * V6.2: Get space data from R2 cache for detail page
 */
export async function getSpaceFromCache(slug, locals) {
    if (!slug) return null;
    const result = await fetchEntityFromR2('space', slug, locals);
    return hydrateEntity(result, 'space');
}

/**
 * V15.1: Get tool data from R2 cache
 */
export async function getToolFromCache(slug, locals) {
    if (!slug) return null;
    const result = await fetchEntityFromR2('tool', slug, locals);
    return hydrateEntity(result, 'tool');
}


/**
 * V6.2: Get related entities from R2 cache
 * @param {string} entityId - Entity ID to find relations for
 * @param {object} locals - Astro locals with runtime env
 * @returns {Promise<Array>} - Array of related entity objects
 */
export async function getRelatedEntities(entityId, locals) {
    if (!entityId) return [];

    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (!r2) {
        console.warn('[RelationsCache] R2 not available');
        return [];
    }

    try {
        // Try to get entity relations from precomputed cache
        let cachePath = 'cache/relations.json';
        let cacheFile = await r2.get(cachePath);

        if (!cacheFile) {
            cachePath = 'cache/relations.json.gz';
            cacheFile = await r2.get(cachePath);
        }

        if (!cacheFile) {
            console.log('[RelationsCache] relations.json(.gz) not found');
            return [];
        }

        const data = await cacheFile.json();
        const links = data.links || [];

        // Filter links where this entity is source or target
        const related = links.filter(link =>
            link.source === entityId || link.target === entityId
        ).map(link => ({
            id: link.source === entityId ? link.target : link.source,
            name: link.source === entityId ? link.target_name : link.source_name,
            author: link.source === entityId ? link.target_author : link.source_author,
            type: link.source === entityId ? link.target_type : link.source_type,
            link_type: link.type,
            confidence: link.confidence
        }));

        console.log(`[RelationsCache] Found ${related.length} relations for ${entityId}`);
        return related;
    } catch (e) {
        console.warn('[RelationsCache] Error reading relations:', e.message);
        return [];
    }
}
