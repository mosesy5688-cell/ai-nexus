// src/scripts/home-search.js
// V16.2: Refactored for Zero-Runtime compliance and MiniSearch integration
import MiniSearch from 'minisearch';

// Config & Constants
const CORE_INDEX_URL = '/cache/search-core.json';
const FULL_INDEX_URL = '/cache/search-full.json';
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
        searchData = data.entities || data.models || data;

        searchIndex = new MiniSearch({
            fields: ['name', 'author', 'description', 'tags'],
            storeFields: ['id', 'name', 'type', 'fni_score', 'slug'],
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

// Lazy Load Full Index
export async function loadFullSearchIndex() {
    if (isFullSearchActive || isFullSearchLoading || !isLoaded) return;
    isFullSearchLoading = true;

    try {
        console.log('📥 [V16.2] Loading Full Index (30MB+)...');
        const res = await fetch(FULL_INDEX_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        const fullEntities = data.entities || data.models || data;

        // Clear and reload MiniSearch with full data
        searchIndex.removeAll();
        searchIndex.addAll(fullEntities);

        isFullSearchActive = true;
        console.log(`🔥 [V16.2] Full Search Activated: ${fullEntities.length} entities`);
        return true;
    } catch (e) {
        console.error('❌ [V16.2] Full Index Load Failed:', e);
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

export function performSearch(query, limit = 8) {
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
