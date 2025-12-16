
// Gzip Utility (CES V5.1.2) - Force Compression for R2

export async function writeToR2(
    env: any,  // Env type difficult to import circularly, using any
    key: string,
    data: any,
    contentType: string = 'application/json'
): Promise<void> {

    // Auto-serialize JSON
    let bodyStream: ReadableStream;
    if (typeof data !== 'string') {
        bodyStream = new Response(JSON.stringify(data)).body!;
    } else {
        bodyStream = new Response(data).body!;
    }

    // Pipe through Gzip
    const compressedStream = bodyStream.pipeThrough(new CompressionStream('gzip'));

    // Write with Metadata
    await env.R2_ASSETS.put(key, compressedStream, {
        httpMetadata: {
            contentEncoding: 'gzip',
            contentType: contentType
        }
    });
}
