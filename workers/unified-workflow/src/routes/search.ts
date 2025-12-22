import { Env } from '../config/types';

/**
 * Handle /api/search requests (B.17)
 */
export async function handleSearch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);

    if (!query) {
        return new Response(JSON.stringify({ error: 'Query parameter "q" is required' }), { status: 400 });
    }

    try {
        // Using FTS5 MATCH with JOIN for ranking by fni_score
        const results = await env.DB.prepare(`
            SELECT 
                e.id, e.name, e.author, e.type, 
                e.primary_category, e.fni_score, e.likes, e.downloads
            FROM entities e
            JOIN entities_fts f ON e.id = f.id
            WHERE entities_fts MATCH ?
            ORDER BY e.fni_score DESC
            LIMIT ?
        `).bind(query, limit).all();

        return new Response(JSON.stringify({
            query,
            results: results.results || [],
            count: results.results?.length || 0,
            timestamp: new Date().toISOString()
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=600', // 10 min cache
                'Access-Control-Allow-Origin': '*'
            }
        });
    } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
