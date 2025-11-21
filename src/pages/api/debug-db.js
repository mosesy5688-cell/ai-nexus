export const prerender = false;

export async function GET({ locals }) {
    const db = locals.runtime?.env?.DB;

    if (!db) {
        return new Response(JSON.stringify({ error: 'DB binding not found' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        // Check table count
        const { results: countResults } = await db.prepare("SELECT COUNT(*) as count FROM models").all();

        // Check first 5 rows
        const { results: rows } = await db.prepare("SELECT * FROM models LIMIT 5").all();

        return new Response(JSON.stringify({
            count: countResults[0]?.count,
            sample: rows
        }, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
