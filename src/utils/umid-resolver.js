// src/utils/umid-resolver.js
/**
 * UMID Resolver V4.5
 * Constitution V4.3.2 Compliant - Industrial-grade slug resolution
 * 
 * 12-Rule Normalization Layer:
 * 1. Lowercase all
 * 2. Trim spaces
 * 3. Replace space → dash
 * 4. Replace / → dash
 * 5. Replace _ → dash
 * 6. Replace . → dash
 * 7. Collapse multiple dashes
 * 8. Remove common suffixes
 * 9. ArXiv ID pattern detection
 * 10. HF ID split (author/name)
 * 11. Query umid_resolver table
 * 12. Levenshtein fallback (distance ≤ 2)
 */

/**
 * Normalize a slug using 12-rule normalization
 * @param {string} slug - Input slug in any format
 * @returns {string} - Normalized slug
 */
export function normalizeSlug(slug) {
    if (!slug || typeof slug !== 'string') return '';

    let normalized = slug;

    // Rule 1: Lowercase
    normalized = normalized.toLowerCase();

    // Rule 2: Trim
    normalized = normalized.trim();

    // Rule 3: Space → dash
    normalized = normalized.replace(/\s+/g, '-');

    // Rule 4: Slash → dash
    normalized = normalized.replace(/\//g, '-');

    // Rule 5: Underscore → dash
    normalized = normalized.replace(/_/g, '-');

    // Rule 6: Dot → dash (except for ArXiv IDs)
    if (!isArxivId(normalized)) {
        normalized = normalized.replace(/\./g, '-');
    }

    // Rule 7: Collapse multiple dashes
    normalized = normalized.replace(/-+/g, '-');

    // Rule 8: Remove leading/trailing dashes
    normalized = normalized.replace(/^-+|-+$/g, '');

    return normalized;
}

/**
 * Canonicalize a slug to ensure UMID compatibility
 * Uses 12-rule normalization to convert any slug format to canonical form
 * @param {string} slug - Input slug in any format
 * @returns {string} - Canonical UMID-compatible slug
 */
export function canonicalizeSlug(slug) {
    if (!slug || typeof slug !== 'string') return '';

    // Apply normalization
    let canonical = normalizeSlug(slug);

    // Remove common prefixes that shouldn't be in canonical form
    canonical = canonical.replace(/^(huggingface-|github-|arxiv-)/, '');

    return canonical;
}

/**
 * Check if string is an ArXiv ID pattern
 * @param {string} str - String to check
 * @returns {boolean}
 */
export function isArxivId(str) {
    // ArXiv ID pattern: YYMM.NNNNN or YYMM.NNNN
    return /^\d{4}\.\d{4,5}$/.test(str);
}

/**
 * Extract author and name from HuggingFace format
 * @param {string} hfId - HuggingFace ID (author/name)
 * @returns {{author: string, name: string}}
 */
export function parseHuggingFaceId(hfId) {
    if (!hfId || typeof hfId !== 'string') {
        return { author: '', name: '' };
    }

    const parts = hfId.split('/');
    if (parts.length >= 2) {
        return {
            author: parts[0],
            name: parts.slice(1).join('/')
        };
    }

    return { author: '', name: hfId };
}

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} - Edit distance
 */
export function levenshteinDistance(a, b) {
    if (!a || !b) return Math.max(a?.length || 0, b?.length || 0);
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Generate canonical variants for fuzzy matching
 * @param {string} normalized - Normalized slug
 * @returns {string[]} - Array of possible variants
 */
export function generateVariants(normalized) {
    const variants = [normalized];

    // Remove common suffixes
    const suffixes = ['-instruct', '-chat', '-hf', '-model', '-base', '-fp16', '-fp32', '-gguf', '-awq', '-gptq'];
    for (const suffix of suffixes) {
        if (normalized.endsWith(suffix)) {
            variants.push(normalized.slice(0, -suffix.length));
        }
    }

    // Remove version numbers at end (e.g., -v1, -v2)
    const versionMatch = normalized.match(/^(.+)-v\d+$/);
    if (versionMatch) {
        variants.push(versionMatch[1]);
    }

    return [...new Set(variants)];
}

/**
 * Main resolver function - resolves any slug format to canonical model
 * S-Grade: Includes KV cache (1 hour TTL)
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

    // S-Grade: Check KV cache first
    if (kvCache) {
        try {
            const cached = await kvCache.get(cacheKey, { type: 'json' });
            if (cached?.model) {
                console.log(`[UMID Resolver] Cache HIT: ${normalized}`);
                return cached;
            }
        } catch (e) {
            console.warn('[UMID Resolver] Cache read error:', e.message);
        }
    }

    const variants = generateVariants(normalized);

    try {
        // Step 1: Try umid_resolver table (highest confidence)
        for (const variant of variants) {
            const resolverResult = await db.prepare(`
                SELECT canonical_umid, confidence FROM umid_resolver
                WHERE LOWER(source_id) = LOWER(?)
                LIMIT 1
            `).bind(variant).first();

            if (resolverResult?.canonical_umid) {
                const model = await db.prepare(`
                    SELECT * FROM models WHERE umid = ? LIMIT 1
                `).bind(resolverResult.canonical_umid).first();

                if (model) {
                    const result = {
                        model,
                        resolution: {
                            source: 'resolver',
                            confidence: resolverResult.confidence || 1.0
                        }
                    };
                    await cacheResolverResult(cacheKey, result, kvCache);
                    return result;
                }
            }
        }

        // Step 2: Direct lookup by various fields
        for (const variant of variants) {
            const model = await db.prepare(`
                SELECT * FROM models
                WHERE LOWER(slug) = LOWER(?)
                   OR LOWER(id) = LOWER(?)
                   OR LOWER(umid) = LOWER(?)
                   OR LOWER(canonical_name) = LOWER(?)
                LIMIT 1
            `).bind(variant, variant, variant, variant).first();

            if (model) {
                const result = {
                    model,
                    resolution: {
                        source: 'direct',
                        confidence: 0.9
                    }
                };
                await cacheResolverResult(cacheKey, result, kvCache);
                return result;
            }
        }

        // Step 3: Try HuggingFace format parsing
        const { author, name } = parseHuggingFaceId(slug);
        if (author && name) {
            const hfNormalized = normalizeSlug(`${author}-${name}`);
            const model = await db.prepare(`
                SELECT * FROM models
                WHERE LOWER(canonical_name) = LOWER(?)
                   OR LOWER(id) LIKE LOWER(?)
                LIMIT 1
            `).bind(hfNormalized, `%${author}%${name}%`).first();

            if (model) {
                return {
                    model,
                    resolution: {
                        source: 'hf_parse',
                        confidence: 0.85
                    }
                };
            }
        }

        // Step 4: ArXiv ID lookup
        if (isArxivId(slug)) {
            const model = await db.prepare(`
                SELECT * FROM models WHERE arxiv_id = ? LIMIT 1
            `).bind(slug).first();

            if (model) {
                return {
                    model,
                    resolution: {
                        source: 'arxiv',
                        confidence: 1.0
                    }
                };
            }
        }

        // Step 5: Fuzzy match (Levenshtein distance ≤ 2)
        // V4.6: Reduced candidate pool from 1000 to 200 for performance
        const candidates = await db.prepare(`
            SELECT umid, canonical_name FROM models
            WHERE canonical_name IS NOT NULL
            LIMIT 200
        `).all();

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
                const model = await db.prepare(`
                    SELECT * FROM models WHERE umid = ? LIMIT 1
                `).bind(bestMatch.umid).first();

                if (model) {
                    return {
                        model,
                        resolution: {
                            source: 'fuzzy',
                            confidence: Math.max(0.5, 1 - (bestDistance * 0.15))
                        }
                    };
                }
            }
        }

        // No match found
        return { model: null, resolution: { source: 'none', confidence: 0 } };

    } catch (error) {
        console.error('[UMID Resolver] Error:', error);
        return { model: null, resolution: { source: 'error', confidence: 0 } };
    }
}

/**
 * Helper to cache resolver result (V4.6: Extended to 24h for SSR performance)
 * @param {string} cacheKey - Cache key
 * @param {object} result - Result to cache
 * @param {object} kvCache - KV binding
 */
async function cacheResolverResult(cacheKey, result, kvCache) {
    if (!kvCache || !result?.model) return;

    try {
        await kvCache.put(cacheKey, JSON.stringify(result), {
            expirationTtl: 86400 // V4.6: 24 hours (was 1 hour)
        });
        console.log(`[UMID Resolver] Cache SET: ${cacheKey}`);
    } catch (e) {
        console.warn('[UMID Resolver] Cache write error:', e.message);
    }
}

/**
 * Batch resolve multiple slugs
 * @param {string[]} slugs - Array of slugs
 * @param {object} locals - Astro locals
 * @returns {Promise<Map<string, {model: object|null, resolution: object}>>}
 */
export async function resolveMultiple(slugs, locals) {
    const results = new Map();

    for (const slug of slugs) {
        results.set(slug, await resolveToModel(slug, locals));
    }

    return results;
}
