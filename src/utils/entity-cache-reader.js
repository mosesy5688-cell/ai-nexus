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

/**
 * Normalize slug for cache file lookup
 * @param {string} slug - Input slug
 * @returns {string} - Normalized slug for file path
 */
function normalizeForCache(slug) {
    if (!slug) return '';
    return slug
        .toLowerCase()
        .trim()
        .replace(/\//g, '--')
        .replace(/:/g, '--');
}

/**
 * Resolve an entity from R2 cache (Constitutional: D1 = 0)
 * @param {string} slug - Entity slug
 * @param {object} locals - Astro locals with runtime env
 * @returns {Promise<{entity: object|null, source: string}>}
 */
export async function resolveEntityFromCache(slug, locals) {
    if (!slug) {
        return { entity: null, source: 'invalid-slug' };
    }

    const r2 = locals?.runtime?.env?.R2_ASSETS;
    const kvCache = locals?.runtime?.env?.KV_CACHE;

    if (!r2) {
        console.warn('[EntityCache] R2 not available, using fallback');
        return { entity: null, source: 'no-r2' };
    }

    const normalizedSlug = normalizeForCache(slug);

    // Determine entity type from slug prefix
    const isDataset = slug.includes('hf-dataset') || slug.startsWith('dataset');
    const cachePrefix = isDataset ? 'cache/datasets' : 'cache/models';

    // Try multiple cache path patterns
    const cachePaths = [
        `${cachePrefix}/${normalizedSlug}.json`,
        `${cachePrefix}/${slug.replace(/\//g, '--')}.json`,
        `cache/models/${normalizedSlug}.json`, // fallback to models
    ];

    // Check KV cache first for speed
    const kvKey = `entity:${normalizedSlug}`;
    if (kvCache) {
        try {
            const cached = await kvCache.get(kvKey, { type: 'json' });
            if (cached?.entity) {
                console.log(`[EntityCache] KV HIT: ${normalizedSlug}`);
                return { entity: cached.entity, source: 'kv-cache' };
            }
        } catch (e) {
            console.warn('[EntityCache] KV read error:', e.message);
        }
    }

    // Read from R2 cache file
    for (const cachePath of cachePaths) {
        try {
            const cacheFile = await r2.get(cachePath);
            if (cacheFile) {
                const cacheData = await cacheFile.json();
                console.log(`[EntityCache] R2 HIT: ${cachePath}`);

                // V4.9.1 Contract: Return entity with computed and seo data
                return {
                    entity: cacheData.entity || cacheData,
                    computed: cacheData.computed,
                    seo: cacheData.seo,
                    contract_version: cacheData.contract_version,
                    source: 'r2-cache'
                };
            }
        } catch (e) {
            console.warn(`[EntityCache] R2 read error for ${cachePath}:`, e.message);
        }
    }

    console.log(`[EntityCache] MISS: ${normalizedSlug}`);
    return { entity: null, source: 'cache-miss' };
}

/**
 * Get model data from R2 cache for detail page
 * Constitutional replacement for resolveToModel D1 queries
 * @param {string} slug - Model slug
 * @param {object} locals - Astro locals
 * @returns {Promise<object|null>} - Model data or null
 */
export async function getModelFromCache(slug, locals) {
    const result = await resolveEntityFromCache(slug, locals);

    if (result.entity) {
        // Merge entity with computed data for backwards compatibility
        return {
            ...result.entity,
            _cache_source: result.source,
            _contract_version: result.contract_version,
            _computed: result.computed,
            _seo: result.seo
        };
    }

    return null;
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
