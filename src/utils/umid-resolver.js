// src/utils/umid-resolver.js
/**
 * UMID Resolver V5.2 (Refactored)
 * Constitution V4.3.2 Compliant - Industrial-grade slug resolution
 */

import {
    normalizeSlug,
    canonicalizeSlug,
    isArxivId,
    parseHuggingFaceId,
    generateVariants,
    levenshteinDistance
} from './slug-utils.js';

// Re-export for backward compatibility
export { normalizeSlug, canonicalizeSlug, isArxivId, parseHuggingFaceId, generateVariants, levenshteinDistance };

/**
 * Main resolver function - resolves any slug format to canonical model
 * @param {string} slug - Input slug in any format
 * @param {object} locals - Astro locals with DB binding
 * @returns {Promise<{model: object|null, resolution: {source: string, confidence: number}}>}
 */
export async function resolveToModel(slug, locals) {
    const db = locals?.runtime?.env?.DB;
    const kvCache = locals?.runtime?.env?.KV_CACHE;

    if (!db || !slug) {
        return { model: null, resolution: { source: 'none', confidence: 0 } };
    }

    const normalized = normalizeSlug(slug);
    const cacheKey = `umid-resolve:${normalized}`;

    // Check KV cache first
    if (kvCache) {
        try {
            const cached = await kvCache.get(cacheKey, { type: 'json' });
            if (cached?.model) return cached;
        } catch (e) {
            console.warn('[UMID Resolver] Cache read error:', e.message);
        }
    }

    const variants = generateVariants(normalized);

    try {
        // Step 0: Exact original slug match
        const exactModel = await db.prepare(
            `SELECT * FROM models WHERE LOWER(slug) = LOWER(?) LIMIT 1`
        ).bind(slug).first();

        if (exactModel) {
            const result = { model: exactModel, resolution: { source: 'exact-slug', confidence: 1.0 } };
            await cacheResolverResult(cacheKey, result, kvCache);
            return result;
        }

        // Step 1: umid_resolver table lookup
        for (const variant of variants) {
            const resolverResult = await db.prepare(
                `SELECT canonical_umid, confidence FROM umid_resolver WHERE LOWER(source_id) = LOWER(?) LIMIT 1`
            ).bind(variant).first();

            if (resolverResult?.canonical_umid) {
                const model = await db.prepare(`SELECT * FROM models WHERE umid = ? LIMIT 1`).bind(resolverResult.canonical_umid).first();
                if (model) {
                    const result = { model, resolution: { source: 'resolver', confidence: resolverResult.confidence || 1.0 } };
                    await cacheResolverResult(cacheKey, result, kvCache);
                    return result;
                }
            }
        }

        // Step 2: Direct lookup by various fields
        for (const variant of variants) {
            const model = await db.prepare(`
                SELECT * FROM models
                WHERE LOWER(slug) = LOWER(?) OR LOWER(id) = LOWER(?) OR LOWER(umid) = LOWER(?) OR LOWER(canonical_name) = LOWER(?)
                LIMIT 1
            `).bind(variant, variant, variant, variant).first();

            if (model) {
                const result = { model, resolution: { source: 'direct', confidence: 0.9 } };
                await cacheResolverResult(cacheKey, result, kvCache);
                return result;
            }
        }

        // Step 3: HuggingFace format parsing
        const { author, name } = parseHuggingFaceId(slug);
        if (author && name) {
            const hfNormalized = normalizeSlug(`${author}-${name}`);
            const model = await db.prepare(`
                SELECT * FROM models WHERE LOWER(canonical_name) = LOWER(?) OR LOWER(id) LIKE LOWER(?) LIMIT 1
            `).bind(hfNormalized, `%${author}%${name}%`).first();

            if (model) {
                return { model, resolution: { source: 'hf_parse', confidence: 0.85 } };
            }
        }

        // Step 4: ArXiv ID lookup
        if (isArxivId(slug)) {
            const model = await db.prepare(`SELECT * FROM models WHERE arxiv_id = ? LIMIT 1`).bind(slug).first();
            if (model) {
                return { model, resolution: { source: 'arxiv', confidence: 1.0 } };
            }
        }

        // Step 5: Fuzzy match (Levenshtein distance ≤ 2)
        const candidates = await db.prepare(`SELECT umid, canonical_name FROM models WHERE canonical_name IS NOT NULL LIMIT 200`).all();

        if (candidates?.results) {
            let bestMatch = null;
            let bestDistance = Infinity;

            for (const candidate of candidates.results) {
                if (!candidate.canonical_name) continue;
                const distance = levenshteinDistance(normalized, candidate.canonical_name.toLowerCase());
                if (distance <= 2 && distance < bestDistance) {
                    bestDistance = distance;
                    bestMatch = candidate;
                }
            }

            if (bestMatch) {
                const model = await db.prepare(`SELECT * FROM models WHERE umid = ? LIMIT 1`).bind(bestMatch.umid).first();
                if (model) {
                    return { model, resolution: { source: 'fuzzy', confidence: Math.max(0.5, 1 - (bestDistance * 0.15)) } };
                }
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
