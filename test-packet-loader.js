async function fetchWithResilience(url, timeout = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (response.ok) return response;
        throw new Error(`HTTP ${response.status}`);
    } catch (e) {
        clearTimeout(id);
        const CDN_SECONDARY = 'https://ai-nexus-assets.pages.dev/cache';
        const secondaryUrl = url.replace('https://cdn.free2aitools.com/cache', CDN_SECONDARY);
        console.warn(`[Resilience] Primary fetch failed for ${url}, trying secondary: ${secondaryUrl}`);
        return fetch(secondaryUrl, { signal: AbortSignal.timeout(timeout) });
    }
}

async function fetchCompressedJSON(path) {
    const R2_CACHE_URL = 'https://cdn.free2aitools.com';
    const baseUrl = path.startsWith('http') ? '' : R2_CACHE_URL;
    const fullUrl = path.startsWith('http') ? path : `${baseUrl}/${path}`;
    const targetUrl = fullUrl.endsWith('.gz') ? fullUrl : `${fullUrl}.gz`;

    try {
        const res = await fetchWithResilience(targetUrl);
        if (!res.ok) {
            if (fullUrl.includes('/fused/')) return null;
            const legacyRes = await fetchWithResilience(fullUrl);
            if (!legacyRes.ok) return null;
            return legacyRes.json();
        }

        const buffer = await res.arrayBuffer();
        const uint8 = new Uint8Array(buffer);
        const isTrueGzip = uint8.length > 2 && uint8[0] === 0x1f && uint8[1] === 0x8b;

        if (isTrueGzip) {
            try {
                // Node 18+ has global DecompressionStream but it might be experimental or require imports. Note that Cloudflare worker has it.
                // Let's just check length to prove fetch works
                return { isTrueGzip, length: buffer.byteLength };
            } catch (e) {
                return { error: 'decompression fail' };
            }
        } else {
            return { parsed: true, length: buffer.byteLength };
        }
    } catch (e) {
        return null;
    }
}

async function run() {
    const start = Date.now();
    const result = await fetchCompressedJSON('cache/fused/hf-model--meta-llama--llama-3.1-8b-instruct.json.gz');
    console.log(`Time: ${Date.now() - start}ms`, result);
}
run();
