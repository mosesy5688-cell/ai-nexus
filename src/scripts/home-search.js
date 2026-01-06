// src/scripts/home-search.js
// V14.5: Search functionality extracted from HomeSearch.astro for CES compliance

const INDEX_URL = '/data/search-index-top.json';
const FULL_INDEX_URL = '/api/cache/search-full.json'; // V14.5 Phase 5

let searchData = [];
let fullSearchData = null;
let isLoaded = false;
let isLoading = false;
let isFullSearchEnabled = false;
let isFullSearchLoading = false;

const HISTORY_KEY = 'f2ai_search_history';
const MAX_HISTORY = 5;

export async function initSearch() {
    if (isLoaded || isLoading) return;
    isLoading = true;
    console.log('📥 [V14.2] Loading static search index...');

    try {
        const response = await fetch(INDEX_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        searchData = await response.json();
        isLoaded = true;
        console.log(`🚀 [V14.2] Search Ready: ${searchData.length} items`);
    } catch (e) {
        console.error('❌ Search index failed:', e);
    } finally {
        isLoading = false;
    }
}

export async function loadFullSearchIndex() {
    if (fullSearchData || isFullSearchLoading) return fullSearchData;

    const statusEl = document.getElementById('fullSearchStatus');
    if (statusEl) statusEl.textContent = '(loading...)';
    isFullSearchLoading = true;

    try {
        console.log('📥 [V14.5] Loading full search index (100K+)...');
        const response = await fetch(FULL_INDEX_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        fullSearchData = data.entities || data;
        console.log(`🚀 [V14.5] Full Search Ready: ${fullSearchData.length} items`);
        if (statusEl) statusEl.textContent = `(✓ ${fullSearchData.length.toLocaleString()})`;
    } catch (e) {
        console.error('❌ Full search index failed:', e);
        if (statusEl) statusEl.textContent = '(failed)';
    } finally {
        isFullSearchLoading = false;
    }
    return fullSearchData;
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
    const dataSource = (isFullSearchEnabled && fullSearchData) ? fullSearchData : searchData;
    if (!dataSource.length || !query) return [];

    if (query.length === 1 && !isFullSearchEnabled) {
        return getTopModels(limit);
    }

    const q = query.toLowerCase();
    const fuzzy = (t, s) => t && (t.toLowerCase().includes(s) ||
        t.toLowerCase().split(/[\s\-_]/).some(w => w.startsWith(s.slice(0, 3))));
    const score = (i) => (fuzzy(i.n, q) ? 50 : 0) + (i.n?.toLowerCase().startsWith(q) ? 30 : 0) +
        (fuzzy(i.t, q) ? 20 : 0) + (fuzzy(i.a, q) ? 10 : 0) + (i.n?.toLowerCase() === q ? 100 : 0) + (i.sc || 0) / 10;

    return dataSource
        .map(item => ({ item, s: score(item) }))
        .filter(({ s }) => s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(({ item }) => ({
            id: item.i, name: item.n, slug: item.s, author: item.a, fni_score: item.sc
        }));
}

export function setFullSearchEnabled(enabled) {
    isFullSearchEnabled = enabled;
}

export function isFullSearchActive() {
    return isFullSearchEnabled && fullSearchData;
}
