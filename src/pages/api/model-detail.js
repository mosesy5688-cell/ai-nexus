export const prerender = false;

export async function GET({ locals, url }) {
    const db = locals.runtime?.env?.DB;
    const modelId = url.searchParams.get('id');

    if (!db) {
        return new Response(JSON.stringify({ error: 'Database not available' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (!modelId) {
        return new Response(JSON.stringify({ error: 'Model ID required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const model = await db.prepare("SELECT * FROM models WHERE id = ?").bind(modelId).first();

        if (!model) {
            return new Response(JSON.stringify({ error: 'Model not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify(model), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
