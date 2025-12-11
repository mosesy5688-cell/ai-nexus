/**
 * Cached JSON Loader with Fallback
 * V4.4 Phase 3 - Constitution Compliant
 * 
 * Provides robust data loading with 3-tier fallback:
 * 1. R2/CDN cache (primary)
 * 2. KV cache (fallback)
 * 3. Minimal stub (last resort)
 * 
 * @module utils/loadCachedJSON
 */

/**
 * Load JSON data from cache with fallback support
 * @template T
 * @param {string} path - Path to JSON file (e.g., '/cache/benchmarks.json')
 * @param {Object} options - Options
 * @param {T} options.fallbackData - Fallback data if all sources fail
 * @returns {Promise<{data: T | null, source: string, freshness: string}>}
 */
export async function loadCachedJSON(path, options = {}) {
    const { fallbackData = null } = options;

    // Strategy 1: Direct fetch from CDN/R2
    try {
        const res = await fetch(path, {
            headers: { 'Accept': 'application/json' }
        });

        if (res.ok) {
            const data = await res.json();
            return {
                data,
                source: 'cdn',
                freshness: data.generated_at || new Date().toISOString()
            };
        }
    } catch (e) {
        console.warn(`[loadCachedJSON] CDN fetch failed for ${path}:`, e.message);
    }

    // Strategy 2: KV fallback API
    try {
        const kvUrl = `/api/cache-fallback?file=${encodeURIComponent(path)}`;
        const kvRes = await fetch(kvUrl);

        if (kvRes.ok) {
            const data = await kvRes.json();
            return {
                data,
                source: 'kv',
                freshness: data.generated_at || 'unknown'
            };
        }
    } catch (e) {
        console.warn(`[loadCachedJSON] KV fallback failed for ${path}:`, e.message);
    }

    // Strategy 3: Return fallback data
    return {
        data: fallbackData,
        source: 'fallback',
        freshness: 'stale'
    };
}

/**
 * Load benchmarks data with type safety
 * @returns {Promise<{data: BenchmarkData | null, source: string, freshness: string}>}
 */
export async function loadBenchmarks() {
    return loadCachedJSON('/cache/benchmarks.json', {
        fallbackData: {
            version: '4.3.2',
            generated_at: null,
            count: 0,
            data: []
        }
    });
}

/**
 * Load specs data with type safety
 * @returns {Promise<{data: SpecsData | null, source: string, freshness: string}>}
 */
export async function loadSpecs() {
    return loadCachedJSON('/cache/specs.json', {
        fallbackData: {
            version: '4.3.2',
            generated_at: null,
            count: 0,
            data: [],
            architecture_families: []
        }
    });
}

/**
 * @typedef {Object} BenchmarkRecord
 * @property {string} umid
 * @property {string} name
 * @property {number} mmlu
 * @property {number} humaneval
 * @property {number} hellaswag
 * @property {number} arc_challenge
 * @property {number} avg_score
 * @property {string} quality_flag
 */

/**
 * @typedef {Object} BenchmarkData
 * @property {string} version
 * @property {string} generated_at
 * @property {number} count
 * @property {BenchmarkRecord[]} data
 */

/**
 * @typedef {Object} SpecsRecord
 * @property {string} umid
 * @property {string} name
 * @property {number} params_billions
 * @property {number} context_length
 * @property {string} architecture_family
 * @property {number} deploy_score
 */

/**
 * @typedef {Object} SpecsData
 * @property {string} version
 * @property {string} generated_at
 * @property {number} count
 * @property {SpecsRecord[]} data
 * @property {Array<{family: string, count: number}>} architecture_families
 */
