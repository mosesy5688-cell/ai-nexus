// src/utils/entity-cache-reader-core.js
/**
 * V15.1 Unified Entity Cache Reader Core
 * Constitutional: Art.I-Extended - Frontend D1 = 0
 * 
 * Centralizes slug normalization and R2 path resolution to prevent 
 * duplication and inconsistencies across specialized readers.
 */

/**
 * Normalizes a slug or ID into the definitive R2 cache filename format.
 * R2 Path: {type}/{source}--{author}--{name}.json
 * 
 * @param {string|string[]} input - The slug (e.g., 'meta-llama/Llama-3') or ID ('huggingface:meta-llama/Llama-2')
 * @param {string} type - Entity type (model, agent, paper, dataset, space)
 * @returns {string} - Normalized string (e.g., 'huggingface--meta-llama--llama-3')
 */
export function normalizeEntitySlug(input, type = 'model') {
    if (!input) return '';

    // Convert array slugs (from Astro) to string
    let slug = Array.isArray(input) ? input.join('/') : String(input);
    slug = slug.toLowerCase().trim();

    // 1. Identify raw identifier (strip existing source prefixes if present)
    let identifier = slug;

    // Known prefixes to strip for normalization
    const prefixes = ['huggingface--', 'github--', 'arxiv--', 'replicate--', 'civitai--', 'ollama--', 'hf-space--', 'hf-dataset--'];
    for (const p of prefixes) {
        if (slug.startsWith(p)) {
            identifier = slug.substring(p.length);
            break;
        }
    }

    // Handle slash/colon separators
    if (identifier.includes(':')) {
        identifier = identifier.split(':').pop();
    } else if (identifier.includes('/')) {
        const parts = identifier.split('/');
        // If it's a 3-part path (source/author/name), the first part is source
        if (parts.length >= 3 && ['huggingface', 'github', 'arxiv', 'replicate', 'hf-space', 'hf-dataset'].includes(parts[0])) {
            identifier = parts.slice(1).join('/');
        } else {
            identifier = parts.join('/');
        }
    }

    // 2. Determine Canonical Source based on Type
    let source = 'huggingface';
    if (type === 'paper' || slug.includes('arxiv')) source = 'arxiv';
    else if (type === 'space') source = 'hf-space';
    else if (type === 'dataset') source = 'hf-dataset';
    else if (slug.startsWith('replicate')) source = 'replicate';
    else if (slug.startsWith('github')) source = 'github';

    // 3. Normalize Identifier contents
    // Replace slashes/colons with double-dash, underscores with single dash
    const cleanId = identifier
        .replace(/[\/:]/g, '--')
        .replace(/_/g, '-');

    // 4. Final Key
    return `${source}--${cleanId}`;
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
    const dotFreeSlug = normalizedSlug.replace(/\./g, '-');

    const candidates = [];
    [singular, plural].forEach(t => {
        const prefix = `cache/entities/${t}`;
        candidates.push(`${prefix}/${normalizedSlug}.json`);
        candidates.push(`${prefix}/${dotFreeSlug}.json`);
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
