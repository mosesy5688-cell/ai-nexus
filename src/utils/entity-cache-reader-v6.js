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

/**
 * Normalize slug for cache file lookup (copied from entity-cache-reader.js)
 * Handles both new format (author/model) and legacy format (source:author/model)
 * @param {string} slug - Input slug
 * @returns {string} - Normalized slug for file path
 */
function normalizeForCache(slug) {
    if (!slug) return '';
    // Remove any source prefix first (e.g., "huggingface:")
    let normalized = slug.replace(/^[a-z]+:/i, '');
    return normalized
        .toLowerCase()
        .trim()
        .replace(/\//g, '--')
        .replace(/:/g, '--');
}

/**
 * V6.2: Get space data from R2 cache for detail page
 * @param {string} slug - Space slug (format: author--name)
 * @param {object} locals - Astro locals
 * @returns {Promise<object|null>} - Space data or null
 */
export async function getSpaceFromCache(slug, locals) {
    if (!slug) return null;

    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (!r2) {
        console.warn('[SpaceCache] R2 not available');
        return null;
    }

    const normalizedSlug = normalizeForCache(slug);

    // V11: Unified cache path structure
    const cachePaths = [
        `cache/entities/space/${normalizedSlug}.json`,
        `cache/entities/space/hf-space--${normalizedSlug}.json`,
        // Legacy fallback
        `cache/spaces/${normalizedSlug}.json`,
    ];

    for (const cachePath of cachePaths) {
        try {
            const cacheFile = await r2.get(cachePath);
            if (cacheFile) {
                const cacheData = await cacheFile.json();
                console.log(`[SpaceCache] R2 HIT: ${cachePath}`);
                return {
                    ...cacheData.entity || cacheData,
                    _cache_source: 'r2-cache',
                    _contract_version: cacheData.contract_version,
                };
            }
        } catch (e) {
            console.warn(`[SpaceCache] R2 read error for ${cachePath}:`, e.message);
        }
    }

    console.log(`[SpaceCache] MISS: ${normalizedSlug}`);
    return null;
}

/**
 * V6.2: Get dataset data from R2 cache for detail page
 * @param {string} slug - Dataset slug (format: author--name)
 * @param {object} locals - Astro locals
 * @returns {Promise<object|null>} - Dataset data or null
 */
export async function getDatasetFromCache(slug, locals) {
    if (!slug) return null;

    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (!r2) {
        console.warn('[DatasetCache] R2 not available');
        return null;
    }

    const normalizedSlug = normalizeForCache(slug);

    // V11: Unified cache path structure
    const cachePaths = [
        `cache/entities/dataset/${normalizedSlug}.json`,
        `cache/entities/dataset/hf-dataset--${normalizedSlug}.json`,
        // Legacy fallback
        `cache/datasets/${normalizedSlug}.json`,
    ];

    for (const cachePath of cachePaths) {
        try {
            const cacheFile = await r2.get(cachePath);
            if (cacheFile) {
                const cacheData = await cacheFile.json();
                console.log(`[DatasetCache] R2 HIT: ${cachePath}`);
                return {
                    ...cacheData.entity || cacheData,
                    _cache_source: 'r2-cache',
                    _contract_version: cacheData.contract_version,
                };
            }
        } catch (e) {
            console.warn(`[DatasetCache] R2 read error for ${cachePath}:`, e.message);
        }
    }

    console.log(`[DatasetCache] MISS: ${normalizedSlug}`);
    return null;
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
        const cachePath = 'cache/entity_links.json';
        const cacheFile = await r2.get(cachePath);

        if (!cacheFile) {
            console.log('[RelationsCache] entity_links.json not found');
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
