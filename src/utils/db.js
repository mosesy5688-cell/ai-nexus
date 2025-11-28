// src/utils/db.js
/**
 * Helper to fetch a model record from Cloudflare D1 by slug.
 * Returns the raw row object (or null if not found).
 */
export async function getModelBySlug(slug, locals) {
    // Access the D1 DB via the runtime env (passed from Astro page)
    const db = locals?.runtime?.env?.DB;
    if (!db) {
        throw new Error('Database connection is not available');
    }

    let model = null;

    // Simplified lookup: Query directly by the unique slug
    // The slug is expected to be URL-safe and globally unique (e.g., 'github--author--name')
    // This matches the new 'slug' column in the database.

    if (!slug) return null;

    try {
        // console.log(`[DB] Lookup by slug: ${slug}`);
        // Try lookup by slug, or fallback to ID (useful if slug is missing or URL uses ID)
        const stmt = db.prepare('SELECT * FROM models WHERE slug = ? OR id = ?');
        model = await stmt.bind(slug, slug).first();
    } catch (e) {
        console.error("[DB] Error in getModelBySlug:", e);
        throw e;
    }

    return model;
}
