// public/workers/search-worker-loader.js
import MiniSearch from 'https://cdn.jsdelivr.net/npm/minisearch@7.1.1/dist/es/index.js';

export const indexCache = {};
export let currentEntityType = 'model';
export let isLoaded = false;
export let loadError = null;
export let isFullSearchActive = false;

const INDEX_URLS = {
    model: 'https://cdn.free2aitools.com/cache/search-core.json.gz',
    space: 'https://cdn.free2aitools.com/cache/search-core.json.gz',
    dataset: 'https://cdn.free2aitools.com/cache/search-core.json.gz'
};

/**
 * Robust JSON fetcher with .gz fallback
 */
async function tryFetchJson(url) {
    const gzUrl = url.endsWith('.gz') ? url : url + '.gz';
    let response = await fetch(gzUrl);

    // V16.6 Optimization: Prefer .gz but fallback to plain if needed
    if (!response.ok) {
        const plainUrl = url.endsWith('.gz') ? url.slice(0, -3) : url;
        if (plainUrl !== gzUrl) {
            response = await fetch(plainUrl);
        }
    }

    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

    // V18.2: Handle Gzip decompression in Worker/Browser environment
    // Only decompress manually if the browser didn't do it transparently
    const isAlreadyDecompressed = response.headers.get('Content-Encoding') === 'gzip' || response.headers.get('content-encoding') === 'gzip';

    if ((response.url.endsWith('.gz') || url.endsWith('.gz')) && !isAlreadyDecompressed) {
        // V16.5.14 FIX: buffer scope must be outside try/catch to be used in fallback
        let buffer;
        try {
            buffer = await response.arrayBuffer();
            const ds = new DecompressionStream('gzip');
            const writer = ds.writable.getWriter();
            writer.write(buffer);
            writer.close();
            const output = new Response(ds.readable);
            return await output.json();
        } catch (e) {
            // Buffer fallback safe now
            try {
                if (buffer) {
                    return JSON.parse(new TextDecoder().decode(buffer));
                }
                throw new Error('Buffer empty');
            } catch (e2) {
                // Final fallback: Re-fetch non-gz (network request)
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
        // V16.6.2 FIX: shards are already named with .json, manifest.extension might be .gz
        // Correct construction: name + ext (if ext is .json) OR name + .json + ext (if ext is .gz)
        const shardUrls = Array.from({ length: totalShards }, (_, i) => {
            const base = `https://cdn.free2aitools.com/cache/search/shard-${i}`;
            return ext === '.json' ? `${base}.json` : `${base}.json${ext}`;
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
                            // V16.7.1 FIX: Include tags for 100% keyword coverage
                            // Also ensure consistent naming (fni_score, fni_percentile)
                            itemsMap.set(e.id, {
                                id: e.id,
                                name: e.name || e.id,
                                type: e.type || 'model',
                                author: e.author || 'Open Source',
                                fni_score: Math.round(e.fni ?? e.fni_score ?? e.fniScore ?? 0),
                                fni_percentile: e.percentile ?? e.fni_percentile ?? e.fniPercentile ?? '',
                                description: e.description || '',
                                slug: e.slug || e.id?.split(/[:/]/).pop(),
                                tags: Array.isArray(e.tags) ? e.tags : (typeof e.tags === 'string' ? JSON.parse(e.tags || '[]') : [])
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
