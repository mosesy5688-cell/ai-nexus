import zlib from 'zlib';

async function checkId(id) {
    const CDN_URL = 'https://cdn.free2aitools.com';

    const loadGz = async (url) => {
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            return zlib.gunzipSync(buffer).toString();
        } catch (e) {
            console.error(`Error loading ${url}:`, e.message);
            return null;
        }
    };

    console.log(`Checking ID: ${id}`);

    // 1. Check Graph
    const graphStr = await loadGz(`${CDN_URL}/cache/mesh/graph.json.gz`);
    if (graphStr) {
        if (graphStr.includes(id)) {
            console.log(`[GRAPH] Found ${id} in graph.json`);
            const graph = JSON.parse(graphStr);
            const edges = graph.links || graph.edges || [];
            const asTarget = edges.filter(e => e.target === id);
            console.log(`[GRAPH] ${id} is targeted by ${asTarget.length} edges.`);
        } else {
            console.log(`[GRAPH] ${id} NOT found in graph.json`);
        }
    }

    // 2. Check Search Core
    const searchStr = await loadGz(`${CDN_URL}/cache/search-core.json.gz`);
    if (searchStr) {
        if (searchStr.includes(id)) {
            console.log(`[SEARCH] Found ${id} in search-core.json`);
        } else {
            console.log(`[SEARCH] ${id} NOT found in search-core.json`);
        }
    }

    // 3. Check Entity File directly
    const entityRes = await fetch(`${CDN_URL}/cache/entities/${id}.json.gz`);
    console.log(`[ENTITY] ${id}.json.gz HTTP Status: ${entityRes.status}`);
}

checkId('hf-model--coqui--xtts-v2');
