// public/workers/search-worker-loader.js
import MiniSearch from 'https://cdn.jsdelivr.net/npm/minisearch@7.1.1/dist/es/index.js';

export const indexCache = {};
export let currentEntityType = 'model';
export let isLoaded = false;
export let loadError = null;
export let isFullSearchActive = false;

// SPEC-SEARCH-V18.2: Absolute CDN Pathing (Transparent .gz Fallback)
const CDN_URL = 'https://cdn.free2aitools.com';
const INDEX_URLS = {
    model: `${CDN_URL}/cache/search-core.json.gz`,
    space: `${CDN_URL}/cache/search-core.json.gz`,
    dataset: `${CDN_URL}/cache/search-core.json.gz`
};

/**
 * V18.2 Hybrid Fetcher: Handles GZIP streams with buffer fallback
 */
async function tryFetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status} (${url})`);

    // V18.10.7: ArrayBuffer-First Strategy to avoid Chrome Worker stream lock
    const buffer = await response.arrayBuffer();
    const isGzip = url.endsWith('.gz');

    // Check if browser already decompressed it (Content-Encoding: gzip)
    const isAlreadyDecompressed = response.headers.get('Content-Encoding') === 'gzip' || response.headers.get('content-encoding') === 'gzip';

    if (isGzip && !isAlreadyDecompressed) {
        try {
            const ds = new DecompressionStream('gzip');
            const stream = new Response(buffer).body.pipeThrough(ds);
            return await new Response(stream).json();
        } catch (e) {
            console.warn('[SearchWorker] Stream decompression failed, falling back to TextDecoder:', e);
            try {
                const text = new TextDecoder().decode(buffer);
                return JSON.parse(text);
            } catch (e2) {
                throw new Error('Critical: Search index decompression failure.');
            }
        }
    }

    const text = new TextDecoder().decode(buffer);
    return JSON.parse(text);
}

export async function loadIndex(entityType = 'model') {
    if (indexCache[entityType]) {
        currentEntityType = entityType;
        isLoaded = true;
        return indexCache[entityType];
    }

    const url = INDEX_URLS[entityType] || INDEX_URLS.model;
    try {
        const data = await tryFetchJson(url);
        const items = (data.entities || data.models || data.spaces || data.datasets || data || []).map((item, idx) => {
            // SPEC-V18.2 Alignment: Map abbreviated fields (t, n, o, d, s)
            return {
                ...item,
                id: item.id || `auto-${idx}`,
                name: item.n || item.name || item.title || 'Unknown',
                author: item.o || item.author || item.owner || 'Open Source',
                type: item.t || item.type || entityType,
                description: item.d || item.description || '',
                fni_score: item.s ?? item.fni_score ?? item.fni ?? 0,
                fni_percentile: item.p || item.fni_percentile || '',
                slug: item.slug || item.id?.split(/[:/]/).pop() || ''
            };
        });

        const miniSearch = new MiniSearch({
            fields: ['name', 'author', 'tags', 'description', 'slug'],
            storeFields: ['name', 'author', 'tags', 'description', 'id', 'slug', 'likes', 'downloads', 'last_updated', 'fni_score', 'verified', 'type'],
            searchOptions: {
                boost: { name: 10, author: 5, description: 1 },
                fuzzy: 0.2,
                prefix: true
            }
        });

        miniSearch.addAll(items);
        indexCache[entityType] = { items, miniSearch };
        currentEntityType = entityType;
        isLoaded = true;
        return indexCache[entityType];
    } catch (e) {
        console.error('[SearchWorker] Load error:', e);
        loadError = e.message;
        return null;
    }
}

export async function loadFullIndex(onProgress) {
    if (isFullSearchActive) return;

    try {
        const manifest = await tryFetchJson(`${CDN_URL}/cache/search-manifest.json`);
        const totalShards = manifest.totalShards;
        const itemsMap = new Map();

        if (indexCache['model']) {
            indexCache['model'].items.forEach(e => itemsMap.set(e.id, e));
        }

        const extension = manifest.extension || '';
        const shardUrls = Array.from({ length: totalShards }, (_, i) => {
            // V18.12.5: Resilient Shard Pathing (handles shard-N.json.gz)
            return `${CDN_URL}/cache/search/shard-${i}.json${extension}`;
        });

        const BATCH_SIZE = 5;
        let loadedShards = 0;

        for (let i = 0; i < shardUrls.length; i += BATCH_SIZE) {
            const batch = shardUrls.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (url) => {
                try {
                    return await tryFetchJson(url);
                } catch { return null; }
            }));

            for (const shard of results) {
                if (shard?.entities) {
                    shard.entities.forEach(e => {
                        if (!itemsMap.has(e.id)) {
                            itemsMap.set(e.id, {
                                id: e.id,
                                name: e.n || e.name || e.title || e.id,
                                type: e.t || e.type || 'model',
                                author: e.o || e.author || e.owner || 'Open Source',
                                fni_score: Math.round(e.s ?? e.fni ?? 0),
                                fni_percentile: e.p ?? e.percentile ?? '',
                                description: e.d || e.description || '',
                                slug: e.slug || e.id?.split(/[:/]/).pop() || '',
                                tags: Array.isArray(e.tags) ? e.tags : []
                            });
                        }
                    });
                }
            }

            loadedShards += results.filter(Boolean).length;
            if (onProgress) {
                onProgress({
                    percent: Math.round((loadedShards / totalShards) * 100),
                    loaded: loadedShards,
                    total: totalShards
                });
            }
        }

        const fullItems = Array.from(itemsMap.values());
        const miniSearch = new MiniSearch({
            fields: ['name', 'author', 'description', 'tags', 'slug'],
            storeFields: ['id', 'name', 'type', 'fni_score', 'fni_percentile', 'slug', 'author', 'description', 'tags'],
            searchOptions: { boost: { name: 3, author: 1.5 }, fuzzy: 0.2, prefix: true }
        });

        miniSearch.addAll(fullItems);
        indexCache['model_full'] = { items: fullItems, miniSearch };
        isFullSearchActive = true;
    } catch (e) {
        console.error('[SearchWorker] Full index error:', e);
        throw e;
    }
}
