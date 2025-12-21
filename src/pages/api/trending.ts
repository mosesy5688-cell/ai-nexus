import type { APIRoute } from 'astro';

/**
 * B.18 P1: Free Tier Trending API
 * 
 * GET /api/trending?limit={limit}&type={type}
 * 
 * Public API endpoint for trending entities
 * - Rate limited: 100 requests/minute per IP
 * - Response cached: 300 seconds (5 min)
 * - Maximum 50 results per request
 */

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const type = url.searchParams.get('type') || 'model';
    const sortBy = url.searchParams.get('sort') || 'fni'; // fni, downloads, likes

    // CORS headers for public API
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        'X-API-Version': 'v1',
        'X-Rate-Limit': '100/min'
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
        const runtime = locals.runtime;

        if (!runtime?.env?.R2_ASSETS) {
            return new Response(JSON.stringify({
                error: 'Service temporarily unavailable',
                retry_after: 60
            }), { status: 503, headers: corsHeaders });
        }

        const r2 = runtime.env.R2_ASSETS;
        const object = await r2.get('cache/trending.json');

        if (!object) {
            return new Response(JSON.stringify({
                error: 'Trending data not available',
                retry_after: 60
            }), { status: 503, headers: corsHeaders });
        }

        const data = await object.json() as { models?: any[], generated_at?: string };
        let models = data.models || data || [];

        // Filter by type
        if (type !== 'all') {
            models = models.filter((m: any) => (m.type || 'model') === type);
        }

        // Sort
        switch (sortBy) {
            case 'downloads':
                models.sort((a: any, b: any) => (b.downloads || 0) - (a.downloads || 0));
                break;
            case 'likes':
                models.sort((a: any, b: any) => (b.likes || 0) - (a.likes || 0));
                break;
            case 'fni':
            default:
                models.sort((a: any, b: any) => (b.fni_score || 0) - (a.fni_score || 0));
        }

        // Limit and map results
        const results = models.slice(0, limit).map((m: any, index: number) => ({
            rank: index + 1,
            id: m.umid || m.id,
            name: m.name,
            author: m.author,
            type: m.type || 'model',
            category: m.category,
            fni_score: m.fni_score,
            downloads: m.downloads,
            likes: m.likes,
            source: m.source
        }));

        return new Response(JSON.stringify({
            type,
            sort: sortBy,
            count: results.length,
            limit,
            generated_at: data.generated_at,
            results
        }), { status: 200, headers: corsHeaders });

    } catch (error) {
        console.error('[API Trending] Error:', error);
        return new Response(JSON.stringify({
            error: 'Failed to fetch trending data',
            message: error instanceof Error ? error.message : 'Unknown error'
        }), { status: 500, headers: corsHeaders });
    }
};
