/**
 * Cached JSON Loader with Fallback
 * V4.4 Phase 3 - Constitution Compliant
 * 
 * Provides robust data loading with 2-tier fallback:
 * 1. R2/CDN cache (primary)
 * 2. Minimal stub (last resort)
 * 
 * @module utils/loadCachedJSON
 */

import { R2_CACHE_URL } from '../config/constants.js';

/**
 * Load JSON data from cache with fallback support
 * @template T
 * @param {string} path - Path to JSON file (e.g., '/cache/benchmarks.json')
 * @param {Object} options - Options
 * @param {T} options.fallbackData - Fallback data if all sources fail
 * @returns {Promise<{data: T | null, source: string, freshness: string}>}
 */
export async function loadCachedJSON(path, options = {}) {
    const { fallbackData = null, locals = null } = options;

    // Strategy 1: R2 Direct (Primary for SSR)
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (r2) {
        let r2Path = path.startsWith('/') ? path.slice(1) : path;
        try {
            let file = await r2.get(r2Path);

            // V18.2.7: R2 .gz Fallback
            if (!file && !r2Path.endsWith('.gz')) {
                r2Path = r2Path + '.gz';
                file = await r2.get(r2Path);
            }

            if (file) {
                // V18.2: Handle Gzip decompression in Worker environment
                let data;
                if (r2Path.endsWith('.gz')) {
                    const ds = new DecompressionStream('gzip');
                    const decompressedStream = file.body.pipeThrough(ds);
                    const response = new Response(decompressedStream);
                    data = await response.json();
                } else {
                    data = await file.json();
                }

                return {
                    data,
                    source: 'r2-internal',
                    freshness: data.generated_at || new Date().toISOString()
                };
            }
        } catch (e) {
            console.warn(`[loadCachedJSON] R2 fetch failed for ${r2Path}:`, e.message);
        }
    }

    // Strategy 2: Direct fetch from CDN/R2 (Browser or SSR Fallback)
    try {
        let fetchUrl = path;
        if (!path.startsWith('http')) {
            const cleanPath = path.startsWith('/') ? path.slice(1) : path;
            fetchUrl = `${R2_CACHE_URL}/${cleanPath}`;
        }

        let res = await fetch(fetchUrl, {
            headers: { 'Accept': 'application/json' }
        });

        let isGzip = fetchUrl.endsWith('.gz');

        // V18.2: Transparent .gz fallback for CDN
        if (!res.ok && !isGzip) {
            const gzUrl = fetchUrl + '.gz';
            const gzRes = await fetch(gzUrl);
            if (gzRes.ok) {
                res = gzRes;
                isGzip = true;
            }
        }

        if (res.ok) {
            let data;
            if (isGzip) {
                // V18.12.0: Client-side decompression for Gzip assets with missing headers
                try {
                    const ds = new DecompressionStream('gzip');
                    const decompressedStream = res.body.pipeThrough(ds);
                    const decompressedRes = new Response(decompressedStream);
                    data = await decompressedRes.json();
                } catch (decompressError) {
                    console.error('[loadCachedJSON] Client-side decompression failed:', decompressError);
                    data = await res.json(); // Fallback to raw parse
                }
            } else {
                data = await res.json();
            }

            return {
                data,
                source: 'cdn',
                freshness: data.generated_at || new Date().toISOString()
            };
        }
    } catch (e) {
        console.warn(`[loadCachedJSON] CDN fetch failed for ${path}:`, e.message);
    }

    // Strategy 2: Return fallback data
    return {
        data: fallbackData,
        source: 'fallback',
        freshness: 'stale'
    };
}

/**
 * Load benchmarks data with type safety
 * @param {Object} [locals] - R2 runtime context
 * @returns {Promise<{data: BenchmarkData | null, source: string, freshness: string}>}
 */
export async function loadBenchmarks(locals = null) {
    return loadCachedJSON('/cache/benchmarks.json', {
        locals,
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
 * @param {Object} [locals] - R2 runtime context
 * @returns {Promise<{data: SpecsData | null, source: string, freshness: string}>}
 */
export async function loadSpecs(locals = null) {
    // V18.2.5: Block heavy specs load during SSR to prevent Worker Resource Limit (1102)
    const isSSR = Boolean(locals?.runtime?.env);
    if (isSSR) {
        console.warn('[loadSpecs] SSR Memory Protection active: Returning stub');
        return { data: { count: 0, data: [], architecture_families: [] }, source: 'ssr-stub', freshness: 'live' };
    }

    return loadCachedJSON('/cache/specs.json', {
        locals,
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
