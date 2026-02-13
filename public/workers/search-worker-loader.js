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

/**
 * Robust JSON fetcher with .gz fallback
 */
async function tryFetchJson(url) {
    const gzUrl = url.endsWith('.gz') ? url : url + '.gz';
    let response = await fetch(gzUrl);

    // V16.5.9 FIX: Fallback to uncompressed if .gz is missing
    // Even if input url had .gz, try removing it.
    if (!response.ok) {
        // If we tried GZ and it failed, try the plain version
        const plainUrl = url.endsWith('.gz') ? url.slice(0, -3) : url;
        // Only fetch if it's different from what we arguably just tried (gzUrl)
        if (plainUrl !== gzUrl) {
            const resp2 = await fetch(plainUrl);
            if (resp2.ok) response = resp2;
        }
    }

    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

    // V18.2: Handle Gzip decompression in Worker/Browser environment
    // Only decompress manually if the browser didn't do it transparently
    const isAlreadyDecompressed = response.headers.get('Content-Encoding') === 'gzip' || response.headers.get('content-encoding') === 'gzip';

    if ((response.url.endsWith('.gz') || url.endsWith('.gz')) && !isAlreadyDecompressed) {
        // V16.5.7 FIX: Use ArrayBuffer to avoid "body stream already read" lock
        try {
            const buffer = await response.arrayBuffer();
            const ds = new DecompressionStream('gzip');
            const writer = ds.writable.getWriter();
            writer.write(buffer);
            writer.close();
            const output = new Response(ds.readable);
            return await output.json();
        } catch (e) {
            // If manual decompression fails, it might be auto-decompressed transparently
            // in which case response.arrayBuffer() consumed the body, so we need a fresh fetch?
            // Actually, if arrayBuffer() succeeds, we have the data.
            // If decompression fails, it might be plain JSON.
            // Let's re-parse the buffer as text.
            try {
                const text = new TextDecoder().decode(await response.clone().arrayBuffer()); // Wait, response is consumed.
                // We need to store buffer first.
                return JSON.parse(new TextDecoder().decode(buffer));
            } catch (e2) {
                // Final fallback: Re-fetch non-gz
                return await (await fetch(url)).json();
            }
        }
    }
    return await response.json();
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
        const items = (data.entities || data.models || data.spaces || data.datasets || data || []).map((item, idx) => ({
            ...item,
            id: item.id || `auto-${idx}`,
            fni_score: item.fni_score ?? item.fni ?? item.fniScore ?? 0,
            fni_percentile: item.fni_percentile || item.percentile || ''
        }));

        const miniSearch = new MiniSearch({
            fields: ['name', 'author', 'tags', 'description', 'slug'],
            storeFields: ['name', 'author', 'tags', 'description', 'id', 'slug', 'likes', 'downloads', 'last_updated', 'fni_score', 'pwc_benchmarks', 'verified', 'type'],
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
        const manifest = await tryFetchJson('https://cdn.free2aitools.com/cache/search-manifest.json');
        const totalShards = manifest.totalShards;
        const itemsMap = new Map();

        if (indexCache['model']) {
            indexCache['model'].items.forEach(e => itemsMap.set(e.id, e));
        }

        const ext = manifest.extension || (manifest.totalShards > 0 ? '.gz' : '.json');
        // V16.5.8 FIX: manifest.extension already includes dot (e.g. ".gz")
        // Don't append it again!
        const shardUrls = Array.from({ length: totalShards }, (_, i) => `https://cdn.free2aitools.com/cache/search/shard-${i}.json${ext}`);
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
                                id: e.id, name: e.name, type: e.type, author: e.author,
                                fni_score: e.fni ?? e.fni_score ?? 0,
                                fni_percentile: e.percentile ?? e.fni_percentile ?? '',
                                description: e.description, slug: e.slug
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
