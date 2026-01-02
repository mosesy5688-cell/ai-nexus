// src/pages/api/graph/neighbors.json.js
// V14.2 Zero-Cost Constitution: D1 REMOVED - Using R2 Static Cache Only

export const prerender = false;

import { getModelBySlug } from '../../../utils/db.js';

export async function GET({ request, locals }) {
    const url = new URL(request.url);
    const modelId = url.searchParams.get('id');

    if (!modelId) {
        return new Response(JSON.stringify({ error: 'Model ID required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const nodes = new Map();
    const links = [];

    try {
        // V14.2: D1 check REMOVED - getModelBySlug now uses R2
        // Fetch main model from R2 cache
        const model = await getModelBySlug(modelId, locals);

        if (!model) {
            return new Response(JSON.stringify({ nodes: [], links: [] }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Add main node
        const mainNodeId = model.id;
        nodes.set(mainNodeId, {
            id: mainNodeId,
            name: model.name || modelId.split('/').pop(),
            group: 'main',
            slug: model.slug || model.id.replace(/\//g, '--'),
            val: 20
        });

        // Use related_ids from model (embedded in R2 cache)
        let relatedIds = [];
        try {
            if (model.related_ids) {
                relatedIds = typeof model.related_ids === 'string'
                    ? JSON.parse(model.related_ids)
                    : model.related_ids;
            }
        } catch (e) {
            console.warn('[Graph] Failed to parse related_ids:', e);
        }

        // V14.2: Add nodes for related IDs from cached data
        // Note: Full details require individual R2 lookups (expensive)
        // For now, just show IDs as simplified nodes
        for (const relatedId of relatedIds.slice(0, 10)) {
            const nodeId = relatedId;
            nodes.set(nodeId, {
                id: nodeId,
                name: nodeId.split('/').pop() || nodeId.split('--').pop(),
                group: 'related',
                slug: nodeId.replace(/\//g, '--'),
                val: 10
            });

            links.push({
                source: mainNodeId,
                target: nodeId,
                type: 'related',
                value: 1
            });
        }

        // V14.2: D1 graph_edges fallback REMOVED per Zero-Cost Constitution

    } catch (e) {
        console.error('[Graph] Error:', e);
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    return new Response(JSON.stringify({
        nodes: Array.from(nodes.values()),
        links
    }), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300'
        }
    });
}
