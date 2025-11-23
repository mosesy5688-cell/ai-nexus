// src/utils/db.js
/**
 * Helper to fetch a model record from Cloudflare D1 by slug.
 * Returns the raw row object (or null if not found).
 */
export async function getModelBySlug(slug, locals) {
    // Convert slug back to model id (replace '--' with '/')
    const modelId = slug.replace(/--/g, '/');
    // Access the D1 DB via the runtime env (passed from Astro page)
    const db = locals?.runtime?.env?.DB;
    if (!db) {
        throw new Error('Database connection is not available');
    }

    // Try to fetch by author/name split first
    const firstSlashIndex = modelId.indexOf('/');
    let model = null;
    if (firstSlashIndex !== -1) {
        const author = modelId.substring(0, firstSlashIndex);
        const name = modelId.substring(firstSlashIndex + 1);
        let stmt = db.prepare('SELECT * FROM models WHERE author = ? AND name = ?');
        model = await stmt.bind(author, name).first();
        if (!model) {
            stmt = db.prepare('SELECT * FROM models WHERE id = ?');
            model = await stmt.bind(modelId).first();
        }
    } else {
        const stmt = db.prepare('SELECT * FROM models WHERE id = ?');
        model = await stmt.bind(modelId).first();
    }
    return model;
}
