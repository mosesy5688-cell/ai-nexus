// public/workers/search-worker.js
import MiniSearch from 'https://cdn.jsdelivr.net/npm/minisearch@7.1.1/dist/es/index.js';
import {
    indexCache,
    currentEntityType,
    isLoaded,
    loadError,
    isFullSearchActive,
    loadIndex,
    loadFullIndex
} from './search-worker-loader.js?v=18.10.7';

// SPEC-SEARCH-V18.2: Immediate status ping capability
console.log('[SearchWorker] Bootstrapping v16.8.15-R5.6');

loadIndex('model').then(() => {
    console.log('[SearchWorker] Core index ready.');
    self.postMessage({ type: 'STATUS', isLoaded: true, count: indexCache['model']?.items?.length || 0 });
}).catch(err => {
    console.error('[SearchWorker] Initial load failed:', err);
    self.postMessage({ type: 'STATUS', isLoaded: false, loadError: err.message, count: 0 });
});

self.onmessage = async (e) => {
    const { id, type, filters } = e.data;

    // Ping for heartbeat
    if (type === 'ping') {
        self.postMessage({ type: 'pong' });
        return;
    }

    if (type === 'LOAD_FULL') {
        try {
            await loadFullIndex((p) => {
                self.postMessage({ id, type: 'PROGRESS', ...p });
            });
            self.postMessage({ id, type: 'READY', source: 'full' });
        } catch (err) {
            self.postMessage({ id, type: 'ERROR', error: err.message });
        }
        return;
    }

    if (type === 'STATUS') {
        const cache = indexCache[currentEntityType] || {};
        self.postMessage({ id, type: 'STATUS', isLoaded, isFullSearchActive, loadError, count: cache.items?.length || 0 });
        return;
    }

    if (type === 'SEARCH') {
        const entityType = filters.entityType || 'model';
        const useFull = (filters.useFull || isFullSearchActive) && entityType === 'model';

        let cache = useFull ? indexCache['model_full'] : indexCache[entityType];
        if (!cache) cache = await loadIndex(entityType);

        if (!cache) {
            self.postMessage({ id, type: 'RESULT', results: [], total: 0 });
            return;
        }

        const { items, miniSearch } = cache;
        const start = performance.now();
        let results = [];

        // 1. Full Text Search
        if (filters.q && miniSearch) {
            results = miniSearch.search(filters.q);
        } else {
            results = items;
        }

        // 2. Apply Filters (Preserve SPEC-ID-V2.0 Compliance)
        if (filters.min_likes > 0) {
            results = results.filter(i => (i.likes || 0) >= filters.min_likes);
        }

        if (filters.has_benchmarks) {
            results = results.filter(i => i.pwc_benchmarks && i.pwc_benchmarks.length > 2);
        }

        if (filters.sources && filters.sources.length > 0) {
            results = results.filter(i => {
                const sid = i.id || '';
                return filters.sources.some(src => sid.startsWith(src + ':') || sid.startsWith(src + '--'));
            });
        }

        if (filters.days_ago > 0) {
            const now = Date.now();
            const msAgo = filters.days_ago * 24 * 60 * 60 * 1000;
            results = results.filter(i => {
                if (!i.last_updated) return false;
                const date = new Date(i.last_updated).getTime();
                return (now - date) <= msAgo;
            });
        }

        if (filters.license) {
            const lowLic = filters.license.toLowerCase();
            results = results.filter(i => {
                const tags = Array.isArray(i.tags) ? i.tags : [];
                return tags.some(t => {
                    const lowT = t.toLowerCase();
                    return lowT.includes('license:' + lowLic) || lowT === lowLic;
                });
            });
        }

        if (filters.tags && filters.tags.length > 0) {
            results = results.filter(i => {
                const itemTags = Array.isArray(i.tags) ? i.tags : [];
                return filters.tags.every(t => itemTags.includes(t));
            });
        }

        // 3. Sort
        if (filters.sort) {
            results.sort((a, b) => {
                const map = {
                    'likes': (i) => i.likes || 0,
                    'downloads': (i) => i.downloads || 0,
                    'last_updated': (i) => new Date(i.last_updated || 0).getTime(),
                    'fni': (i) => i.fni_score ?? i.fni ?? 0
                };
                const getter = map[filters.sort] || map['likes'];
                return getter(b) - getter(a);
            });
        }

        // 4. Limit/Pagination
        const limit = parseInt(filters.limit) || 50;
        const page = parseInt(filters.page) || 1;
        const pagedResults = results.slice((page - 1) * limit, page * limit);

        const duration = performance.now() - start;

        self.postMessage({
            id,
            type: 'RESULT',
            results: pagedResults,
            total: results.length,
            duration,
            source: results.length > 0 ? (results.some(r => r._source === 'd1') ? 'mixed' : 'local') : 'none'
        });
    }
};
