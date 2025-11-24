// src/pages/api/related-models.js
export const prerender = false;
export async function GET({ request, locals }) {
    try {
        const db = locals?.runtime?.env?.DB;
        if (!db) {
            return new Response(JSON.stringify({ error: 'Database unavailable' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 🔥 EMERGENCY DEBUG: Simple query to confirm D1 works
        // Bypassing all WHERE clauses to get ANY data
        const stmt = db.prepare(`
            SELECT id, name, author, likes, downloads, cover_image_url, pipeline_tag
            FROM models
            ORDER BY downloads DESC
            LIMIT 6
        `);
        const { results } = await stmt.all();

        return new Response(JSON.stringify({
            results: results || [],
            debug: {
                resultCount: results?.length || 0,
                note: "Emergency debug mode - returning top 6 models by downloads"
            }
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=3600'
            }
        });

    } catch (e) {
        console.error('API Error:', e);
        return new Response(JSON.stringify({
            error: e.message,
            stack: e.stack
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
