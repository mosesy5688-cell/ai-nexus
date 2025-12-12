// src/utils/db.js
// V4.3.2 Constitution: UMID Resolution Layer
import { getCachedModel, setCachedModel } from './cache.js';

/**
 * Helper to fetch a model record from Cloudflare D1.
 * Uses UMID Resolution Layer as primary lookup mechanism.
 * Falls back to direct ID/slug lookup if resolver miss.
 * Uses KV cache with cache-first pattern for performance.
 */
export async function getModelBySlug(slug, locals) {
    // Access the D1 DB and KV Cache via the runtime env
    const db = locals?.runtime?.env?.DB;
    const kvCache = locals?.runtime?.env?.KV_CACHE;

    if (!db) {
        throw new Error('Database connection is not available');
    }

    if (!slug) return null;

    // URL decode the slug (handles %3A for colons, %2F for slashes, etc.)
    const decodedSlug = decodeURIComponent(slug);
    const slugNorm = decodedSlug.toString().trim();

    // 1. Try KV cache first (use decoded slug for cache key)
    const cachedModel = await getCachedModel(slugNorm, kvCache);
    if (cachedModel) {
        return cachedModel;
    }

    let model = null;

    try {
        // ═══════════════════════════════════════════════════════════════════
        // UMID RESOLUTION LAYER (V4.3.2 Constitution Compliant)
        // Single Source of Truth for all external ID mappings
        // ═══════════════════════════════════════════════════════════════════

        // Step 1: Query umid_resolver for canonical_umid mapping
        const resolverRow = await db.prepare(`
            SELECT canonical_umid FROM umid_resolver
            WHERE LOWER(source_id) = LOWER(?)
            LIMIT 1
        `).bind(slugNorm).first();

        if (resolverRow?.canonical_umid && resolverRow.canonical_umid !== '') {
            // Found in resolver - lookup model by canonical UMID
            model = await db.prepare(`
                SELECT * FROM models WHERE umid = ? LIMIT 1
            `).bind(resolverRow.canonical_umid).first();

            if (model) {
                // Cache and return
                await setCachedModel(slugNorm, model, kvCache);
                return model;
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // FALLBACK: Direct lookup (slug, id, umid, canonical_name)
        // For cases where resolver doesn't have mapping yet
        // ═══════════════════════════════════════════════════════════════════

        const stmt = db.prepare(`
            SELECT * FROM models 
            WHERE LOWER(slug) = LOWER(?)
               OR LOWER(id) = LOWER(?)
               OR LOWER(umid) = LOWER(?)
               OR LOWER(canonical_name) = LOWER(?)
            LIMIT 1
        `);
        model = await stmt.bind(slugNorm, slugNorm, slugNorm, slugNorm).first();

        // Smart Fallback: Try github prefix variations
        if (!model) {
            const githubSlug = `github--${slugNorm}`;
            const githubId = `github-${slugNorm}`;
            const normalizedId = slugNorm.replace(/--/g, '-');

            const stmtFallback = db.prepare(`
                SELECT * FROM models 
                WHERE LOWER(slug) = LOWER(?)
                   OR LOWER(id) = LOWER(?)
                   OR LOWER(id) = LOWER(?)
                LIMIT 1
            `);
            model = await stmtFallback.bind(githubSlug, githubId, normalizedId).first();
        }

    } catch (e) {
        // Handle case where umid_resolver table doesn't exist yet
        if (e.message && e.message.includes('umid_resolver')) {
            console.warn('[DB] umid_resolver table not found, using fallback lookup');
            // Fallback to original query
            const stmt = db.prepare(`
                SELECT * FROM models 
                WHERE LOWER(slug) = LOWER(?)
                   OR LOWER(id) = LOWER(?)
                   OR LOWER(umid) = LOWER(?)
                LIMIT 1
            `);
            model = await stmt.bind(slugNorm, slugNorm, slugNorm).first();
        } else {
            console.error("[DB] Error in getModelBySlug:", e);
            throw e;
        }
    }

    // Store in cache for future requests
    if (model) {
        await setCachedModel(slugNorm, model, kvCache);
    }

    return model;
}
