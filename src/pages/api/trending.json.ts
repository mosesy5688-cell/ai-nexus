/**
 * Trending Models API Endpoint
 * 
 * Sprint 4 Phase 2: Quality-Gated Trending Section
 * Constitution V4.1 Pillar VII: Fair Index - Velocity (V) Dimension
 */

import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
    try {
        const runtime = (locals as any).runtime;
        if (!runtime?.env?.DB) {
            return new Response(JSON.stringify({
                error: 'Database not available',
                models: []
            }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const db = runtime.env.DB;

        // PM Quality Gate: Only show decent, trending models
        const query = `
            SELECT 
                id, slug, name, author, description,
                downloads, likes, license,
                fni_score, fni_p, fni_v, fni_c, fni_u,
                has_ollama, has_gguf, ollama_id,
                cover_image_url, pipeline_tag, last_updated
            FROM models 
            WHERE fni_v > 0 
              AND fni_score >= 30   
              AND downloads > 100   
            ORDER BY fni_v DESC 
            LIMIT 8
        `;

        const result = await db.prepare(query).all();

        return new Response(JSON.stringify({
            models: result.results || [],
            meta: {
                count: result.results?.length || 0,
                quality_gate: 'fni_score >= 30, downloads > 100',
                sorted_by: 'fni_v DESC (Velocity)'
            }
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=300'
            }
        });

    } catch (error) {
        console.error('[Trending API] Error:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            models: []
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
};
