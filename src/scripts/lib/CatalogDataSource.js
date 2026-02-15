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
            storeFields: ['id', 'name', 'type', 'fni_score', 'slug', 'description', 'author'],
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
            // V16.5: SSOT Tier 2 - /lists/{type}/page-{n}.json
            // V18.2: Support compressed shards (.gz) with local decompression
            const paths = [
                `https://cdn.free2aitools.com/cache/lists/${this.type}/page-${this.currentShard}.json.gz`,
                `https://cdn.free2aitools.com/cache/rankings/${this.type}/p${this.currentShard}.json`
            ];
            let res = null;
            let data = null;

            for (const p of paths) {
                const response = await fetch(p);
                if (response.ok) {
                    const isGzip = p.endsWith('.gz');
                    const isAlreadyDecompressed = response.headers.get('Content-Encoding') === 'gzip';

                    if (isGzip && !isAlreadyDecompressed) {
                        try {
                            const ds = new DecompressionStream('gzip');
                            const decompressedStream = response.body.pipeThrough(ds);
                            const decompressedRes = new Response(decompressedStream);
                            data = await decompressedRes.json();
                            res = response;
                            break;
                        } catch (e) {
                            console.warn(`[CatalogDataSource] Decompression failed for ${p}:`, e);
                        }
                    } else {
                        data = await response.json();
                        res = response;
                        break;
                    }
                }
            }

            if (!res || !data) throw new Error(`Fetch failed for all paths`);

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
            // V18.2: Support compressed search shards
            const paths = ['https://cdn.free2aitools.com/cache/search/shard-0.json.gz', 'https://cdn.free2aitools.com/cache/search/shard-0.json'];
            let data = null;

            for (const p of paths) {
                const response = await fetch(p);
                if (response.ok) {
                    const isGzip = p.endsWith('.gz');
                    const isAlreadyDecompressed = response.headers.get('Content-Encoding') === 'gzip';

                    if (isGzip && !isAlreadyDecompressed) {
                        try {
                            const ds = new DecompressionStream('gzip');
                            const decompressedStream = response.body.pipeThrough(ds);
                            const decompressedRes = new Response(decompressedStream);
                            data = await decompressedRes.json();
                            break;
                        } catch (e) { }
                    } else {
                        data = await response.json();
                        break;
                    }
                }
            }
            if (!data) return;

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
