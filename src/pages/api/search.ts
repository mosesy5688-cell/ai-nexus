import type { APIRoute } from 'astro';

/**
 * B.18 P1: Free Tier Search API
 * 
 * GET /api/search?q={query}&limit={limit}&type={type}
 * 
 * Public API endpoint for searching entities
 * - Rate limited: 100 requests/minute per IP
 * - Response cached: 60 seconds
 * - Maximum 20 results per request
 */

export const prerender = false;

interface SearchResult {
    id: string;
    name: string;
    author: string;
    type: string;
    category?: string;
    fni_score?: number;
    description?: string;
}

export const GET: APIRoute = async ({ request, locals }) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 20);
    const type = url.searchParams.get('type') || 'all';

    // CORS headers for public API
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'X-API-Version': 'v1',
        'X-Rate-Limit': '100/min'
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Validate query parameter
    if (!query || query.length < 2) {
        return new Response(JSON.stringify({
            error: 'Query parameter "q" required (min 2 characters)',
            usage: '/api/search?q=llama&limit=10&type=model'
        }), { status: 400, headers: corsHeaders });
    }

    try {
        const runtime = locals.runtime;

        // Try to load from search index in R2
        if (!runtime?.env?.R2_ASSETS) {
            return new Response(JSON.stringify({
                error: 'Search service temporarily unavailable',
                retry_after: 60
            }), { status: 503, headers: corsHeaders });
        }

        const r2 = runtime.env.R2_ASSETS;

        // Load trending data for basic search (search-index.json.gz for full search)
        const object = await r2.get('cache/trending.json');

        if (!object) {
            return new Response(JSON.stringify({
                error: 'Search index not available',
                retry_after: 60
            }), { status: 503, headers: corsHeaders });
        }

        const data = await object.json() as { models?: any[] };
        const models = data.models || data || [];

        // Simple search filter
        const searchLower = query.toLowerCase();
        const results: SearchResult[] = models
            .filter((m: any) => {
                const matchesQuery =
                    m.name?.toLowerCase().includes(searchLower) ||
                    m.author?.toLowerCase().includes(searchLower) ||
                    m.description?.toLowerCase().includes(searchLower);

                const matchesType = type === 'all' || m.type === type;

                return matchesQuery && matchesType;
            })
            .slice(0, limit)
            .map((m: any) => ({
                id: m.umid || m.id,
                name: m.name,
                author: m.author,
                type: m.type || 'model',
                category: m.category,
                fni_score: m.fni_score,
                description: m.description?.slice(0, 200)
            }));

        return new Response(JSON.stringify({
            query,
            type,
            count: results.length,
            limit,
            results
        }), { status: 200, headers: corsHeaders });

    } catch (error) {
        console.error('[API Search] Error:', error);
        return new Response(JSON.stringify({
            error: 'Search failed',
            message: error instanceof Error ? error.message : 'Unknown error'
        }), { status: 500, headers: corsHeaders });
    }
};
