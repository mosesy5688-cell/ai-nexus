export const prerender = false;

import { getModelBySlug } from '../../../utils/db'; // Fix build path

export async function GET({ request, params, locals }) {
    const url = new URL(request.url);
    const modelId = url.searchParams.get('id');

    if (!modelId) {
        return new Response(JSON.stringify({ error: 'Model ID required' }), { status: 400 });
    }

    // Mock Data for Verification (Until real DB table is populated)
    // TODO: Replace with real SQL query from `graph_edges` table

    /* 
       Real Query Plan:
       SELECT * FROM graph_edges WHERE source = ? OR target = ?
    */

    const nodes = [
        { id: modelId, name: modelId.split('/')[1] || modelId, group: 'main' }
    ];
    const links = [];

    // Add some dummy connections for visual testing if DB read fails or is empty
    // In production, we fetch relationships

    // Example: Fetch raw model data to find ArXiv or PWC links to simulate graph
    // (This is a temporary shim to make the graph work immediately with existing data)
    try {
        const db = locals.runtime.env.DB;
        const stmt = db.prepare('SELECT * FROM models WHERE id = ?').bind(modelId);
        const model = await stmt.first();

        if (model) {
            // Paper Node
            if (model.arxiv_id) {
                const paperId = `arxiv:${model.arxiv_id}`;
                nodes.push({ id: paperId, name: `ArXiv: ${model.arxiv_id}`, group: 'paper', url: `https://arxiv.org/abs/${model.arxiv_id}` });
                links.push({ source: modelId, target: paperId, value: 5 });
            }

            // Benchmark Nodes
            if (model.pwc_benchmarks) {
                try {
                    const benchmarks = JSON.parse(model.pwc_benchmarks);
                    benchmarks.slice(0, 5).forEach((b, i) => {
                        const benchId = `bench:${i}`;
                        nodes.push({ id: benchId, name: `${b.dataset} (${b.value})`, group: 'benchmark' });
                        links.push({ source: modelId, target: benchId, value: 3 });
                    });
                } catch (e) { }
            }

            // Similar models (using pipeline tag as proxy for relationships)
            if (model.pipeline_tag) {
                const similarStmt = db.prepare('SELECT id, name FROM models WHERE pipeline_tag = ? AND id != ? LIMIT 5').bind(model.pipeline_tag, modelId);
                const { results } = await similarStmt.all();

                results.forEach(m => {
                    nodes.push({ id: m.id, name: m.name, group: 'model' });
                    links.push({ source: modelId, target: m.id, value: 2 });
                });
            }
        }
    } catch (e) {
        console.error("Graph data fetch error:", e);
    }

    return new Response(JSON.stringify({ nodes, links }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
