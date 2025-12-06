
export const prerender = false;

export async function GET({ request, locals }) {
    const url = new URL(request.url);
    const nodeId = url.searchParams.get('nodeId');

    if (!nodeId) {
        return new Response(JSON.stringify({ error: 'Missing nodeId parameter' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Get D1 database from runtime environment (Cloudflare Pages)
    // Access via locals.runtime (standard for Astro adapters)
    const db = locals?.runtime?.env?.DB;

    if (!db) {
        return new Response(JSON.stringify({ error: 'Database not available' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        // 1. Fetch outgoing edges (I am source)
        const outgoing = await db.prepare(
            `SELECT target as id, type, weight FROM graph_edges WHERE source = ?`
        ).bind(nodeId).all();

        // 2. Fetch incoming edges (I am target)
        const incoming = await db.prepare(
            `SELECT source as id, type, weight FROM graph_edges WHERE target = ?`
        ).bind(nodeId).all();

        // Normalize logic: "incoming" means someone points to me.
        // e.g. urn:paper:123 -(cited_by)-> urn:model:abc
        // If I query urn:model:abc, I want to know it is cited_by urn:paper:123.
        // The directionality matters for the relationship name.

        const neighbors = [
            ...(outgoing.results || []).map(r => ({ ...r, direction: 'outgoing' })),
            ...(incoming.results || []).map(r => ({ ...r, direction: 'incoming' }))
        ];

        return new Response(JSON.stringify({ node: nodeId, neighbors }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Graph API Error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
