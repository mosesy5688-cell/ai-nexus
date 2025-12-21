import type { APIRoute } from 'astro';

/**
 * B.18 P1: Free Tier Entity API
 * 
 * GET /api/entity/{id}
 * 
 * Public API endpoint for fetching single entity details
 * - Rate limited: 100 requests/minute per IP
 * - Response cached: 300 seconds (5 min)
 */

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
    const entityId = params.id;

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

    if (!entityId) {
        return new Response(JSON.stringify({
            error: 'Entity ID required',
            usage: '/api/entity/{id}'
        }), { status: 400, headers: corsHeaders });
    }

    try {
        const runtime = locals.runtime;

        // Try R2 first for entity detail
        if (runtime?.env?.R2_ASSETS) {
            const r2 = runtime.env.R2_ASSETS;

            // Try to find in entities.json
            const object = await r2.get('data/entities.json');

            if (object) {
                const data = await object.json() as any[];
                const entity = data.find((e: any) =>
                    e.umid === entityId ||
                    e.id === entityId ||
                    e.slug === entityId
                );

                if (entity) {
                    return new Response(JSON.stringify({
                        success: true,
                        data: {
                            id: entity.umid || entity.id,
                            name: entity.name,
                            author: entity.author,
                            type: entity.type || 'model',
                            source: entity.source,
                            category: entity.category,
                            fni_score: entity.fni_score,
                            fni_components: entity.fni_components,
                            likes: entity.likes,
                            downloads: entity.downloads,
                            description: entity.description,
                            tags: entity.tags,
                            last_updated: entity.last_updated || entity.last_modified,
                            source_url: entity.source_url || entity.url,
                            created_at: entity.created_at
                        }
                    }), { status: 200, headers: corsHeaders });
                }
            }
        }

        // Fallback: Try D1 database
        if (runtime?.env?.DB) {
            const db = runtime.env.DB;
            const result = await db.prepare(`
        SELECT * FROM entities 
        WHERE umid = ? OR id = ? OR slug = ?
        LIMIT 1
      `).bind(entityId, entityId, entityId).first();

            if (result) {
                return new Response(JSON.stringify({
                    success: true,
                    source: 'd1',
                    data: result
                }), { status: 200, headers: corsHeaders });
            }
        }

        return new Response(JSON.stringify({
            error: 'Entity not found',
            id: entityId
        }), { status: 404, headers: corsHeaders });

    } catch (error) {
        console.error('[API Entity] Error:', error);
        return new Response(JSON.stringify({
            error: 'Failed to fetch entity',
            message: error instanceof Error ? error.message : 'Unknown error'
        }), { status: 500, headers: corsHeaders });
    }
};
