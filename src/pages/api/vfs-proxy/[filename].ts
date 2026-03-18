import { handleVfsProxy } from '@/lib/db';

export const prerender = false;

const EDGE_CACHE_TTL = 3600; // 1 hour edge cache

/**
 * V24.0 Hardened VFS Range Proxy with Edge Cache
 * Standardizes access to R2 SQLite shards with 8KB alignment.
 * Uses Cloudflare Cache API to prevent 429 throttling on cold starts.
 */
export async function GET({ request, locals }) {
    const env = locals.runtime?.env;

    if (!env || !env.R2_ASSETS) {
        console.error('[VFS-PROXY] R2_ASSETS binding missing in runtime env.');
        return new Response('Environment Error', { status: 500 });
    }

    // V24.0: Edge Cache layer — prevent 429 by caching responses at CF edge
    const cacheKey = new Request(request.url, { method: 'GET', headers: { Range: request.headers.get('Range') || '' } });
    // @ts-ignore - Cloudflare Workers Cache API
    const cache = typeof caches !== 'undefined' && caches.default;

    if (cache) {
        try {
            const cached = await cache.match(cacheKey);
            if (cached) return cached;
        } catch { /* cache miss or unavailable */ }
    }

    const response = await handleVfsProxy(request, env);

    // Cache successful responses at the edge
    if (cache && (response.status === 200 || response.status === 206)) {
        const cloned = response.clone();
        const cachedResponse = new Response(cloned.body, {
            status: cloned.status,
            headers: new Headers(cloned.headers),
        });
        cachedResponse.headers.set('Cache-Control', `public, max-age=${EDGE_CACHE_TTL}, s-maxage=${EDGE_CACHE_TTL}`);
        // Non-blocking put
        cache.put(cacheKey, cachedResponse).catch(() => {});
    }

    return response;
}
