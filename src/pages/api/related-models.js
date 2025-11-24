```javascript
// src/pages/api/related-models.js
export const prerender = false;
export async function GET({ request, locals }) {
    try {
        const url = new URL(request.url);
        const idsParam = url.searchParams.get('ids');

        const db = locals?.runtime?.env?.DB;
        if (!db) {
            return new Response(JSON.stringify({ error: 'Database unavailable' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // If no IDs provided, return top 6 models as fallback
        if (!idsParam) {
            const stmt = db.prepare(`
                SELECT id, name, author, likes, downloads, cover_image_url, pipeline_tag, description
                FROM models
                ORDER BY downloads DESC
                LIMIT 6
    `);
            const { results } = await stmt.all();
            return new Response(JSON.stringify({ results: results || [] }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=3600'
                }
            });
        }

        const ids = idsParam.split(',').map(id => id.trim()).filter(id => id.length > 0);

        if (ids.length === 0) {
            return new Response(JSON.stringify({ results: [] }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Use parameterized query for safety
        const placeholders = ids.map(() => '?').join(',');
        const stmt = db.prepare(`
            SELECT id, name, author, likes, downloads, cover_image_url, pipeline_tag, description
            FROM models
            WHERE id IN(${ placeholders })
    `);

        const { results } = await stmt.bind(...ids).all();

        return new Response(JSON.stringify({ results: results || [] }), {
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
```
