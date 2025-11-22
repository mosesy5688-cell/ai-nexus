export const prerender = false; // Enable SSR for this endpoint

export async function GET({ request, locals }) {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    const tag = url.searchParams.get('tag');
    const limit = parseInt(url.searchParams.get('limit') || '20');

    const db = locals.runtime?.env?.DB;

    if (!db) {
        return new Response(JSON.stringify({ error: 'Database not available' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        let results = [];

        if (query) {
            // Use FTS5 for full-text search
            // We join with models table using the rowid (which matches because of content_rowid='rowid')
            const sql = `
                SELECT m.* 
                FROM models m 
                JOIN models_fts f ON m.rowid = f.rowid 
                WHERE models_fts MATCH ? 
                ORDER BY f.rank 
                LIMIT ?
            `;
            // FTS5 query syntax: simple words or "phrase"
            const ftsQuery = `"${query}" OR ${query}*`;
            const { results: ftsResults } = await db.prepare(sql).bind(ftsQuery, limit).all();
            results = ftsResults;
        } else if (tag) {
            // Tag search
            const sql = `SELECT * FROM models WHERE tags LIKE ? ORDER BY likes DESC LIMIT ?`;
            const { results: tagResults } = await db.prepare(sql).bind(`%${tag}%`, limit).all();
            results = tagResults;
        } else {
            // Default: Hot models (by likes/downloads)
            const sql = `SELECT * FROM models ORDER BY likes DESC LIMIT ?`;
            const { results: hotResults } = await db.prepare(sql).bind(limit).all();
            results = hotResults;
        }

        return new Response(JSON.stringify({ results }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60'
            }
        });

    } catch (error) {
        console.error("Search API Error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
