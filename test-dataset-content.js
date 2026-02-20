import fs from 'node:fs';

async function tryFetch() {
    const url = 'https://cdn.free2aitools.com/cache/fused/hf-dataset--fka--prompts.chat.json.gz';
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    try {
        const rawText = new TextDecoder().decode(buffer);
        const json = JSON.parse(rawText);
        const pack = json.entity ? json.entity : json;
        console.log("HTML README CONTENT:");
        console.log("-------------------");
        console.log(pack.html_readme);
        console.log("-------------------");
        console.log("RELATIONS CONTENT:");
        console.log(JSON.stringify(pack.relations, null, 2));
    } catch (err) {
        console.error("Failed to parse", err);
    }
}

tryFetch();
