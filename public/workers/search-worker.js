import Fuse from 'https://cdn.jsdelivr.net/npm/fuse.js@7.1.0/dist/fuse.mjs';

// V6.2: Support multiple entity type indexes
const indexCache = {};
let currentEntityType = 'model';
let isLoaded = false;
let loadError = null;

// Configuration - V6.2: Entity-specific endpoints
const INDEX_URLS = {
    model: '/api/cache/trending.json',
    space: '/api/cache/trending_spaces.json',
    dataset: '/api/cache/trending_datasets.json'
};

// Initialize Index for a specific entity type
async function loadIndex(entityType = 'model') {
    // Check cache first
    if (indexCache[entityType]) {
        currentEntityType = entityType;
        isLoaded = true;
        return indexCache[entityType];
    }

    const url = INDEX_URLS[entityType] || INDEX_URLS.model;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            // If spaces/datasets not available yet, silently use models
            if (entityType !== 'model' && response.status === 404) {
                console.warn(`[SearchWorker] ${entityType} index not available, using models`);
                return loadIndex('model');
            }
            throw new Error(`Failed to load index: ${response.status}`);
        }

        const data = await response.json();
        const items = data.models || data.spaces || data.datasets || data || [];

        // Initialize Fuse for this entity type
        const fuse = new Fuse(items, {
            keys: [
                { name: 'name', weight: 0.4 },
                { name: 'author', weight: 0.2 },
                { name: 'tags', weight: 0.2 },
                { name: 'description', weight: 0.1 },
                { name: 'slug', weight: 0.1 }
            ],
            threshold: 0.3,
            ignoreLocation: true,
            useExtendedSearch: true
        });

        indexCache[entityType] = { items, fuse };
        currentEntityType = entityType;
        isLoaded = true;
        console.log(`[SearchWorker] ${entityType} index loaded: ${items.length} items`);
        return indexCache[entityType];
    } catch (e) {
        console.error('[SearchWorker] Load error:', e);
        loadError = e.message;
        return null;
    }
}

// Start loading models immediately and notify when ready
loadIndex('model').then(() => {
    self.postMessage({ type: 'STATUS', isLoaded: true, count: indexCache['model']?.items?.length || 0 });
});

self.onmessage = async (e) => {
    const { id, type, filters } = e.data;

    // Handle "PING" or status checks
    if (type === 'STATUS') {
        const cache = indexCache[currentEntityType] || {};
        self.postMessage({ id, type: 'STATUS', isLoaded, loadError, count: cache.items?.length || 0 });
        return;
    }

    if (type === 'SEARCH') {
        // V6.2: Load index for requested entity type
        const entityType = filters.entityType || 'model';
        const cache = await loadIndex(entityType);

        if (!cache) {
            if (loadError) {
                self.postMessage({ id, type: 'ERROR', error: loadError });
            } else {
                self.postMessage({ id, type: 'RESULT', results: [], total: 0, page: 1, total_pages: 0 });
            }
            return;
        }

        const { items, fuse } = cache;
        const start = performance.now();
        let results = [...items];

        // 1. Full Text Search via Fuse
        if (filters.q && fuse) {
            const fuseResults = fuse.search(filters.q);
            results = fuseResults.map(r => r.item);
        }

        // 2. Apply Filters (Client-Side)
        if (filters.min_likes > 0) {
            results = results.filter(i => (i.likes || 0) >= filters.min_likes);
        }

        if (filters.has_benchmarks) {
            // Check for pwc_benchmarks (stringified JSON or object) or simple existence
            results = results.filter(i => i.pwc_benchmarks && i.pwc_benchmarks.length > 2);
        }

        if (filters.sources && filters.sources.length > 0) {
            results = results.filter(i => {
                const id = i.id || '';
                return filters.sources.some(src => id.startsWith(src + ':') || id.startsWith(src + '--'));
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
            results = results.filter(i => {
                const tags = i.tags || [];
                // Licenses often formatted as "license:mit" or just "mit" in tags
                // We look for partial match or exact match depending on data quality
                return tags.some(t => t.toLowerCase().includes('license:' + filters.license) || t.toLowerCase() === filters.license);
            });
        }

        if (filters.tags && filters.tags.length > 0) {
            results = results.filter(i => {
                const itemTags = i.tags || [];
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
                    'fni': (i) => i.fni_score || 0
                };
                const getter = map[filters.sort] || map['likes'];
                return getter(b) - getter(a);
            });
        }

        // 4. Limit/Pagination
        const limit = parseInt(filters.limit) || 50;
        const page = parseInt(filters.page) || 1;

        // 5. Fallback to D1 FTS if local results are sparse or query is specific (B.17)
        if (results.length < 5 && filters.q && filters.q.length > 2) {
            console.log(`[SearchWorker] Sparse local results (${results.length}), trying D1 FTS fallback...`);
            const d1Results = await fallbackToD1(filters.q, limit);
            if (d1Results && d1Results.length > 0) {
                // Merge or replace? For sparse results, replace is often better/cleaner
                // But merging deduplicated results is safest
                const localIds = new Set(results.map(r => r.id));
                const uniqueD1 = d1Results.filter(r => !localIds.has(r.id));
                results = [...results, ...uniqueD1];
            }
        }

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

/**
 * Fallback to server-side D1 FTS5 search (B.17)
 */
async function fallbackToD1(query, limit) {
    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
        if (!response.ok) return null;
        const data = await response.json();
        // Mark results for UI tracking if needed
        return (data.results || []).map(r => ({ ...r, _source: 'd1' }));
    } catch (e) {
        console.error('[SearchWorker] D1 Fallback failed:', e);
        return null;
    }
}
