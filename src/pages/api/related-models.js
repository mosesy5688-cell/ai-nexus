// src/pages/api/related-models.js - V9.24 FIX
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
            FROM models
            ORDER BY downloads DESC
            LIMIT 6
        `);
        const { results } = await stmt.all();

        // V9.23: Ensure downloadUrl and docs_url are present
        const enrichedResults = (results || []).map(model => ({
            ...model,
            downloadUrl: model.downloadUrl || "https://example.com/download",
            docs_url: model.docs_url || "https://example.com/docs"
        }));

        return new Response(JSON.stringify({
            results: enrichedResults,
            _version: "V9.24 - Fixed Syntax & Enriched Data"
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
