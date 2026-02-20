import fs from 'node:fs';

async function tryFetch() {
    const url = 'https://cdn.free2aitools.com/cache/fused/hf-dataset--fka--prompts.chat.json.gz';
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    try {
        const rawText = new TextDecoder().decode(buffer);
        const json = JSON.parse(rawText);
        console.log("Successfully parsed as plain JSON! Keys:", Object.keys(json));
        const pack = json.entity ? json.entity : json;
        console.log("html_readme length:", pack.html_readme ? pack.html_readme.length : 'MISSING');
        console.log("description length:", pack.description ? pack.description.length : 'MISSING');
        console.log("relations length:", pack.relations ? pack.relations.length : typeof pack.relations);
        console.log("Mesh profile:", pack.mesh_profile ? Object.keys(pack.mesh_profile) : 'MISSING');
    } catch (err) {
        console.error("Failed to parse", err);
    }
}

tryFetch();
