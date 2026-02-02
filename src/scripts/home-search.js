// src/scripts/home-search.js
// V16.2: Refactored for Zero-Runtime compliance and MiniSearch integration
import MiniSearch from 'minisearch';
import { DataNormalizer } from './lib/DataNormalizer.js';
import { R2_CACHE_URL } from '../config/constants.ts';

// Config & Constants
const CORE_INDEX_URL = `${R2_CACHE_URL}/cache/search-core.json`;
const FULL_INDEX_URL = `${R2_CACHE_URL}/cache/search-full.json`;
const HISTORY_KEY = 'f2ai_search_history';
const MAX_HISTORY = 5;

// Engine Instance
let searchIndex = null;
let searchData = [];
let isLoaded = false;
let isLoading = false;
let isFullSearchActive = false;
let isFullSearchLoading = false;

// Initialize Search Engine
export async function initSearch() {
    if (isLoaded || isLoading) return;
    isLoading = true;

    try {
        console.log('📥 [V16.2] Loading Core Search Index...');
        const res = await fetch(CORE_INDEX_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        // Support both { entities: [] } and raw array formats
        const rawData = data.entities || data.models || data;
        searchData = DataNormalizer.normalizeCollection(rawData, 'model');

        searchIndex = new MiniSearch({
            fields: ['name', 'author', 'description', 'tags'],
            storeFields: ['id', 'name', 'type', 'fni_score', 'slug', 'author', 'description'],
            idField: 'id',
            searchOptions: {
                boost: { name: 3, author: 1.5 },
                fuzzy: 0.2,
                prefix: true
            }
        });

        searchIndex.addAll(searchData);
        isLoaded = true;
        console.log(`🚀 [V16.2] Search Ready: ${searchData.length} items`);
    } catch (e) {
        console.error('❌ [V16.2] Search Init Failed:', e);
    } finally {
        isLoading = false;
    }
}

// Lazy Load Full Index (V16.2.3 Sharded Implementation)
export async function loadFullSearchIndex(onProgress) {
    if (isFullSearchActive || isFullSearchLoading || !isLoaded) return;
    isFullSearchLoading = true;

    try {
        console.log('📥 [V16.2.3] Loading Search Manifest...');
        const manifestRes = await fetch(`${R2_CACHE_URL}/cache/search-manifest.json`);
        if (!manifestRes.ok) throw new Error('Manifest load failed');

        const manifest = await manifestRes.json();
        const totalShards = manifest.totalShards;
        console.log(`📦 [Search] Loading ${totalShards} shards for ${manifest.totalEntities} entities...`);

        // Use a Set to handle potential dupes between core and shards
        const fullEntitiesMap = new Map();
        // Seed with core data
        searchData.forEach(e => fullEntitiesMap.set(e.id, e));

        const shardUrls = Array.from({ length: totalShards }, (_, i) => `${R2_CACHE_URL}/cache/search/shard-${i}.json`);

        // Load shards in batches of 5 to avoid browser request limits
        const BATCH_SIZE = 5;
        let loadedShards = 0;

        for (let i = 0; i < shardUrls.length; i += BATCH_SIZE) {
            const batch = shardUrls.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (url) => {
                const res = await fetch(url);
                if (!res.ok) return null;
                return res.json();
            }));

            for (const shard of results) {
                if (shard?.entities) {
                    shard.entities.forEach(e => {
                        if (!fullEntitiesMap.has(e.id)) {
                            fullEntitiesMap.set(e.id, {
                                i: e.id,
                                n: e.name,
                                type: e.type,
                                a: e.author,
                                sc: e.fni,
                                d: e.description,
                                s: e.slug
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

        const fullEntities = Array.from(fullEntitiesMap.values());

        // Update MiniSearch
        console.log('🔄 Rebuilding Search Index...');
        searchIndex.removeAll();
        searchIndex.addAll(fullEntities.map(e => ({
            id: e.i,
            name: e.n,
            type: e.type,
            author: e.a,
            description: e.d,
            fni_score: e.sc,
            slug: e.s
        })));

        searchData = fullEntities;
        isFullSearchActive = true;
        console.log(`🔥 [V16.2.3] Full Search Ready: ${fullEntities.length} entities`);
        return true;
    } catch (e) {
        console.error('❌ [V16.2.3] Sharded Index Load Failed:', e);
        // Fallback to legacy full index if manifest fails
    } catch (f) {
        console.error('[Search] All index fallbacks failed. Memory safety maintained.');
    }
    return false;
} finally {
    isFullSearchLoading = false;
}
}

export function getSearchHistory() {
    try {
        return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch { return []; }
}

export function saveSearchHistory(query) {
    if (!query || query.length < 2) return;
    const history = getSearchHistory().filter(h => h !== query);
    history.unshift(query);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

export function clearSearchHistory() {
    localStorage.removeItem(HISTORY_KEY);
}

export function getTopModels(limit = 10) {
    if (!isLoaded) return [];
    return searchData
        .slice(0, limit)
        .map(r => ({
            id: r.i, name: r.n, slug: r.s, author: r.a, fni_score: r.sc
        }));
}

export function performSearch(query, limit = 20) {
    if (!searchIndex || !query || query.length < 2) return [];

    const results = searchIndex.search(query);

    return results.slice(0, limit).map(r => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        type: r.type || 'model',
        author: r.author,
        fni_score: r.fni_score,
        score: r.score
    }));
}

export function setFullSearchActive(active) {
    isFullSearchActive = active;
}

export function getSearchStatus() {
    return {
        isLoaded,
        isFullSearchActive,
        isFullSearchLoading,
        itemCount: searchData.length
    };
}
