// src/pages/api/related-models.js - V9.15 ROLLBACK
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

        // 🔥 V9.15: ROLLBACK to simple query - prioritize successful data flow
        const stmt = db.prepare(`
            SELECT id, name, author, likes, downloads, cover_image_url, pipeline_tag, description
            FROM models
            ORDER BY downloads DESC
            LIMIT 6
        `);
        const { results } = await stmt.all();

        return new Response(JSON.stringify({
            results: results || [],
            _debug: "V9.15 rollback mode"
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
