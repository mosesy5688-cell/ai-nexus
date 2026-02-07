// src/utils/entity-cache-reader.js
/**
 * V4.9.1 Entity Cache Reader
 * Constitutional: Art.I-Extended - Frontend D1 = 0
 * 
 * This module reads pre-computed entity data from R2 cache files
 * instead of querying D1 database directly.
 * 
 * CEO Iron Rule: Frontend must ONLY use R2 cache - no D1 access
 */

import { fetchEntityFromR2, normalizeEntitySlug, hydrateEntity } from './entity-cache-reader-core.js';
import { getTypeFromId } from './mesh-routing-core.js';

/**
 * Resolve an entity from R2 cache (Constitutional: D1 = 0)
 */
export async function resolveEntityFromCache(slug, locals) {
    if (!slug) return { entity: null, source: 'invalid-slug' };

    const slugStr = Array.isArray(slug) ? slug.join('/') : (slug || '');
    const type = getTypeFromId(slugStr);

    const result = await fetchEntityFromR2(type, slug, locals);
    if (!result) return { entity: null, source: 'cache-miss' };

    return {
        ...result,
        entity: result.entity,
        source: result._cache_source || 'r2-cache'
    };
}

/**
 * Get model data from R2 cache for detail page
 */
export async function getModelFromCache(slug, locals) {
    const result = await fetchEntityFromR2('model', slug, locals);
    if (!result) return null;

    const hydrated = hydrateEntity(result, 'model');

    return {
        ...hydrated,
        similar_models: hydrated.similar_models || hydrated.relations?.links || [],
        seo_summary: result.seo || {},
        _cache_source: result._cache_source,
        _contract_version: hydrated._contract_version || 'V15'
    };
}

/**
 * Check if entity exists in cache
 * @param {string} slug - Entity slug
 * @param {object} locals - Astro locals
 * @returns {Promise<boolean>}
 */
export async function entityExistsInCache(slug, locals) {
    const result = await resolveEntityFromCache(slug, locals);
    return result.entity !== null;
}

// V6.2: Re-export functions from split module for backward compatibility
export {
    getSpaceFromCache,
    getDatasetFromCache,
    getRelatedEntities
} from './entity-cache-reader-v6.js';
