export const prerender = false; // Enable SSR for this endpoint

export async function GET({ request, locals }) {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    const tag = url.searchParams.get('tag');
    const sort = url.searchParams.get('sort') || 'likes';
    const source = url.searchParams.get('source');

    const db = locals.runtime?.env?.DB;

    if (!db) {
        return new Response(JSON.stringify({ error: 'Database not available' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        let results = [];
        let sql = '';
        let params = [];

        // Base query construction
        if (query) {
            // Full-text search takes precedence
            sql = `
                SELECT m.* 
                FROM models m 
                JOIN models_fts f ON m.rowid = f.rowid 
                WHERE models_fts MATCH ? 
            `;
            const ftsQuery = `"${query}" OR ${query}*`;
            params.push(ftsQuery);
        } else {
            sql = `SELECT * FROM models WHERE 1=1`;
        }

        // Apply filters
        if (tag) {
            sql += ` AND tags LIKE ?`;
            params.push(`%${tag}%`);
        }

        if (source) {
            sql += ` AND source = ?`;
            params.push(source.toLowerCase());
        }

        // Apply sorting (only if not FTS, or if explicit sort requested)
        // Note: FTS usually ranks by relevance, but we might want to sort results
        let orderBy = 'likes DESC';
        switch (sort) {
            case 'downloads': orderBy = 'downloads DESC'; break;
            case 'last_updated': orderBy = 'last_updated DESC'; break;
            case 'likes': orderBy = 'likes DESC'; break;
            default: orderBy = 'likes DESC';
        }

        // If query is present, we might want to keep rank, but for now let's allow override
        if (query && sort === 'relevance') {
            sql += ` ORDER BY f.rank`;
        } else {
            sql += ` ORDER BY ${orderBy}`;
        }

        sql += ` LIMIT ?`;
        params.push(limit);

        const { results: data } = await db.prepare(sql).bind(...params).all();
        results = data;

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
