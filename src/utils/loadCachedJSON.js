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

import { R2_CACHE_URL } from '../config/constants.ts';

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
        const r2Path = path.startsWith('/') ? path.slice(1) : path;
        try {
            const file = await r2.get(r2Path);
            if (file) {
                const data = await file.json();
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

        const res = await fetch(fetchUrl, {
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
