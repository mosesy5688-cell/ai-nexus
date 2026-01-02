// src/utils/umid-resolver.js
/**
 * UMID Resolver V14.2 (Zero-Cost Constitution Compliant)
 * 
 * D1 Database has been PERMANENTLY REMOVED per Zero-Cost Constitution Art 2.1
 * Now uses R2 static JSON cache for all model resolution.
 */

import {
    normalizeSlug,
    canonicalizeSlug,
    isArxivId,
    parseHuggingFaceId,
    generateVariants,
    levenshteinDistance
} from './slug-utils.js';

import { getModelFromCache } from './entity-cache-reader.js';

// Re-export for backward compatibility
export { normalizeSlug, canonicalizeSlug, isArxivId, parseHuggingFaceId, generateVariants, levenshteinDistance };

/**
 * V14.2: Resolves any slug format to canonical model using R2 cache
 * @param {string} slug - Input slug in any format
 * @param {object} locals - Astro locals with R2 binding
 * @returns {Promise<{model: object|null, resolution: {source: string, confidence: number}}>}
 */
export async function resolveToModel(slug, locals) {
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    const kvCache = locals?.runtime?.env?.KV_CACHE;

    if (!slug) {
        return { model: null, resolution: { source: 'none', confidence: 0 } };
    }

    const normalized = normalizeSlug(slug);
    const cacheKey = `umid-resolve:${normalized}`;

    // Check KV cache first (fast path)
    if (kvCache) {
        try {
            const cached = await kvCache.get(cacheKey, { type: 'json' });
            if (cached?.model) return cached;
        } catch (e) {
            console.warn('[UMID Resolver] Cache read error:', e.message);
        }
    }

    // V14.2: Use R2 entity cache (replaces D1)
    try {
        const variants = generateVariants(normalized);

        // Try each variant against R2 cache
        for (const variant of variants) {
            const model = await getModelFromCache(variant, r2);
            if (model) {
                const result = {
                    model,
                    resolution: { source: 'r2-cache', confidence: 0.9 }
                };
                await cacheResolverResult(cacheKey, result, kvCache);
                return result;
            }
        }

        // Try HuggingFace format parsing
        const { author, name } = parseHuggingFaceId(slug);
        if (author && name) {
            const hfSlug = `${author}--${name}`.toLowerCase();
            const model = await getModelFromCache(hfSlug, r2);
            if (model) {
                const result = {
                    model,
                    resolution: { source: 'hf-parse', confidence: 0.85 }
                };
                await cacheResolverResult(cacheKey, result, kvCache);
                return result;
            }
        }

        return { model: null, resolution: { source: 'none', confidence: 0 } };

    } catch (error) {
        console.error('[UMID Resolver] Error:', error);
        return { model: null, resolution: { source: 'error', confidence: 0 } };
    }
}

/** Cache resolver result (24h TTL) */
async function cacheResolverResult(cacheKey, result, kvCache) {
    if (!kvCache || !result?.model) return;
    try {
        await kvCache.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });
    } catch (e) {
        console.warn('[UMID Resolver] Cache write error:', e.message);
    }
}

/** Batch resolve multiple slugs */
export async function resolveMultiple(slugs, locals) {
    const results = new Map();
    for (const slug of slugs) {
        results.set(slug, await resolveToModel(slug, locals));
    }
    return results;
}
