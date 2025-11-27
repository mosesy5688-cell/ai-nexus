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

    try {
        if (firstSlashIndex !== -1) {
            const author = modelId.substring(0, firstSlashIndex);
            const name = modelId.substring(firstSlashIndex + 1);
            // console.log(`[DB] Lookup by author/name: ${author}/${name}`);
            let stmt = db.prepare('SELECT * FROM models WHERE author = ? AND name = ?');
            model = await stmt.bind(author, name).first();
        }

        // Fallback 1: Try by ID (as passed/converted)
        if (!model) {
            // console.log(`[DB] Lookup by ID: ${modelId}`);
            let stmt = db.prepare('SELECT * FROM models WHERE id = ?');
            model = await stmt.bind(modelId).first();
        }

        // Fallback 2: Try by GitHub ID format (github-author-name)
        if (!model) {
            // Convert 'ollama--ollama' -> 'ollama-ollama' -> 'github-ollama-ollama'
            const githubId = `github-${slug.replace(/--/g, '-')}`;
            // console.log(`[DB] Lookup by GitHub ID: ${githubId}`);
            let stmt = db.prepare('SELECT * FROM models WHERE id = ?');
            model = await stmt.bind(githubId).first();
        }
    } catch (e) {
        console.error("[DB] Error in getModelBySlug:", e);
        throw e;
    }

    return model;
}
