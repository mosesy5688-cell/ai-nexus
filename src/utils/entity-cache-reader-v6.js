/**
 * V6.2 Universal Entity Cache Reader
 * Constitutional: Art.I-Extended - Frontend D1 = 0
 * 
 * This is the STABLE authoritative reader for all entity types.
 * Restored from archive to resolve V16.5 regressions.
 */

import { hydrateEntity, augmentEntity } from './entity-hydrator.js';
export { hydrateEntity, augmentEntity };

/**
 * Normalize entity slug for R2 storage path
 */
export function normalizeEntitySlug(id) {
    if (!id) return '';
    const slugStr = Array.isArray(id) ? id.join('/') : id;
    // V6 Stable: Simple double-dash replacement for R2 compatibility
    return slugStr.toLowerCase().replace(/[\/:]/g, '--');
}

/**
 * Generates prioritized R2 path candidates for an entity
 */
export function getR2PathCandidates(type, normalizedSlug) {
    const singular = type.endsWith('s') ? type.slice(0, -1) : type;
    const prefix = `cache/entities/${singular}`;

    const candidates = [
        `${prefix}/${normalizedSlug}.json`, // 1. Direct ID match
    ];

    if (singular === 'model' && !normalizedSlug.startsWith('replicate--')) {
        candidates.push(`${prefix}/replicate--${normalizedSlug}.json`);
    }

    if (singular === 'dataset' && !normalizedSlug.startsWith('hf-dataset--')) {
        candidates.push(`${prefix}/hf-dataset--${normalizedSlug}.json`);
    }

    if (singular === 'paper' && !normalizedSlug.startsWith('arxiv--')) {
        candidates.push(`${prefix}/arxiv--${normalizedSlug}.json`);
    }

    return [...new Set(candidates)];
}

/**
 * Base fetcher for R2 assets 
 */
export async function fetchEntityFromR2(type, slug, locals) {
    const normalized = normalizeEntitySlug(slug);

    // 1. Try R2 Cache (Production/Preview SSR)
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (r2) {
        const paths = getR2PathCandidates(type, normalized);
        for (const path of paths) {
            try {
                const file = await r2.get(path);
                if (file) {
                    const data = await file.json();
                    return {
                        entity: data.entity || data,
                        computed: data.computed || {},
                        seo: data.seo || {},
                        _cache_path: path,
                        _cache_source: 'r2-cache'
                    };
                }
            } catch (e) { }
        }
    }

    // 2. Browser/Static CDN Fetch
    if (!r2 || typeof window !== 'undefined') {
        const paths = getR2PathCandidates(type, normalized);
        for (const path of paths) {
            try {
                const cdnUrl = `https://cdn.free2aitools.com/${path}`;
                const res = await fetch(cdnUrl);
                if (res.ok) {
                    const data = await res.json();
                    return {
                        entity: data.entity || data,
                        computed: data.computed || {},
                        seo: data.seo || {},
                        _cache_path: path,
                        _cache_source: 'cdn-static'
                    };
                }
            } catch (e) { }
        }
    }
    return null;
}

/**
 * V6.2: Get space data from R2 cache
 */
export async function getSpaceFromCache(slug, locals) {
    if (!slug) return null;
    const result = await fetchEntityFromR2('space', slug, locals);
    return hydrateEntity(result, 'space');
}

/**
 * V15.1: Get tool data from R2 cache
 */
export async function getToolFromCache(slug, locals) {
    if (!slug) return null;
    const result = await fetchEntityFromR2('tool', slug, locals);
    return hydrateEntity(result, 'tool');
}

/**
 * Get dataset data from R2 cache
 */
export async function getDatasetFromCache(slug, locals) {
    if (!slug) return null;
    const result = await fetchEntityFromR2('dataset', slug, locals);
    return hydrateEntity(result, 'dataset');
}

/**
 * Get paper data from R2 cache
 */
export async function getPaperFromCache(slug, locals) {
    if (!slug) return null;
    const result = await fetchEntityFromR2('paper', slug, locals);
    return hydrateEntity(result, 'paper');
}

/**
 * Get model data from R2 cache
 */
export async function getModelFromCache(slug, locals) {
    const result = await fetchEntityFromR2('model', slug, locals);
    if (!result) return null;
    return hydrateEntity(result, 'model');
}
