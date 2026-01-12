// src/utils/entity-cache-reader-depth.js
/**
 * V6.3 Depth Entity Cache Reader
 * Constitutional: Art.I-Extended - Frontend D1 = 0
 * 
 * Part of entity-cache-reader-v6 splitting for CES compliance (250 line limit)
 */

import { fetchEntityFromR2, normalizeEntitySlug, hydrateEntity } from './entity-cache-reader-core.js';

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
