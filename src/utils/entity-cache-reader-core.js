// src/utils/entity-cache-reader-core.js
/**
 * V15.1 Unified Entity Cache Reader Core
 * Constitutional: Art.I-Extended - Frontend D1 = 0
 * 
 * Centralizes slug normalization and R2 path resolution to prevent 
 * duplication and inconsistencies across specialized readers.
 */

/**
 * V15.1: Normalize entity slug for R2 storage path
 * ALIGNED WITH aggregator/shard-processor.js conventions
 */
export function normalizeEntitySlug(id, source = 'huggingface') {
    if (!id) return '';

    // V15.1 Fix: Remove mandatory source prefix (huggingface-- etc)
    // The aggregator writes directly using author--name or arxiv-id
    // Case sensitivity MUST be preserved for R2 lookups
    let slug = id;

    // Standard transformations for all types
    slug = slug
        .replace(/:/g, '--')  // Replace colons
        .replace(/\//g, '--'); // Replace slashes

    return slug;
}

/**
 * Generates the prioritized R2 path candidates for an entity.
 * 
 * @param {string} type - Entity type
 * @param {string} normalizedSlug - Normalized slug from normalizeEntitySlug
 * @returns {string[]} - Array of path candidates
 */
export function getR2PathCandidates(type, normalizedSlug) {
    // Standardize type (handle singular/plural inconsistencies)
    const singular = type.endsWith('s') ? type.slice(0, -1) : type;
    const plural = type.endsWith('s') ? type : `${type}s`;

    // Support dot-to-dash normalization (Art 2.4/V15 Storage Law)
    // This is for legacy/fallback, new slugs should not have dots in this position
    const dotFreeSlug = normalizedSlug.replace(/\./g, '-');

    const candidates = [];
    [singular, plural].forEach(t => {
        const prefix = `cache/entities/${t}`;
        // Primary path (case-preserved, new normalization)
        candidates.push(`${prefix}/${normalizedSlug}.json`);
        // Fallback for older slugs that might have dots or were lowercased
        candidates.push(`${prefix}/${normalizedSlug.toLowerCase()}.json`);
        candidates.push(`${prefix}/${dotFreeSlug}.json`);
        candidates.push(`${prefix}/${dotFreeSlug.toLowerCase()}.json`);
        // Legacy versioned paths (should be deprecated but kept for robustness)
        candidates.push(`${prefix}/${normalizedSlug}.v-1.json`);
        candidates.push(`${prefix}/${normalizedSlug}.v-2.json`);
    });

    return [...new Set(candidates)];
}

/**
 * Universal hydration for entity objects.
 * Merges raw entity data with computed metrics and SEO metadata.
 */
export function hydrateEntity(data, type) {
    if (!data) return null;

    const entity = data.entity || data;
    const computed = data.computed || {};
    const seo = data.seo || {};

    // Standard mappings for all types
    const hydrated = {
        ...entity,
        fni_score: computed.fni ?? entity.fni_score,
        fni_percentile: computed.fni_percentile ?? entity.fni_percentile,
        relations: computed.relations || entity.relations || {},
        _computed: computed,
        _seo: seo,
        _hydrated: true
    };

    // Type-specific hydration
    if (type === 'model') {
        const benchmarks = computed.benchmarks || [];
        const firstBench = benchmarks[0] || {};
        hydrated.mmlu = firstBench.mmlu || entity.mmlu;
        hydrated.hellaswag = firstBench.hellaswag || entity.hellaswag;
        hydrated.arc_challenge = firstBench.arc_challenge || entity.arc_challenge;
        hydrated.avg_score = firstBench.avg_score || entity.avg_score;
    }

    return hydrated;
}

/**
 * Base fetcher for R2 assets with local FS shim for development
 */
export async function fetchEntityFromR2(type, slug, locals) {
    const normalized = normalizeEntitySlug(slug, type);

    // 1. Try R2 Cache (Production/Preview)
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (r2) {
        const paths = getR2PathCandidates(type, normalized);
        for (const path of paths) {
            try {
                const file = await r2.get(path);
                if (file) {
                    const data = await file.json();
                    console.log(`[R2Reader] HIT: ${path}`);
                    return {
                        entity: data.entity || data,
                        computed: data.computed || {},
                        seo: data.seo || {},
                        _cache_path: path,
                        _cache_source: 'r2-cache'
                    };
                }
            } catch (e) {
                console.warn(`[R2Reader] Error reading ${path}:`, e.message);
            }
        }
    }

    // 2. Dev Shim: Local Filesystem (Art 2.4 / B14 Compatibility)
    if (import.meta.env.DEV || process.env.NODE_ENV === 'test') {
        try {
            const fs = await import('node:fs');
            // Try specific type path first, then merged, then type-merged
            const pluralType = type.endsWith('s') ? type : `${type}s`;
            const paths = [
                `g:/ai-nexus/data/cache/entities/${type}/${normalized}.json`,
                `g:/ai-nexus/data/cache/entities/${pluralType}/${normalized}.json`,
                `g:/ai-nexus/data/merged.json`,
                `g:/ai-nexus/data/${pluralType}.json`
            ];

            for (const localPath of paths) {
                if (fs.existsSync(localPath)) {
                    const raw = fs.readFileSync(localPath, 'utf-8');
                    const data = JSON.parse(raw);

                    if (localPath.endsWith('merged.json') || localPath.match(/data\/[a-z]+s\.json$/)) {
                        // Scan list for the entity
                        const list = Array.isArray(data) ? data : (data.entities || []);
                        const found = list.find(m => {
                            const mSlug = m.id || m.slug || '';
                            return normalizeEntitySlug(mSlug, type) === normalized;
                        });

                        if (found) {
                            return {
                                entity: found,
                                computed: { fni: found.fni_score || found.fni || 0 },
                                _cache_source: 'local-fs-shim'
                            };
                        }
                    } else {
                        return {
                            ...data,
                            entity: data.entity || data,
                            _cache_source: 'local-fs-shim'
                        };
                    }
                }
            }
        } catch (e) {
            console.warn(`[Reader Shim] Error:`, e.message);
        }
    }

    return null;
}
