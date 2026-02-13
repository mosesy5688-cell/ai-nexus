// src/scripts/home-search.js
// V16.6: Unified Search Orchestrator (Worker Proxy)
// Offloads heavy indexing and search to Background Worker for Zero-UI-Lag performance.

// Worker Instance (Single source of truth for search)
let searchWorker = null;
if (typeof window !== 'undefined') {
    searchWorker = new Worker('/workers/search-worker.js?v=16.5.13', { type: 'module' });
}

let isLoaded = false;
let isLoading = false;
let isFullSearchActive = false;
let isFullSearchLoading = false;
let itemCount = 0;
let pendingProgressCall = null;

// Initialize Search Engine (Check Worker Status)
export async function initSearch() {
    if (isLoaded || !searchWorker) return true;
    if (isLoading) return new Promise(resolve => {
        const interval = setInterval(() => {
            if (isLoaded) { clearInterval(interval); resolve(true); }
        }, 100);
    });

    isLoading = true;
    return new Promise((resolve) => {
        const requestId = 'init-' + Date.now();
        const handler = (e) => {
            if (e.data.type === 'STATUS') {
                searchWorker.removeEventListener('message', handler);
                isLoaded = e.data.isLoaded;
                isFullSearchActive = e.data.isFullSearchActive;
                itemCount = e.data.count;
                isLoading = false;
                resolve(true);
            }
        };
        searchWorker.addEventListener('message', handler);
        searchWorker.postMessage({ id: requestId, type: 'STATUS' });
    });
}

// Lazy Load Full Index via Worker (Background Sharding)
export async function loadFullSearchIndex(onProgress) {
    if (isFullSearchActive || isFullSearchLoading || !searchWorker) return true;

    isFullSearchLoading = true;
    pendingProgressCall = onProgress;

    return new Promise((resolve) => {
        const requestId = 'load-full-' + Date.now();
        const handler = (e) => {
            if (e.data.id === requestId) {
                if (e.data.type === 'PROGRESS' && pendingProgressCall) {
                    pendingProgressCall(e.data);
                } else if (e.data.type === 'READY') {
                    searchWorker.removeEventListener('message', handler);
                    isFullSearchActive = true;
                    isFullSearchLoading = false;
                    resolve(true);
                } else if (e.data.type === 'ERROR') {
                    searchWorker.removeEventListener('message', handler);
                    isFullSearchLoading = false;
                    console.error('[HomeSearch] Full index load error:', e.data.error);
                    resolve(false);
                }
            }
        };
        searchWorker.addEventListener('message', handler);
        searchWorker.postMessage({ id: requestId, type: 'LOAD_FULL' });
    });
}

// Perform Search via Worker (Async API)
export async function performSearch(query, limit = 20, filters = {}) {
    if (!searchWorker || !query || query.length < 2) return [];

    return new Promise((resolve) => {
        const requestId = 'search-' + Date.now();
        const handler = (e) => {
            if (e.data.id === requestId && e.data.type === 'RESULT') {
                searchWorker.removeEventListener('message', handler);
                resolve(e.data.results || []);
            }
        };
        searchWorker.addEventListener('message', handler);
        searchWorker.postMessage({
            id: requestId,
            type: 'SEARCH',
            filters: {
                q: query,
                limit,
                useFull: isFullSearchActive,
                ...filters
            }
        });
    });
}

// History Utils (Main Thread Storage - remains same)
const HISTORY_KEY = 'f2ai_search_history';
const MAX_HISTORY = 5;

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

export function setFullSearchActive(active) {
    isFullSearchActive = active;
}

export function getSearchStatus() {
    return {
        isLoaded,
        isFullSearchActive,
        isFullSearchLoading,
        itemCount
    };
}
