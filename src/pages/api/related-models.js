// src/pages/api/related-models.js - V9.19 SQL ROLLBACK
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

        // 🔥 V9.19: ROLLBACK - Simple LIMIT 6 for data visibility
        const stmt = db.prepare(`
            SELECT id, name, author, likes, downloads, cover_image_url, pipeline_tag, description
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
