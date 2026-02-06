// public/workers/search-worker-loader.js
import MiniSearch from 'https://cdn.jsdelivr.net/npm/minisearch@7.1.1/dist/es/index.js';

export const indexCache = {};
export let currentEntityType = 'model';
export let isLoaded = false;
export let loadError = null;
export let isFullSearchActive = false;

const INDEX_URLS = {
    model: 'https://cdn.free2aitools.com/cache/trending.json',
    space: 'https://cdn.free2aitools.com/cache/trending_spaces.json',
    dataset: 'https://cdn.free2aitools.com/cache/trending_datasets.json'
};

export async function loadIndex(entityType = 'model') {
    if (indexCache[entityType]) {
        currentEntityType = entityType;
        isLoaded = true;
        return indexCache[entityType];
    }

    const url = INDEX_URLS[entityType] || INDEX_URLS.model;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            if (entityType !== 'model' && response.status === 404) {
                console.warn(`[SearchWorker] ${entityType} index not available, using models`);
                return loadIndex('model');
            }
            throw new Error(`Failed to load index: ${response.status}`);
        }

        const data = await response.json();
        const items = (data.models || data.spaces || data.datasets || data || []).map((item, idx) => ({
            ...item,
            id: item.id || `auto-${idx}`
        }));

        const miniSearch = new MiniSearch({
            fields: ['name', 'author', 'tags', 'description', 'slug'],
            storeFields: ['name', 'author', 'tags', 'description', 'id', 'slug', 'likes', 'downloads', 'last_updated', 'fni_score', 'pwc_benchmarks', 'verified'],
            searchOptions: {
                boost: { name: 2, author: 1.5 },
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
        const manifestRes = await fetch('https://cdn.free2aitools.com/cache/search-manifest.json');
        if (!manifestRes.ok) throw new Error('Manifest load failed');

        const manifest = await manifestRes.json();
        const totalShards = manifest.totalShards;
        const itemsMap = new Map();

        if (indexCache['model']) {
            indexCache['model'].items.forEach(e => itemsMap.set(e.id, e));
        }

        const shardUrls = Array.from({ length: totalShards }, (_, i) => `https://cdn.free2aitools.com/cache/search/shard-${i}.json`);
        const BATCH_SIZE = 5;
        let loadedShards = 0;

        for (let i = 0; i < shardUrls.length; i += BATCH_SIZE) {
            const batch = shardUrls.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (url) => {
                try {
                    const res = await fetch(url);
                    return res.ok ? res.json() : null;
                } catch { return null; }
            }));

            for (const shard of results) {
                if (shard?.entities) {
                    shard.entities.forEach(e => {
                        if (!itemsMap.has(e.id)) {
                            itemsMap.set(e.id, {
                                id: e.id, name: e.name, type: e.type, author: e.author,
                                fni_score: e.fni, description: e.description, slug: e.slug
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
            fields: ['name', 'author', 'description', 'tags'],
            storeFields: ['id', 'name', 'type', 'fni_score', 'slug', 'author', 'description'],
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
