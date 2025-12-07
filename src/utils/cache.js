// src/utils/cache.js
/**
 * KV Cache utilities for model data caching.
 * Uses Cloudflare KV with TTL for efficient caching.
 */

const MODEL_CACHE_PREFIX = 'model:';
const DEFAULT_TTL = 3600; // 1 hour in seconds

/**
 * Get cached model data from KV.
 * @param {string} slug - Model slug
 * @param {KVNamespace} kvCache - KV namespace binding
 * @returns {Object|null} - Cached model or null
 */
export async function getCachedModel(slug, kvCache) {
    if (!kvCache || !slug) return null;

    try {
        const key = `${MODEL_CACHE_PREFIX}${slug.toLowerCase()}`;
        const cached = await kvCache.get(key, { type: 'json' });

        if (cached) {
            console.log(`[Cache HIT] ${slug}`);
            return cached;
        }

        console.log(`[Cache MISS] ${slug}`);
        return null;
    } catch (e) {
        console.warn('[Cache] Get error:', e.message);
        return null;
    }
}

/**
 * Store model data in KV cache.
 * @param {string} slug - Model slug
 * @param {Object} model - Model data to cache
 * @param {KVNamespace} kvCache - KV namespace binding
 * @param {number} ttl - TTL in seconds (default: 1 hour)
 */
export async function setCachedModel(slug, model, kvCache, ttl = DEFAULT_TTL) {
    if (!kvCache || !slug || !model) return;

    try {
        const key = `${MODEL_CACHE_PREFIX}${slug.toLowerCase()}`;
        await kvCache.put(key, JSON.stringify(model), { expirationTtl: ttl });
        console.log(`[Cache SET] ${slug} (TTL: ${ttl}s)`);
    } catch (e) {
        console.warn('[Cache] Set error:', e.message);
    }
}

/**
 * Invalidate cached model.
 * @param {string} slug - Model slug to invalidate
 * @param {KVNamespace} kvCache - KV namespace binding
 */
export async function invalidateCachedModel(slug, kvCache) {
    if (!kvCache || !slug) return;

    try {
        const key = `${MODEL_CACHE_PREFIX}${slug.toLowerCase()}`;
        await kvCache.delete(key);
        console.log(`[Cache INVALIDATE] ${slug}`);
    } catch (e) {
        console.warn('[Cache] Invalidate error:', e.message);
    }
}
