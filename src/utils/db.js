// src/utils/db.js
import { getCachedModel, setCachedModel } from './cache.js';

/**
 * Helper to fetch a model record from Cloudflare D1 by slug.
 * Uses KV cache with cache-first pattern for performance.
 * Returns the raw row object (or null if not found).
 */
export async function getModelBySlug(slug, locals) {
    // Access the D1 DB and KV Cache via the runtime env
    const db = locals?.runtime?.env?.DB;
    const kvCache = locals?.runtime?.env?.KV_CACHE;

    if (!db) {
        throw new Error('Database connection is not available');
    }

    if (!slug) return null;

    // 1. Try KV cache first
    const cachedModel = await getCachedModel(slug, kvCache);
    if (cachedModel) {
        return cachedModel;
    }

    // 2. Cache miss - query D1
    let model = null;

    try {
        // Exact match by slug or ID (Case Insensitive)
        const stmt = db.prepare('SELECT * FROM models WHERE slug = ? OR id = ? OR slug = ? COLLATE NOCASE OR id = ? COLLATE NOCASE');
        model = await stmt.bind(slug, slug, slug, slug).first();

        // Smart Fallback: Try prepending 'github-' if not found
        if (!model) {
            const githubSlug = `github--${slug}`;
            const githubId = `github-${slug}`;
            const normalizedId = slug.replace(/--/g, '-');
            const githubIdNormalized = `github-${normalizedId}`;

            const stmtFallback = db.prepare(`
                SELECT * FROM models 
                WHERE slug = ? OR id = ? OR id = ? OR id = ?
                OR slug = ? COLLATE NOCASE OR id = ? COLLATE NOCASE
            `);
            model = await stmtFallback.bind(
                githubSlug, githubId, normalizedId, githubIdNormalized,
                githubSlug, githubId
            ).first();
        }
    } catch (e) {
        console.error("[DB] Error in getModelBySlug:", e);
        throw e;
    }

    // 3. Store in cache for future requests
    if (model) {
        await setCachedModel(slug, model, kvCache);
    }

    return model;
}

