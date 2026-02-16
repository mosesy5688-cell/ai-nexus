import fs from 'fs';
import zlib from 'zlib';

const GRAPH_PATH = './output/cache/mesh/graph.json.gz';

try {
    const buffer = fs.readFileSync(GRAPH_PATH);
    const decompressed = zlib.gunzipSync(buffer);
    const graph = JSON.parse(decompressed.toString());

    console.log(`Graph Loaded: ${graph.nodes ? Object.keys(graph.nodes).length : 0} nodes`);

    const testIds = [
        'meta-llama--meta-llama-3-8b',
        'meta-llama--meta-llama-3-70b',
        'mistralai--mistral-7b-v0.1'
    ];

    testIds.forEach(id => {
        const fullId = `hf-model--${id}`;
        const edges = graph.edges?.[fullId] || [];
        console.log(`Node: ${fullId} | Relations: ${edges.length}`);
        if (edges.length > 0) {
            edges.slice(0, 3).forEach(e => console.log(`  -> ${e.target} (${e.type})`));
        }
    });

} catch (e) {
    console.error('Verify failed:', e.message);
}
