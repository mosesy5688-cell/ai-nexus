/**
 * Cache Service
 * Manages Cloudflare KV cache interactions with TTL and intelligent invalidation
 */

// Cache TTL configurations (in seconds)
export const CACHE_TTL = {
    HOT_MODELS: 3600,        // 1 hour - homepage popular models
    CATEGORIES: 21600,       // 6 hours - category lists
    SEARCH_RESULTS: 900,     // 15 min - search results
    MODEL_DETAIL: 1800,      // 30 min - individual model
    RELATED_MODELS: 3600,    // 1 hour - related models
    STATS: 300               // 5 min - statistics
};

// Cache key prefixes for organization
const KEYS = {
    MODELS_LIST: 'models:list',
    MODEL: 'model',
    CATEGORY: 'category',
    SEARCH: 'search',
    RELATED: 'related',
    STATS: 'stats'
};

/**
 * Get cached data from KV
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} key - Cache key
 * @returns {Promise<any|null>} Cached data or null if miss/expired
 */
export async function getCache(kv, key) {
    if (!kv) return null;

    try {
        const cached = await kv.get(key, 'json');

        if (cached && cached.data) {
            // Check manual expiration (KV auto-expires, this is backup)
            if (cached.expiresAt && Date.now() > cached.expiresAt) {
                return null;
            }
            return cached.data;
        }

        return null;
    } catch (error) {
        console.error('Cache get error:', key, error);
        return null;
    }
}

/**
 * Set data in KV cache
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 * @param {number} ttl - Time to live in seconds
 */
export async function setCache(kv, key, data, ttl = CACHE_TTL.HOT_MODELS) {
    if (!kv) return;

    try {
        const cacheData = {
            data,
            cachedAt: Date.now(),
            expiresAt: Date.now() + (ttl * 1000)
        };

        await kv.put(key, JSON.stringify(cacheData), {
            expirationTtl: ttl
        });
    } catch (error) {
        console.error('Cache set error:', key, error);
    }
}

/**
 * Invalidate cache by key pattern (prefix)
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} pattern - Key pattern/prefix
 */
export async function invalidateCache(kv, pattern) {
    if (!kv) return;

    try {
        const list = await kv.list({ prefix: pattern });
        const deletePromises = list.keys.map(key => kv.delete(key.name));
        await Promise.all(deletePromises);
        console.log(`Invalidated ${list.keys.length} cache keys with pattern: ${pattern}`);
    } catch (error) {
        console.error('Cache invalidation error:', pattern, error);
    }
}

/**
 * Generate cache key for models list
 * @param {Object} filters - Query filters
 * @returns {string} Cache key
 */
export function getModelsListKey(filters = {}) {
    const { sort = 'likes', source = 'all', tag = 'all', page = 1 } = filters;
    return `${KEYS.MODELS_LIST}:${sort}:${source}:${tag}:p${page}`;
}

/**
 * Generate cache key for model detail
 * @param {string} modelId - Model ID or slug
 * @returns {string} Cache key
 */
export function getModelKey(modelId) {
    return `${KEYS.MODEL}:${modelId}`;
}

/**
 * Generate cache key for related models
 * @param {string} modelId - Model ID
 * @returns {string} Cache key
 */
export function getRelatedModelsKey(modelId) {
    return `${KEYS.RELATED}:${modelId}`;
}

/**
 * Generate cache key for category
 * @param {string} category - Category name
 * @returns {string} Cache key
 */
export function getCategoryKey(category) {
    return `${KEYS.CATEGORY}:${category}`;
}

/**
 * Generate cache key for search
 * @param {string} query - Search query
 * @param {Object} filters - Additional filters
 * @returns {string} Cache key
 */
export function getSearchKey(query, filters = {}) {
    const filterStr = JSON.stringify(filters);
    const hash = simpleHash(filterStr);
    return `${KEYS.SEARCH}:${query}:${hash}`;
}

/**
 * Simple hash function for cache keys
 * @param {string} str - String to hash
 * @returns {string} Hash
 */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
}

/**
 * Get cache statistics
 * @param {KVNamespace} kv - KV namespace binding
 * @returns {Promise<Object>} Cache stats
 */
export async function getCacheStats(kv) {
    if (!kv) return { error: 'KV not available' };

    try {
        const stats = {
            models_list: 0,
            models: 0,
            related: 0,
            search: 0,
            total: 0
        };

        // Count by prefix
        for (const [key, prefix] of Object.entries(KEYS)) {
            const list = await kv.list({ prefix });
            const count = list.keys.length;
            stats[key.toLowerCase()] = count;
            stats.total += count;
        }

        return stats;
    } catch (error) {
        console.error('Cache stats error:', error);
        return { error: error.message };
    }
}
