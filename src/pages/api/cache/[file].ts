import type { APIRoute } from 'astro';

/**
 * V4.9 R2 Cache Proxy
 * Serves L8 precomputed files from R2 cache/ directory
 * Art.11-G: Version-locked data access
 * V4.9: Added entity_definitions.json and trending_models.json
 */
export const GET: APIRoute = async ({ params, locals }) => {
    const file = params.file;

    if (!file) {
        return new Response(JSON.stringify({ error: 'File parameter required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Allowed cache files (whitelist for security)
    const allowedFiles = [
        'neural_graph.json',
        'trending.json',
        'leaderboard.json',
        'global_popularity.json',
        'category_stats.json',
        'benchmarks.json',
        'entity_links.json',        // V4.8.2: EntityLinksSection compliance
        'entity_definitions.json',  // V4.9: Entity type definitions
        'lists/trending_models.json'  // V4.9: Segregated trending lists
    ];

    if (!allowedFiles.includes(file)) {
        return new Response(JSON.stringify({ error: 'File not allowed' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const runtime = locals.runtime;
        if (!runtime?.env?.R2_ASSETS) {
            // Fallback: try to read from public/cache if R2 not available
            return new Response(JSON.stringify({ error: 'R2 not available' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const r2 = runtime.env.R2_ASSETS;
        const object = await r2.get(`cache/${file}`);

        if (!object) {
            return new Response(JSON.stringify({ error: 'File not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const content = await object.text();

        return new Response(content, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=3600',
                'X-R2-Cache': 'true',
                'X-Version': 'V4.9'
            }
        });
    } catch (error) {
        console.error('[R2 Cache] Error:', error);
        return new Response(JSON.stringify({ error: 'Internal error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
};
