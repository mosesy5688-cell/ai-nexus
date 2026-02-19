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

export async function fetchBundleRange(bundleKey: string, offset: number, size: number, locals: any = null) {
    const env = locals?.runtime?.env;
    const filename = bundleKey.split('/').pop();
    const proxyUrl = `/api/vfs-proxy/${filename}`;

    try {
        const response = await fetch(proxyUrl, {
            headers: {
                'Range': `bytes=${offset}-${offset + size - 1}`
            }
        });

        if (!response.ok) throw new Error(`VFS Proxy Error: ${response.status}`);

        const buffer = await response.arrayBuffer();
        return JSON.parse(new TextDecoder().decode(buffer));
    } catch (e: any) {
        console.error(`[VFS-Fetcher] Failed to fetch bundle range:`, e.message || e);
        return null;
    }
}
