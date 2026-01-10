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
 * Normalize slug for cache file lookup (Constitutional V6.2)
 * R2 Path Format: cache/entities/{type}/{source}--{author}--{name}.json
 * 
 * For 2-part slugs [author, name], prepends appropriate source prefix
 * For 3-part slugs [source, author, name], uses as-is
 * 
 * @param {string|string[]} slug - Input slug from URL
 * @param {string} entityType - Entity type for source prefix (space, dataset)
 * @returns {string} - Normalized slug matching R2 file naming
 */
function normalizeForCache(slug, entityType = 'model') {
    if (!slug) return '';

    // Handle array slugs from Astro [...slug] routes
    let parts = Array.isArray(slug) ? slug : slug.split('/');

    // Remove any source prefix separator (e.g., "huggingface:")
    if (parts.length === 1 && parts[0].includes(':')) {
        const [source, rest] = parts[0].split(':');
        parts = [source, ...rest.split('/')];
    }

    // Constitutional V6.2: Normalize to source--author--name format
    // 2-part URL: [author, name] → source--author--name
    // 3-part URL: [source, author, name] → source--author--name
    if (parts.length === 2) {
        // Default source prefix based on entity type
        const sourcePrefix = entityType === 'space' ? 'hf-space'
            : entityType === 'dataset' ? 'hf-dataset'
                : 'huggingface';
        parts = [sourcePrefix, ...parts];
    }

    return parts
        .map(p => p.toLowerCase().trim())
        .join('--')
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

    const normalizedSlug = normalizeForCache(slug, 'space');

    // V14: Constitutional cache path - only use cache/entities/space/
    // V15.0 Fix: Robust multi-path lookup
    const rawSlug = slug.replace(/\//g, '--').replace(/:/g, '--');
    const cachePaths = [
        `cache/entities/space/${normalizedSlug}.json`,
        `cache/entities/space/huggingface--${rawSlug}.json`,
        `cache/entities/space/${rawSlug}.json`
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

    const normalizedSlug = normalizeForCache(slug, 'dataset');

    // V14: Constitutional cache path - only use cache/entities/dataset/
    // V15.0 Fix: Robust multi-path lookup
    const rawSlug = slug.replace(/\//g, '--').replace(/:/g, '--');
    const cachePaths = [
        `cache/entities/dataset/${normalizedSlug}.json`,
        `cache/entities/dataset/huggingface--${rawSlug}.json`,
        `cache/entities/dataset/hf-dataset--${rawSlug}.json`,
        `cache/entities/dataset/dataset--${rawSlug}.json`,
        `cache/entities/dataset/${rawSlug}.json`,
        `cache/entities/dataset/github--${rawSlug}.json`
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
