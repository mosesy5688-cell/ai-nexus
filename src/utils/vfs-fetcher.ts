import { R2_CACHE_URL } from '../config/constants.js';

/**
 * V19.4 VFS Entity Fetcher
 * Optimized for Binary Sharding (Range Requests)
 */

export async function fetchEntityFromVfs(id: string, locals: any = null) {
    // V19.4: In production, we'd query the SQLite content.db.
    // However, for single entity detail pages, we often have the metadata inlined or 
    // we can use a "Manifest Map" for fast sharding hits.

    // For now, we prioritize the "Parallel Race" logic in packet-loader.ts.
    // The VFS Ignition mainly focuses on:
    // 1. SEARCH: FTS5 query against content.db (handled by Search API)
    // 2. RANGE: Fetching README/Mesh from Binary Bundles.

    return null; // Logic is currently integrated into packet-loader.ts race
}

// Isomorphic L0 Cache
const L0_CACHE = new Map<string, any>();
const L0_ETAGS = new Map<string, string>(); // V22.10.1: Native ETag Tracking
const MAX_L0 = 50;

async function getL1Cache() {
    if (typeof caches === 'undefined') return null;
    try {
        // @ts-ignore
        if (caches.default) return caches.default; // Cloudflare Workers
        return await caches.open('vfs-range-l1'); // Browser
    } catch {
        return null;
    }
}

// V25.1: Zero-Handshake — Atomic Purge guarantees freshness, no HEAD needed
async function resolveEtag(filename: string, _targetUrl: string): Promise<string> {
    if (L0_ETAGS.has(filename)) return L0_ETAGS.get(filename)!;
    // Trust deployment pipeline: purge_everything + proactive warming = consistent data
    const etag = 'v25-trust';
    L0_ETAGS.set(filename, etag);
    return etag;
}

export async function fetchBundleRange(bundleKey: string, offset: number, size: number, locals: any = null) {
    const isSimulatingRemote = !!(typeof process !== 'undefined' && process.env.SIMULATE_PRODUCTION);
    const filename = bundleKey.split('/').pop() || 'unknown';

    const targetUrl = isSimulatingRemote
        ? `${R2_CACHE_URL}/data/${filename}`
        : `/api/vfs-proxy/${filename}`;

    // 1. Resolve Strict ETag Version
    const fileEtag = await resolveEtag(filename, targetUrl);

    // 2. Isolate Caches by ETag Version
    const cacheKey = `${fileEtag}-${filename}-${offset}-${size}`;
    const syntheticUrl = `https://vfs-frontend.internal/${fileEtag}/${filename}/range/${offset}-${size}`;

    // L0 Cache Check
    if (L0_CACHE.has(cacheKey)) {
        return L0_CACHE.get(cacheKey);
    }

    try {
        // L1 Cache Check
        const cache = await getL1Cache();
        if (cache) {
            const cachedRes = await cache.match(syntheticUrl);
            if (cachedRes) {
                const data = await cachedRes.json();
                L0_CACHE.set(cacheKey, data);
                return data;
            }
        }

        const response = await fetch(targetUrl, {
            headers: {
                'Range': `bytes=${offset}-${offset + size - 1}`
            }
        });

        if (!response.ok) throw new Error(`VFS Proxy Error: ${response.status}`);

        const buffer = await response.arrayBuffer();
        const data = JSON.parse(new TextDecoder().decode(buffer));

        // Save L0
        L0_CACHE.set(cacheKey, data);
        if (L0_CACHE.size > MAX_L0) {
            const firstKey = L0_CACHE.keys().next().value;
            if (firstKey) L0_CACHE.delete(firstKey);
        }

        // Save L1
        if (cache) {
            const cacheRes = new Response(JSON.stringify(data), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=31536000' }
            });
            // @ts-ignore
            cache.put(syntheticUrl, cacheRes).catch(() => { });
        }

        return data;
    } catch (e: any) {
        console.error(`[VFS-Fetcher] Failed to fetch bundle range:`, e.message || e);
        return null;
    }
}
