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
    let slug = Array.isArray(input) ? input.join('/') : input;

    // 1. Identify Source
    let source = 'huggingface'; // Default
    let identifier = slug;

    if (slug.includes(':')) {
        [source, identifier] = slug.split(':');
    } else if (slug.includes('--')) {
        // Some internal links use -- as separator
        const parts = slug.split('--');
        if (['huggingface', 'github', 'arxiv', 'replicate', 'civitai', 'ollama'].includes(parts[0])) {
            source = parts[0];
            identifier = parts.slice(1).join('--');
        }
    }

    // Special source mappings for types
    if (type === 'paper' && source === 'huggingface') source = 'arxiv';
    if (type === 'space' && source === 'huggingface') source = 'hf-space';
    if (type === 'dataset' && source === 'huggingface') source = 'hf-dataset';

    // 2. Normalize Identifier
    // Replace slashes or colons with double-dash
    const normalizedId = identifier
        .toLowerCase()
        .trim()
        .replace(/[\/:]/g, '--');

    // 3. Construct Final Key
    return `${source}--${normalizedId}`;
}

/**
 * Generates the prioritized R2 path candidates for an entity.
 * 
 * @param {string} type - Entity type
 * @param {string} normalizedSlug - Normalized slug from normalizeEntitySlug
 * @returns {string[]} - Array of path candidates
 */
export function getR2PathCandidates(type, normalizedSlug) {
    const prefix = `cache/entities/${type}`;
    return [
        `${prefix}/${normalizedSlug}.json`,
        `${prefix}/${normalizedSlug}.v-1.json`, // Art 2.4 Fallback
        `${prefix}/${normalizedSlug}.v-2.json`  // Art 2.4 Fallback
    ];
}

/**
 * Base fetcher for R2 assets
 */
export async function fetchEntityFromR2(type, slug, locals) {
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (!r2) return null;

    const normalized = normalizeEntitySlug(slug, type);
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
                    _cache_path: path
                };
            }
        } catch (e) {
            console.warn(`[R2Reader] Error reading ${path}:`, e.message);
        }
    }
    return null;
}
