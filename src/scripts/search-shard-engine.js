import { VfsDecoder } from '../lib/vfs-decoder.ts';

let hotResults = [];
let vfsDecoder = null;
let isHotLoaded = false;
let fallBackResults = [];
let isFallingBack = false;
let totalShards = 0;
let shardsLoaded = 0;

const CDN_BASE = 'https://cdn.free2aitools.com';
const ENTITY_TYPES = ['model', 'dataset', 'agent', 'tool', 'space', 'paper', 'prompt'];

/**
 * V22.9: Zero-Copy Binary Hot-Shard Loader
 * Fetches the Top 50,000 entities via hot-shard.bin for 0ms responsiveness.
 */
export async function loadHotShard() {
    if (isHotLoaded) return;

    // Priority 1: Zero-Copy Binary (hot-shard.bin)
    const binaryPaths = [
        '/api/vfs-proxy/data/hot-shard.bin',
        `${CDN_BASE}/data/hot-shard.bin`
    ];

    for (const path of binaryPaths) {
        try {
            const res = await fetch(path);
            if (!res.ok) continue;

            const buffer = await res.arrayBuffer();
            vfsDecoder = new VfsDecoder(buffer);
            console.log(`[HotEngine] 🔥 Zero-Copy Binary Loaded: ${vfsDecoder.getCount()} entities.`);
            isHotLoaded = true;
            return;
        } catch (e) {
            console.warn(`[HotEngine] Binary load failed for ${path}:`, e.message);
        }
    }

    // Priority 2: Legacy JSON Fallback (search-core.json)
    const jsonPaths = [
        '/api/vfs-proxy/cache/search-core.json.gz',
        `${CDN_BASE}/cache/search-core.json.gz`
    ];

    for (const path of jsonPaths) {
        try {
            const res = await fetch(path);
            if (!res.ok) continue;

            let data;
            const ds = new DecompressionStream('gzip');
            const decompressedRes = new Response(res.body.pipeThrough(ds));
            try {
                data = await decompressedRes.json();
            } catch {
                data = await (await fetch(path)).json();
            }

            const entities = data?.entities || data || [];
            hotResults = entities.map(e => ({
                id: e.slug || e.id,
                name: e.name || e.displayName,
                slug: e.slug || e.id,
                type: e.type,
                fni_score: e.fni_score || 0,
                downloads: e.downloads || 0,
                stars: e.stars || 0
            }));

            isHotLoaded = true;
            console.log(`[HotEngine] 💾 Legacy JSON Loaded: ${hotResults.length} entities.`);
            return;
        } catch (e) {
            console.warn(`[HotEngine] JSON load failed for ${path}:`, e.message);
        }
    }
}

/**
 * Optimized Search Pool: Combines Binary VFS and Legacy Shards
 */
export function searchShardPool(query, limit, filters) {
    const results = [];
    const q = query?.toLowerCase() || '';

    // 1. Search Binary VFS (Top 50K)
    if (vfsDecoder) {
        const vfsCount = vfsDecoder.getCount();
        for (let i = 0; i < vfsCount; i++) {
            const rec = vfsDecoder.getRecord(i);

            // Filter by Type
            if (filters.entityType && filters.entityType !== 'all') {
                const typeName = ENTITY_TYPES[rec.type];
                if (typeName !== filters.entityType) continue;
            }

            // Fuzzy Match
            if (!q || rec.name.toLowerCase().includes(q) || rec.slug.toLowerCase().includes(q)) {
                results.push({
                    id: rec.slug,
                    name: rec.name,
                    slug: rec.slug,
                    type: ENTITY_TYPES[rec.type],
                    fni_score: rec.fniScore,
                    downloads: rec.downloads,
                    stars: rec.stars,
                    params_billions: rec.paramsBil,
                    is_trending: rec.isTrending
                });
            }
            if (results.length >= limit) break;
        }
    }

    // 2. Search Legacy JSON Pool (if loaded)
    if (results.length < limit) {
        const legacyPool = [...hotResults, ...fallBackResults];
        for (const e of legacyPool) {
            if (results.length >= limit) break;
            if (vfsDecoder && results.some(r => r.id === (e.slug || e.id))) continue;

            if (filters.entityType && filters.entityType !== 'all' && e.type !== filters.entityType) continue;

            if (!q || e.name?.toLowerCase().includes(q) || e.slug?.toLowerCase().includes(q)) {
                results.push(e);
            }
        }
    }

    // Sort Results
    if (filters.sort === 'likes' || filters.sort === 'stars') {
        results.sort((a, b) => (b.stars || b.likes || 0) - (a.stars || a.likes || 0));
    } else if (filters.sort === 'downloads') {
        results.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    } else {
        results.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));
    }

    return results.slice(0, limit);
}

export function getShardStatus() {
    return {
        isHotLoaded,
        isFallingBack,
        isVfsBinary: !!vfsDecoder,
        itemCount: (vfsDecoder ? vfsDecoder.getCount() : hotResults.length) + fallBackResults.length
    };
}

/**
 * Legacy Shard Loader (Optional)
 */
export async function loadFullSearchIndex(onProgress, isVfsLoaded) {
    if (isVfsLoaded() || isFallingBack) return true;
    // ... existing logic for deep shards if needed ...
    return true;
}
