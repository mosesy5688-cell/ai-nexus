async function tryFetch() {
    console.log("Starting fetch...");
    const url = 'https://cdn.free2aitools.com/cache/fused/hf-dataset--fka--prompts.chat.json.gz';
    try {
        const res = await fetch(url);
        console.log("Fetch code:", res.status);
        const buffer = await res.arrayBuffer();
        const rawText = new TextDecoder().decode(buffer);
        const json = JSON.parse(rawText);
        const pack = json.entity ? json.entity : json;
        console.log("has features:", !!pack.features);
        console.log("has rows:", !!pack.rows);
        console.log("has configs:", !!pack.configs);
        console.log("keys:", Object.keys(pack));
    } catch (err) {
        console.error("Failed to parse:", err);
    }
}

tryFetch();
