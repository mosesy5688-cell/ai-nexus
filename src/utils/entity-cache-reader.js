// src/utils/entity-cache-reader.js
/**
 * V4.9.1 Entity Cache Reader
 * Constitutional: Art.I-Extended - Frontend D1 = 0
 * 
 * This module reads pre-computed entity data from R2 cache files
 * instead of querying D1 database directly.
 * 
 * CEO Iron Rule: Frontend must ONLY use R2 cache - no D1 access
 */

import { fetchEntityFromR2, normalizeEntitySlug } from './entity-cache-reader-core.js';

/**
 * Resolve an entity from R2 cache (Constitutional: D1 = 0)
 */
export async function resolveEntityFromCache(slug, locals) {
    if (!slug) return { entity: null, source: 'invalid-slug' };

    const type = slug.includes('hf-dataset') || slug.startsWith('dataset') ? 'dataset' : 'model';
    const result = await fetchEntityFromR2(type, slug, locals);

    if (result) {
        let entity = result.entity;
        // CES Compliance V6: Enforce source prefix in ID
        if (entity.source === 'huggingface' && !entity.id?.startsWith('huggingface:')) {
            entity.id = `huggingface:${entity.id}`;
        }
        return { ...result, source: 'r2-cache' };
    }

    // Dev Shim
    if (import.meta.env.DEV || process.env.NODE_ENV === 'test') {
        const normalizedSlug = normalizeEntitySlug(slug, type);
        console.log(`[EntityCache] Shim: Checking local FS for ${normalizedSlug}...`);
        try {
            const fs = await import('fs');
            const localPath = 'G:/ai-nexus/data/merged.json';
            if (fs.existsSync(localPath)) {
                const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
                const found = data.find(m => normalizeEntitySlug(m.id || m.slug, type) === normalizedSlug);
                if (found) return { entity: found, source: 'local-fs-shim', computed: { fni: found.fni_score } };
            }
        } catch (e) { }
    }

    return { entity: null, source: 'cache-miss' };
}

/**
 * Get model data from R2 cache for detail page
 * Constitutional replacement for resolveToModel D1 queries
 * @param {string} slug - Model slug
 * @param {object} locals - Astro locals
 * @returns {Promise<object|null>} - Model data or null
 */
export async function getModelFromCache(slug, locals) {
    const result = await resolveEntityFromCache(slug, locals);

    if (result.entity) {
        // V6.3: Properly merge computed data into entity for frontend display
        const computed = result.computed || {};
        const seo = result.seo || {};

        // Merge FNI score from computed data
        const fniScore = computed.fni ?? result.entity.fni_score;

        // Merge benchmark data from computed
        const benchmarks = computed.benchmarks || [];
        const firstBench = benchmarks[0] || {};

        return {
            ...result.entity,
            // V6.3: Expose FNI score at top level for component access
            fni_score: fniScore,
            fni_percentile: computed.fni_percentile,
            // V6.3: Expose benchmark data for BenchmarkCard
            mmlu: firstBench.mmlu || result.entity.mmlu,
            hellaswag: firstBench.hellaswag || result.entity.hellaswag,
            arc_challenge: firstBench.arc_challenge || result.entity.arc_challenge,
            avg_score: firstBench.avg_score || result.entity.avg_score,
            // V6.3: Expose relations for Related Entities section
            relations: computed.relations || {},
            similar_models: computed.relations?.links || [],
            // SEO data for page title/description
            seo_summary: seo,
            // Debug metadata
            _cache_source: result.source,
            _contract_version: result.contract_version,
            _computed: computed,
            _seo: seo
        };
    }

    return null;
}

/**
 * Check if entity exists in cache
 * @param {string} slug - Entity slug
 * @param {object} locals - Astro locals
 * @returns {Promise<boolean>}
 */
export async function entityExistsInCache(slug, locals) {
    const result = await resolveEntityFromCache(slug, locals);
    return result.entity !== null;
}

// V6.2: Re-export functions from split module for backward compatibility
export {
    getSpaceFromCache,
    getDatasetFromCache,
    getRelatedEntities
} from './entity-cache-reader-v6.js';
