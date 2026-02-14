
import { R2_CACHE_URL } from '../src/config/constants.js';

async function fetchSafeJSON(path) {
    const fullUrl = path.startsWith('http') ? path : `${R2_CACHE_URL}/${path}`;
    console.log(`Checking ${fullUrl}...`);
    try {
        const res = await fetch(fullUrl);
        if (!res.ok) {
            console.log(`- Status: ${res.status}`);
            return null;
        }

        const buffer = await res.arrayBuffer();
        const uint8 = new Uint8Array(buffer);
        const isActuallyGzip = uint8[0] === 0x1f && uint8[1] === 0x8b;
        console.log(`- Detected Actually Gzip: ${isActuallyGzip}`);

        if (isActuallyGzip) {
            if (typeof globalThis.DecompressionStream !== 'undefined') {
                const ds = new DecompressionStream('gzip');
                const writer = ds.writable.getWriter();
                writer.write(buffer);
                writer.close();
                const output = new Response(ds.readable);
                return await output.json();
            } else {
                // Fallback to node zlib
                const { gunzipSync } = await import('node:zlib');
                const decompressed = gunzipSync(uint8);
                return JSON.parse(new TextDecoder().decode(decompressed));
            }
        } else {
            const text = new TextDecoder().decode(uint8);
            return JSON.parse(text);
        }
    } catch (e) {
        console.error(`- Error: ${e.message}`);
        return null;
    }
}

async function verify() {
    // Known path based on search core inspection
    const path = 'cache/fused/hf-model--meta-llama--meta-llama-3-8b.json.gz';
    const result = await fetchSafeJSON(path);
    if (result) {
        console.log('SUCCESS: Loaded Llama 3 metadata.');
        console.log('ID:', result.id || (result.entity ? result.entity.id : 'N/A'));
        console.log('Name:', result.name || (result.entity ? result.entity.name : 'N/A'));
    } else {
        console.log('FAILED: Could not load Llama 3.');
    }
}

verify();
