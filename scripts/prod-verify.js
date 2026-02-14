
import https from 'https';
import { gunzipSync, unzipSync } from 'zlib';

async function fetchSafe(url) {
    console.log(`\nFetching ${url}...`);
    return new Promise((resolve) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                console.log(`- Status: ${res.statusCode}`);
                resolve(null);
                return;
            }
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const uint8 = new Uint8Array(buffer);

                // EXACT REPRODUCTION OF packet-loader.ts logic
                const isActuallyGzip = uint8[0] === 0x1f && uint8[1] === 0x8b;
                console.log(`- Detected Actually Gzip: ${isActuallyGzip}`);

                if (isActuallyGzip) {
                    try {
                        const decompressed = gunzipSync(uint8);
                        resolve(JSON.parse(decompressed.toString()));
                    } catch (e) {
                        try {
                            const decompressed2 = unzipSync(uint8);
                            resolve(JSON.parse(decompressed2.toString()));
                        } catch (e2) {
                            console.log(`- Failed to decompress: ${e2.message}`);
                            resolve(null);
                        }
                    }
                } else {
                    try {
                        const data = JSON.parse(buffer.toString());
                        console.log('- SUCCESS: Parsed as plain JSON.');
                        resolve(data);
                    } catch (e) {
                        console.log(`- Failed to parse plain JSON: ${e.message}`);
                        resolve(null);
                    }
                }
            });
        }).on('error', e => {
            console.log(`- Network Error: ${e.message}`);
            resolve(null);
        });
    });
}

async function verify() {
    console.log('--- STARTING FINAL PRODUCTION DATA VERIFICATION ---');

    // 1. Test Search Core (The "fake .gz" that hangs search)
    const searchResult = await fetchSafe('https://cdn.free2aitools.com/cache/search-core.json.gz');
    if (searchResult) {
        const items = Array.isArray(searchResult) ? searchResult : (searchResult.entities || searchResult.models || []);
        console.log(`- Search items found: ${items.length}`);
    }

    // 2. Test Model Metadata (The anchor for 404s)
    // Based on search core, we know hf-model--meta-llama--meta-llama-3-8b exists
    const modelResult = await fetchSafe('https://cdn.free2aitools.com/cache/fused/hf-model--meta-llama--meta-llama-3-8b.json.gz');
    if (modelResult) {
        console.log(`- Model loaded: ${modelResult.name || modelResult.id}`);
    }

    console.log('\n--- VERIFICATION COMPLETE ---');
}

verify();
