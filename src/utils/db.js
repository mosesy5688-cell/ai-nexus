// src/utils/db.js
// V14.2 Zero-Cost Constitution: D1 REMOVED - Using R2 Static Cache Only
import { getCachedModel, setCachedModel } from './cache.js';
import { getModelFromCache } from './entity-cache-reader.js';

/**
 * V14.2: D1 Database has been PERMANENTLY REMOVED per Zero-Cost Constitution Art 2.1
 * 
 * This function now uses R2 static JSON cache instead of D1 database.
 * D1 FTS5 caused $106/month cost explosion and is constitutionally banned.
 * 
 * @param {string} slug - The model slug to look up
 * @param {object} locals - Astro locals containing runtime env
 * @returns {object|null} Model data from R2 cache or null if not found
 */
export async function getModelBySlug(slug, locals) {
    const r2 = locals?.runtime?.env?.R2_ASSETS;

    if (!slug) return null;

    const decodedSlug = decodeURIComponent(slug);
    const slugNorm = decodedSlug.toString().trim().toLowerCase();

    // V14.4 Constitution Alignment: KV and D1 PERMANENTLY REMOVED
    // Pure R2 Static Cache logic only.
    try {
        const model = await getModelFromCache(slugNorm, r2);
        if (model) return model;
    } catch (e) {
        console.warn('[DB] R2 cache lookup failed:', e.message);
    }

    console.log(`[DB] Model not found in R2: ${slugNorm}`);
    return null;
}
