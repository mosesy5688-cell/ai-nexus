import zlib from 'node:zlib';
import fs from 'node:fs';

async function testFetch() {
    const url = 'https://cdn.free2aitools.com/cache/fused/hf-model--meta-llama--llama-3.1-8b-instruct.json.gz';
    console.log("Fetching:", url);
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const uint8 = new Uint8Array(buffer);

    console.log(`Length: ${buffer.byteLength}, Magic bytes: ${uint8[0].toString(16)} ${uint8[1].toString(16)}`);

    try {
        const decompressed = zlib.gunzipSync(Buffer.from(buffer));
        const json = JSON.parse(decompressed.toString('utf-8'));
        console.log("Decoded via gunzip. Keys:", Object.keys(json));
    } catch (e) {
        console.error("Failed to decode via gunzip:", e.message);
        try {
            const rawText = new TextDecoder().decode(buffer);
            console.log("Raw text start:", rawText.slice(0, 100));
            const json = JSON.parse(rawText);
            console.log("Successfully parsed as plain JSON! Keys:", Object.keys(json));
            if (json.entity) console.log("Has json.entity:", Object.keys(json.entity).slice(0, 5));
        } catch (err) {
            console.error("Failed to parse as plain JSON either:", err.message);
        }
    }
}

testFetch();
