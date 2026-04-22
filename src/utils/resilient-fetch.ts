import { R2_CACHE_URL } from '../config/constants.js';
import { decompressGzipResponse } from './decompress-helper.js';

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

        // V22.8: Handle 429 with immediate secondary fallback trigger
        if (response.status === 429) {
            console.warn(`[Resilience] 429 Rate Limited: ${url}`);
            throw new Error('429');
        }

        throw new Error(`HTTP ${response.status}`);
    } catch (e: any) {
        clearTimeout(id);
        const secondaryUrl = url.replace('https://cdn.free2aitools.com/cache', CDN_SECONDARY);
        console.warn(`[Resilience] Primary fetch failed for ${url} (Error: ${e.message}), trying secondary: ${secondaryUrl}`);

        // Short jittered delay for 429s before fallback to avoid storming the secondary
        if (e.message === '429') await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

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
                const text = await decompressGzipResponse(new Response(buffer));
                return JSON.parse(text);
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
