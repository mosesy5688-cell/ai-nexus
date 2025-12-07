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
        const db = locals.runtime?.env?.DB;
        if (!db) {
            return new Response(JSON.stringify({ nodes: [], links: [] }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Fetch main model
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

        // Use related_ids from model (primary data source)
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

        // Fetch related models details
        if (relatedIds.length > 0) {
            const placeholders = relatedIds.map(() => '?').join(',');
            const { results: relatedModels } = await db.prepare(`
                SELECT id, name, author, pipeline_tag, slug FROM models 
                WHERE id IN (${placeholders})
                LIMIT 10
            `).bind(...relatedIds).all();

            for (const related of relatedModels || []) {
                const nodeId = related.id;

                // Add node
                nodes.set(nodeId, {
                    id: nodeId,
                    name: related.name || nodeId.split('/').pop(),
                    group: 'model',
                    slug: related.slug || related.id.replace(/\//g, '--'),
                    author: related.author,
                    pipeline_tag: related.pipeline_tag,
                    val: 10
                });

                // Add link
                links.push({
                    source: mainNodeId,
                    target: nodeId,
                    type: 'related',
                    value: 1
                });
            }
        }

        // Fallback: If no related_ids, try graph_edges table
        if (links.length === 0) {
            try {
                const { results: edges } = await db.prepare(`
                    SELECT * FROM graph_edges 
                    WHERE source LIKE ? OR target LIKE ?
                    LIMIT 20
                `).bind(`%${model.id}%`, `%${model.id}%`).all();

                for (const edge of edges || []) {
                    const isSource = edge.source.includes(model.id);
                    const otherUrn = isSource ? edge.target : edge.source;

                    const parts = otherUrn.split(':');
                    const type = parts[1] || 'unknown';
                    const value = parts.slice(2).join(':');

                    if (!nodes.has(otherUrn)) {
                        nodes.set(otherUrn, {
                            id: otherUrn,
                            name: value.split('/').pop() || value,
                            group: type,
                            slug: value.replace(/\//g, '--'),
                            val: 5
                        });
                    }

                    links.push({
                        source: mainNodeId,
                        target: otherUrn,
                        type: edge.type || 'related',
                        value: 1
                    });
                }
            } catch (e) {
                // graph_edges table might not exist, ignore
                console.warn('[Graph] graph_edges query failed:', e.message);
            }
        }

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
