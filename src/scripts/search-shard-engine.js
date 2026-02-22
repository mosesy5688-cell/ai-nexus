// src/scripts/search-shard-engine.js
// V21.14: Shard-based Search Engine (Legacy/Fallback Engine)
// Handles Hot-Shard (Top 5000) and Lazy-loading of full registry shards.

let hotResults = [];
let isHotLoaded = false;
let fallBackResults = [];
let isFallingBack = false;
let totalShards = 0;
let shardsLoaded = 0;

const CDN_BASE = 'https://cdn.free2aitools.com';

/**
 * Instant Hot-Shard Loader
 * Fetches the Top 5000 entities (search-core.json.gz) for 0ms responsiveness.
 */
export async function loadHotShard() {
    if (isHotLoaded) return;
    const paths = [
        `${CDN_BASE}/cache/search-core.json.gz`,
        `${CDN_BASE}/cache/search/shard-0.json.gz`,
        '/cache/search-core.json.gz'
    ];

    try {
        let data = null;
        for (const path of paths) {
            try {
                const res = await fetch(path);
                if (!res.ok) continue;

                if (path.endsWith('.gz')) {
                    const ds = new DecompressionStream('gzip');
                    const decompressedRes = new Response(res.body.pipeThrough(ds));
                    data = await decompressedRes.json();
                } else {
                    data = await res.json();
                }
                if (data) {
                    console.log(`[HotEngine] Successfully loaded from ${path}`);
                    break;
                }
            } catch (e) {
                console.warn(`[HotEngine] Failed to load ${path}:`, e.message);
            }
        }

        const entities = data?.entities || data || [];
        hotResults = entities.map(e => ({
            id: e.id,
            name: e.name,
            slug: e.slug,
            type: e.type,
            author: e.author,
            description: e.description || e.summary,
            fni_score: e.fni_score || e.fni_p || 0,
            likes: e.stars || 0,
            downloads: e.downloads || 0,
            tags: e.tags || [],
            last_updated: e.last_updated
        }));

        isHotLoaded = true;
        console.log(`[HotEngine] Ready. Hydrated ${hotResults.length} entities.`);
    } catch (err) {
        console.error('[HotEngine] Initialization failed:', err);
    }
}

/**
 * Shard-based Lazy Loading Fallback
 */
export async function loadFullSearchIndex(onProgress, isVfsLoaded) {
    if (isVfsLoaded() || isFallingBack) return true;

    isFallingBack = true;
    try {
        const manifestRes = await fetch(`${CDN_BASE}/cache/search-manifest.json`);
        if (!manifestRes.ok) throw new Error('Manifest missing');
        const manifest = await manifestRes.json();
        totalShards = manifest.totalShards;

        for (let i = 0; i < totalShards; i++) {
            if (isVfsLoaded()) break;

            const shardPath = `${CDN_BASE}/cache/search/shard-${i}.json.gz`;
            try {
                const res = await fetch(shardPath);
                if (!res.ok) continue;

                const ds = new DecompressionStream('gzip');
                const decompressedRes = new Response(res.body.pipeThrough(ds));
                const shard = await decompressedRes.json();

                const mapped = (shard.entities || shard || []).map(e => ({
                    id: e.id,
                    name: e.name,
                    slug: e.slug,
                    type: e.type,
                    author: e.author,
                    description: e.description || e.summary,
                    fni_score: e.fni_score || e.fni_p || 0,
                    likes: e.stars || 0,
                    downloads: e.downloads || 0,
                    tags: e.tags || [],
                    last_updated: e.last_updated
                }));

                const existingIds = new Set(hotResults.map(h => h.id));
                const unique = mapped.filter(m => !existingIds.has(m.id));

                fallBackResults = [...fallBackResults, ...unique];
                shardsLoaded++;

                if (onProgress) {
                    onProgress({
                        progress: Math.round((shardsLoaded / totalShards) * 100),
                        loaded: fallBackResults.length + hotResults.length
                    });
                }
            } catch (err) {
                console.warn(`[SearchFallback] Shard ${i} load failed:`, err);
            }
        }
        return true;
    } catch (e) {
        console.error('[SearchFallback] Failed to load shards:', e);
        isFallingBack = false;
        return false;
    }
}

/**
 * Local Filter Logic for Shard Results
 */
export function searchShardPool(query, limit, filters) {
    const pool = [...hotResults, ...fallBackResults];
    let filtered = pool;

    if (query && query.length >= 2) {
        const q = query.toLowerCase();
        filtered = filtered.filter(e =>
            e.name?.toLowerCase().includes(q) ||
            e.id?.toLowerCase().includes(q) ||
            e.author?.toLowerCase().includes(q) ||
            e.description?.toLowerCase().includes(q)
        );
    }

    if (filters.entityType && filters.entityType !== 'all') {
        filtered = filtered.filter(e => e.type === filters.entityType);
    }

    if (filters.sort === 'likes') {
        filtered.sort((a, b) => b.likes - a.likes);
    } else if (filters.sort === 'last_updated') {
        filtered.sort((a, b) => new Date(b.last_updated) - new Date(a.last_updated));
    } else {
        filtered.sort((a, b) => b.fni_score - a.fni_score);
    }

    return filtered.slice(0, limit);
}

export function getShardStatus() {
    return {
        isHotLoaded,
        isFallingBack,
        shardsProgress: shardsLoaded && totalShards ? Math.round((shardsLoaded / totalShards) * 100) : 0,
        itemCount: hotResults.length + fallBackResults.length
    };
}
