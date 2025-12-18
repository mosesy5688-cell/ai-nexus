import Fuse from 'https://cdn.jsdelivr.net/npm/fuse.js@7.1.0/dist/fuse.mjs';

let fuse = null;
let items = [];
let isLoaded = false;
let loadError = null;

// Configuration - V5.2.1: Use R2 API proxy
const HOT_INDEX_URL = '/api/cache/trending.json';

// Initialize Index
async function loadIndex() {
    try {
        const response = await fetch(HOT_INDEX_URL);
        if (!response.ok) throw new Error(`Failed to load index: ${response.status}`);

        const data = await response.json();
        items = data.models || data || [];

        // Initialize Fuse
        fuse = new Fuse(items, {
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

        isLoaded = true;
        console.log(`[SearchWorker] Index loaded: ${items.length} items`);
    } catch (e) {
        console.error('[SearchWorker] Load error:', e);
        loadError = e.message;
    }
}

// Start loading immediately
loadIndex();

self.onmessage = async (e) => {
    const { id, type, filters } = e.data;

    // Handle "PING" or status checks
    if (type === 'STATUS') {
        self.postMessage({ id, type: 'STATUS', isLoaded, loadError, count: items.length });
        return;
    }

    if (type === 'SEARCH') {
        if (!isLoaded) {
            // Check errors or wait
            if (loadError) {
                self.postMessage({ id, type: 'ERROR', error: loadError });
                return;
            }
            // If just loading, maybe return empty with "loading" status? 
            // Current client waits for "RESULT" type.
            // We'll return empty for now to avoid hanging.
            self.postMessage({ id, type: 'RESULT', results: [], total: 0, page: 1, total_pages: 0 });
            return;
        }

        const start = performance.now();
        let results = items;

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
        const pagedResults = results.slice((page - 1) * limit, page * limit);

        const duration = performance.now() - start;

        self.postMessage({
            id,
            type: 'RESULT',
            results: pagedResults,
            total: results.length,
            duration
        });
    }
};
