
// Gzip Utility (CES V5.1.2) - Force Compression for R2
// Constitution Art. 2.2: All R2 JSON writes must be Gzip compressed

export async function writeToR2(
    env: any,
    key: string,
    data: any,
    contentType: string = 'application/json'
): Promise<void> {
    console.log(`[R2] Writing to ${key}...`);

    // Serialize JSON
    const jsonString = typeof data === 'string' ? data : JSON.stringify(data);

    // Create gzip compressed stream
    const bodyStream = new Response(jsonString).body!;
    const compressedStream = bodyStream.pipeThrough(new CompressionStream('gzip'));

    try {
        await env.R2_ASSETS.put(key, compressedStream, {
            httpMetadata: {
                contentEncoding: 'gzip',
                contentType: contentType
            }
        });
        console.log(`[R2] ✅ Wrote ${key} (gzip)`);
    } catch (err: any) {
        console.error(`[R2] ❌ Gzip write failed for ${key}:`, err.message);
        // Fallback: write plain JSON
        console.log(`[R2] Falling back to plain JSON for ${key}`);
        await env.R2_ASSETS.put(key, jsonString, {
            httpMetadata: { contentType: contentType }
        });
        console.log(`[R2] ✅ Wrote ${key} (plain)`);
    }
}


