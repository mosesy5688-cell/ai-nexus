import { fetchCompressedJSON } from './src/utils/packet-loader.js';

async function tryFetch() {
    const fusedHtml = await fetchCompressedJSON('cache/fused/hf-dataset--fka--prompts.chat.json.gz');
    console.log("Keys in fused dataset:", Object.keys(fusedHtml || {}));
    const pack = fusedHtml.entity ? fusedHtml.entity : fusedHtml;
    console.log("html_readme length:", pack.html_readme ? pack.html_readme.length : 'MISSING');
    console.log("description length:", pack.description ? pack.description.length : 'MISSING');
    console.log("relations length:", pack.relations ? pack.relations.length : 'MISSING');
}

tryFetch();
