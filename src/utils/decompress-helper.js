export async function decompressGzipResponse(res) {
    if (typeof DecompressionStream !== 'undefined') {
        return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
    }
    return res.text();
}
