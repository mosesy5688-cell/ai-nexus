export const prerender = false;

import { getModelBySlug } from '../../../utils/db.js'; // Explicit extension fix

export async function GET({ request, params, locals }) {
    const url = new URL(request.url);
    const modelId = url.searchParams.get('id');

    if (!modelId) {
        return new Response(JSON.stringify({ error: 'Model ID required' }), { status: 400 });
    }

    const nodes = new Map();
    const links = [];

    // Add main node
    const mainNodeId = modelId;
    nodes.set(mainNodeId, {
        id: mainNodeId,
        name: modelId.split('/')[1] || modelId,
        group: 'main',
        val: 20
    });

    try {
        const db = locals.runtime.env.DB;

        // URN for the requested model
        const modelUrn = `urn:model:${modelId}`;

        // Query edges where this model is source or target
        const stmt = db.prepare(`
            SELECT * FROM graph_edges 
            WHERE source = ? OR target = ? 
            LIMIT 100
        `).bind(modelUrn, modelUrn);

        const { results } = await stmt.all();

        for (const edge of results) {
            // Identify the "other" node
            const isSource = edge.source === modelUrn;
            const otherUrn = isSource ? edge.target : edge.source;

            // Helper to parse URN
            // urn:type:value
            const parts = otherUrn.split(':');
            const type = parts[1] || 'unknown';
            const value = parts.slice(2).join(':');

            // Add node if not exists
            if (!nodes.has(otherUrn)) {
                nodes.set(otherUrn, {
                    id: otherUrn,
                    name: value, // TODO: Enhance with real titles lookup if needed
                    group: type,
                    val: 5
                });
            }

            // Add link
            links.push({
                source: isSource ? mainNodeId : otherUrn,
                target: isSource ? otherUrn : mainNodeId,
                type: edge.type,
                value: 1
            });
        }

    } catch (e) {
        console.error("Graph data fetch error:", e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }

    return new Response(JSON.stringify({
        nodes: Array.from(nodes.values()),
        links
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
