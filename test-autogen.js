import { fetchCompressedJSON } from './src/utils/packet-loader.js';

async function tryFetch(path) {
    try {
        const result = await fetchCompressedJSON(path);
        console.log(`[${path}] -> ${result ? 'FOUND' : 'MISS'}`);
        return !!result;
    } catch (e) {
        console.error("Error:", e.message);
        return false;
    }
}

async function run() {
    await tryFetch('cache/fused/gh-agent--microsoft-autogen.json.gz');
    await tryFetch('cache/fused/gh-agent--microsoft--autogen.json.gz');
    await tryFetch('cache/fused/agent--microsoft-autogen.json.gz');
    await tryFetch('cache/fused/agent--microsoft--autogen.json.gz');
    await tryFetch('cache/fused/microsoft-autogen.json.gz');
}

run();
