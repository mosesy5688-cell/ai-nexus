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

/** V55.9: Decode ArrayBuffer with Zstd/Gzip auto-detection via magic bytes */
async function _decodeBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xB5 && bytes[2] === 0x2F && bytes[3] === 0xFD) {
        const { decompress } = await import('fzstd');
        return JSON.parse(new TextDecoder().decode(decompress(bytes)));
    }
    if (bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B) {
        const ds = new DecompressionStream('gzip');
        return await new Response(new Response(buffer).body.pipeThrough(ds)).json();
    }
    return JSON.parse(new TextDecoder().decode(bytes));
}

/** V55.9: Decode R2 file object with compression auto-detection */
async function _decodeR2File(file, r2Path) {
    try {
        const buf = await file.arrayBuffer();
        return await _decodeBuffer(buf);
    } catch (e) {
        console.warn(`[loadCachedJSON] Decode failed for ${r2Path}:`, e.message);
        return null;
    }
}

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
    // locals could be Astro.locals (with runtime) or the environment object itself
    const r2 = locals?.runtime?.env?.R2_ASSETS || locals?.R2_ASSETS || locals?.env?.R2_ASSETS;

    if (r2) {
        let r2Path = path.startsWith('/') ? path.slice(1) : path;
        if (r2Path.startsWith('cache/')) r2Path = r2Path.slice(6);

        try {
            let file = await r2.get(r2Path);

            // V55.9: Try .zst first, then .gz fallback
            if (!file && !r2Path.endsWith('.zst') && !r2Path.endsWith('.gz')) {
                file = await r2.get(r2Path + '.zst');
                if (file) r2Path = r2Path + '.zst';
            }
            if (!file && !r2Path.endsWith('.gz')) {
                file = await r2.get(r2Path + '.gz');
                if (file) r2Path = r2Path + '.gz';
            }

            if (file) {
                const data = await _decodeR2File(file, r2Path);
                return {
                    data,
                    source: 'r2-internal',
                    freshness: data?.generated_at || new Date().toISOString(),
                    etag: file.httpEtag || 'unknown-r2-etag'
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
            let cleanPath = path.startsWith('/') ? path.slice(1) : path;
            // Prevent double prefixing: R2_CACHE_URL usually doesn't include /cache,
            // but we should ensure the path is canonical.
            if (!cleanPath.startsWith('cache/')) {
                cleanPath = `cache/${cleanPath}`;
            }
            fetchUrl = `${R2_CACHE_URL}/${cleanPath}`;
        }

        let res = await fetch(fetchUrl, { headers: { 'Accept': 'application/json' } });

        // V55.9: Transparent .zst fallback, then .gz
        if (!res.ok && !fetchUrl.endsWith('.zst') && !fetchUrl.endsWith('.gz')) {
            const zstRes = await fetch(fetchUrl + '.zst');
            if (zstRes.ok) { res = zstRes; }
            else {
                const gzRes = await fetch(fetchUrl + '.gz');
                if (gzRes.ok) res = gzRes;
            }
        }

        if (res.ok) {
            const buffer = await res.arrayBuffer();
            const data = await _decodeBuffer(buffer);
            return {
                data,
                source: 'cdn',
                freshness: data?.generated_at || new Date().toISOString(),
                etag: res.headers.get('etag') || 'unknown-cdn-etag'
            };
        }
    } catch (e) {
        console.warn(`[loadCachedJSON] CDN fetch failed for ${path}:`, e.message);
    }

    // Strategy 2: Return fallback data
    return {
        data: fallbackData,
        source: 'fallback',
        freshness: 'stale',
        etag: 'fallback-stub'
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
