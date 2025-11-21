export const prerender = false; // Enable SSR for this endpoint

export async function GET({ request, locals }) {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    const tag = url.searchParams.get('tag');
    const limit = parseInt(url.searchParams.get('limit') || '20');

    // Access D1 via locals (Cloudflare Adapter puts it there)
    // Note: In local dev (npm run dev), this might need a proxy or mock if not using 'wrangler pages dev'
    const db = locals.runtime?.env?.DB;

    if (!db) {
        return new Response(JSON.stringify({ error: 'Database not available' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        let sql = `SELECT * FROM models WHERE 1=1`;
        const params = [];

        if (query) {
            sql += ` AND (name LIKE ? OR description LIKE ? OR author LIKE ?)`;
            const likeQuery = `%${query}%`;
            params.push(likeQuery, likeQuery, likeQuery);
        }

        if (tag) {
            // Simple JSON array check (SQLite doesn't have great JSON functions in all versions, but LIKE works for simple arrays)
            sql += ` AND tags LIKE ?`;
            params.push(`%${tag}%`);
        }

        sql += ` ORDER BY likes DESC LIMIT ?`;
        params.push(limit);

        const { results } = await db.prepare(sql).bind(...params).all();

        return new Response(JSON.stringify({ results }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60' // Cache for 1 minute
            }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
