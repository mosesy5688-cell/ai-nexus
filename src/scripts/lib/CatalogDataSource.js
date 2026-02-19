/**
 * CatalogDataSource.js (V16.9.10)
 * Logic for Shard Chaining and Search Engine Augmentation
 * Constitution: Split for < 250 line compliance
 */
import MiniSearch from 'minisearch';
import { DataNormalizer } from './DataNormalizer.js';

export class CatalogDataSource {
    constructor(config) {
        this.type = config.type;
        this.dataUrl = config.dataUrl;
        this.items = DataNormalizer.normalizeCollection(config.initialData || [], config.type);
        this.currentShard = 0;
        this.totalPages = 1;
        this.totalEntities = 0;
        this.isLoadingShard = false;
        this.fullDataLoaded = false;

        this.engine = new MiniSearch({
            fields: ['name', 'author', 'description', 'tags'],
            storeFields: [
                'id', 'name', 'type', 'fni_score', 'fni_percentile',
                // V19.5 Data Parity: FNI Sub-scores
                'fni_p', 'fni_v', 'fni_c', 'fni_u',
                // V19.5 Data Parity: Technical Params
                'params_billions', 'context_length', 'architecture',
                'slug', 'description', 'author'
            ],
            idField: 'id',
            searchOptions: {
                boost: { name: 3, author: 1.5 },
                fuzzy: 0.2,
                prefix: true
            }
        });

        if (this.items.length > 0) {
            this.engine.addAll(this.items);
        }
    }

    async loadNextShard(direction = 1) {
        if (this.isLoadingShard || this.currentShard >= this.totalPages) return null;
        this.isLoadingShard = true;

        try {
            this.currentShard += direction;
            // V18.7: Persist page state to URL for deep-linking
            if (typeof window !== 'undefined') {
                const url = new URL(window.location.href);
                url.searchParams.set('page', String(this.currentShard));
                window.history.replaceState({ page: this.currentShard }, '', url);
            }
            // V18.12.0: Optimized resilient fetch logic
            const paths = [
                `https://cdn.free2aitools.com/cache/rankings/${this.type}/p${this.currentShard}.json`,
                `https://cdn.free2aitools.com/cache/lists/${this.type}/page-${this.currentShard}.json`
            ];

            let data = null;
            let successPath = null;

            for (const p of paths) {
                try {
                    // Try .json.gz first (Production Standard)
                    let response = await fetch(p + '.gz');
                    if (!response.ok) response = await fetch(p);

                    if (response.ok) {
                        const isGzip = response.url.endsWith('.gz');
                        const isEnc = response.headers.get('Content-Encoding') === 'gzip' || response.headers.get('content-encoding') === 'gzip';

                        if (isGzip && !isEnc) {
                            const ds = new DecompressionStream('gzip');
                            const decompressedStream = response.body.pipeThrough(ds);
                            data = await new Response(decompressedStream).json();
                        } else {
                            data = await response.json();
                        }
                        successPath = response.url;
                        break;
                    }
                } catch (e) { continue; }
            }

            if (!data) throw new Error(`Fetch failed for all candidates`);

            if (this.currentShard === 1) {
                this.totalPages = data.totalPages || 1;
                this.totalEntities = data.totalEntities || data.total_items || 0;
            }

            let allRaw = Array.isArray(data) ? data : (data.entities || data.models || data.items || []);
            const validItems = DataNormalizer.normalizeCollection(allRaw, this.type)
                .filter(i => i.type === this.type || (this.type === 'model' && !i.type));

            const map = new Map();
            this.items.forEach(i => map.set(i.id, i));
            validItems.forEach(i => {
                if (!map.has(i.id)) {
                    map.set(i.id, i);
                    this.engine.add(i);
                }
            });

            this.items = Array.from(map.values());
            return validItems;
        } catch (e) {
            console.error(`[CatalogDataSource] Shard ${this.currentShard} Load Failed:`, e);
            this.fullDataLoaded = true;
            return null;
        } finally {
            this.isLoadingShard = false;
        }
    }

    async augmentSearch() {
        try {
            // V18.12.0: Resilient fallback for search augmentation
            const path = 'https://cdn.free2aitools.com/cache/search-core.json';
            let resp = await fetch(path + '.gz');
            if (!resp.ok) resp = await fetch(path);

            if (!resp.ok) return [];

            let data;
            const isGz = resp.url.endsWith('.gz');
            const isEnc = resp.headers.get('Content-Encoding') === 'gzip' || resp.headers.get('content-encoding') === 'gzip';

            if (isGz && !isEnc) {
                try {
                    const resClone = resp.clone();
                    const ds = new DecompressionStream('gzip');
                    data = await new Response(resClone.body.pipeThrough(ds)).json();
                } catch (decompressError) {
                    console.warn(`[CatalogDataSource] AugmentSearch Gzip failed, falling back to plain JSON.`);
                    data = await resp.json();
                }
            } else {
                data = await resp.json();
            }

            const coreEntities = (data.entities || []).filter(e => e.type === this.type || (this.type === 'model' && (!e.type || e.type === 'model')));
            const normalized = DataNormalizer.normalizeCollection(coreEntities, this.type);

            this.engine.addAll(normalized.filter(i => !this.engine.get(i.id)));
            return normalized;
        } catch (e) {
            console.warn('[CatalogDataSource] Search augmentation failed:', e);
            return [];
        }
    }

    search(query, category) {
        const q = (query || '').trim();
        const cat = category || '';

        let results = [...this.items];
        if (cat && cat !== '') {
            results = results.filter(i => i.category === cat);
        }

        if (q && q.length >= 2) {
            const searchResults = this.engine.search(q);
            const searchIds = new Set(searchResults.map(r => r.id));
            results = results.filter(i => searchIds.has(i.id));

            const scoreMap = new Map(searchResults.map(r => [r.id, r.score]));
            results.sort((a, b) => (scoreMap.get(b.id) || 0) - (scoreMap.get(a.id) || 0));
        }

        return results.map(r => ({ ...r, fni_score: r.fni_score ?? r.fni ?? 0 }));
    }
}
