/**
 * VFS Cache Utilities for Cloudflare Workers
 * 
 * Handles L1 Edge Caching for R2 VFS chunks (256KB).
 * Leverages ETag isolation to prevent cross-version DB corruption.
 */

// We use a high TTL (1 year) because the Key incorporates the ETag,
// making the chunks mathematically immutable.
const CF_CACHE_TTL = 31536000;

/**
 * Validates and retrieves the ETag-versioned chunk from Cloudflare Edge Cache.
 * 
 * @param etag The specific DB version string to ensure immutable isolation.
 */
export async function getChunkFromCacheAPI(chunkIndex: number, etag: string): Promise<Uint8Array | null> {
    // @ts-ignore - Cloudflare Workers extends CacheStorage with .default
    if (typeof caches === 'undefined' || !caches.default) return null;
    if (!etag) return null; // Safety fallback

    try {
        const cacheKey = new Request(`https://vfs-cache.internal/${etag}/chunk/${chunkIndex}`);
        // @ts-ignore
        const response = await caches.default.match(cacheKey);
        if (response) {
            return new Uint8Array(await response.arrayBuffer());
        }
    } catch (e) {
        console.warn('[R2 VFS Cache] CF Cache match error:', e);
    }
    return null;
}

/**
 * Asynchronously stores a fetched chunk into Cloudflare Edge Cache.
 * 
 * @param etag The specific DB version string to ensure immutable isolation.
 */
export async function putChunkToCacheAPI(chunkIndex: number, data: Uint8Array, etag: string) {
    // @ts-ignore
    if (typeof caches === 'undefined' || !caches.default) return;
    if (!etag) return; // Safety fallback

    try {
        const cacheKey = new Request(`https://vfs-cache.internal/${etag}/chunk/${chunkIndex}`);
        // @ts-ignore - TS DOM types don't like Uint8Array directly here sometimes
        const response = new Response(data as any, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Cache-Control': `public, max-age=${CF_CACHE_TTL}`
            }
        });

        // caches.default.put is async, don't await to avoid blocking current query latency
        // @ts-ignore
        caches.default.put(cacheKey, response).catch((e: any) => console.warn('[R2 VFS Cache] CF Cache put error (async):', e));
    } catch (e: any) {
        console.warn('[R2 VFS Cache] CF Cache wrapper error:', e);
    }
}
