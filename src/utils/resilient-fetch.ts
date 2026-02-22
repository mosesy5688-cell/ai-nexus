import { R2_CACHE_URL } from '../config/constants.js';

const CDN_SECONDARY = 'https://ai-nexus-assets.pages.dev/cache';

/**
 * Resilient fetching with timeout and secondary fallback
 */
export async function fetchWithResilience(url: string, timeout = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (response.ok) return response;
        throw new Error(`HTTP ${response.status}`);
    } catch (e: any) {
        clearTimeout(id);
        const secondaryUrl = url.replace('https://cdn.free2aitools.com/cache', CDN_SECONDARY);
        console.warn(`[Resilience] Primary fetch failed for ${url}, trying secondary: ${secondaryUrl}`);
        return fetch(secondaryUrl, { signal: AbortSignal.timeout(timeout) });
    }
}

/**
 * V19.4: Clean Gzip-First Fetcher
 */
export async function fetchCompressedJSON(path: string): Promise<any | null> {
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
                const ds = new DecompressionStream('gzip');
                const decompressedRes = new Response(new Response(buffer).body?.pipeThrough(ds));
                return decompressedRes.json();
            } catch (error: any) {
                return JSON.parse(new TextDecoder().decode(buffer));
            }
        } else {
            return JSON.parse(new TextDecoder().decode(buffer));
        }
    } catch (e: any) {
        console.error(`[Loader] Fetch error for ${targetUrl}:`, e.message);
        return null;
    }
}
