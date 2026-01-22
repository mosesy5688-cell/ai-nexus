async function checkGraph() {
    const res = await fetch('https://cdn.free2aitools.com/cache/mesh/graph.json');
    const data = await res.json();
    const llamaId = "replicate:meta/meta-llama-3-8b-instruct";

    // Check as source
    const edges = data.edges[llamaId] || [];
    console.log(`Edges for ${llamaId}:`, edges);

    // Check by stripped match
    const strippedLlama = "meta-llama-3-8b-instruct";
    const allMatches = [];
    for (const [src, targets] of Object.entries(data.edges)) {
        if (src.includes(strippedLlama)) {
            allMatches.push({ src, targets });
        }
    }
    console.log(`Found ${allMatches.length} raw matches in graph edges`);
}
checkGraph();
