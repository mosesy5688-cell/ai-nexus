import { DataNormalizer } from './DataNormalizer.js';
import { SqliteClient } from './SqliteClient.js';

const CDN_BASE = 'https://cdn.free2aitools.com';

export class CatalogDataSource {
    constructor(config) {
        this.type = config.type || 'model';
        this.categoryFilter = config.categoryFilter || '';
        this.items = DataNormalizer.normalizeCollection(config.initialData || [], this.type);
        this.itemsPerPage = config.itemsPerPage || 48;
        this.isLoading = false;
        this.fullDataLoaded = false;
        this.dbClient = new SqliteClient();

        // V23.6: Multi-shard state
        this.shardQueue = [];
        this.shardIndex = 0;
        this.shardOffset = 0;
        this._manifestLoaded = false;
        this._manifestData = null;
    }

    async _loadManifest() {
        if (this._manifestLoaded) return;
        try {
            const res = await fetch(`${CDN_BASE}/data/shards_manifest.json`, {
                signal: AbortSignal.timeout(20000) // V25.1: Safety guardrail — 103 Early Hints targets <500ms; 20s prevents false "0 entities" on extreme network jitter
            });
            if (res.ok) {
                this._manifestData = await res.json();
                // V25.1: Persist partitions to localStorage — future fallbacks use last known good values
                try { localStorage.setItem('_vfs_partitions', JSON.stringify(this._manifestData.partitions)); } catch (_) { }
            }
        } catch (e) {
            console.warn('[CatalogDataSource] Manifest fetch failed, using persisted/default partitions');
        }
        this._buildShardQueue();
        this._manifestLoaded = true;
    }

    _buildShardQueue() {
        // V25.1: Dynamic partition resolution — manifest → localStorage → hardcoded safety net
        let partitions = this._manifestData?.partitions;
        if (!partitions) {
            try { partitions = JSON.parse(localStorage.getItem('_vfs_partitions') || ''); } catch (_) { }
        }
        const p = partitions || { model: 3, paper: 15, dataset: 8, tool: 2, agent: 1, space: 1, prompt: 1 };
        const fmt = (cat, idx, count) =>
            count === 1 ? `meta-${cat}.db` : `meta-${cat}-shard-${String(idx).padStart(2, '0')}.db`;

        const type = this.type;

        if (this.categoryFilter || type === 'all') {
            // Cross-type: model-core first, then all other shards
            this.shardQueue = ['meta-model-core.db'];
            for (const [cat, count] of Object.entries(p)) {
                if (cat === 'model') {
                    for (let i = 1; i <= count; i++) this.shardQueue.push(`meta-model-shard-${String(i).padStart(2, '0')}.db`);
                } else {
                    for (let i = 1; i <= count; i++) this.shardQueue.push(fmt(cat, i, count));
                }
            }
        } else if (type === 'model') {
            this.shardQueue = ['meta-model-core.db'];
            const mc = p.model || 5;
            for (let i = 1; i <= mc; i++) this.shardQueue.push(`meta-model-shard-${String(i).padStart(2, '0')}.db`);
        } else {
            const count = p[type] || 1;
            this.shardQueue = [];
            for (let i = 1; i <= count; i++) this.shardQueue.push(fmt(type, i, count));
        }
        console.log(`[CatalogDataSource] Shard queue (${type}): ${this.shardQueue.length} shards`);
    }

    _buildSql() {
        if (this.categoryFilter) {
            return {
                sql: 'SELECT * FROM entities WHERE category = ? ORDER BY fni_score DESC LIMIT ? OFFSET ?',
                params: [this.categoryFilter, this.itemsPerPage, this.shardOffset]
            };
        }
        if (this.type === 'all') {
            return {
                sql: 'SELECT * FROM entities ORDER BY fni_score DESC LIMIT ? OFFSET ?',
                params: [this.itemsPerPage, this.shardOffset]
            };
        }
        return {
            sql: 'SELECT * FROM entities WHERE type = ? ORDER BY fni_score DESC LIMIT ? OFFSET ?',
            params: [this.type, this.itemsPerPage, this.shardOffset]
        };
    }

    async loadNextPage() {
        if (this.isLoading || this.fullDataLoaded) return null;
        this.isLoading = true;

        try {
            await this._loadManifest();

            if (this.shardIndex >= this.shardQueue.length) {
                this.fullDataLoaded = true;
                return [];
            }

            const dbName = this.shardQueue[this.shardIndex];
            await this.dbClient.open(dbName);

            const { sql, params } = this._buildSql();
            const rows = await this.dbClient.query(sql, params);

            if (rows.length === 0) {
                // Shard exhausted — advance to next
                this.shardIndex++;
                this.shardOffset = 0;
                if (this.shardIndex >= this.shardQueue.length) {
                    this.fullDataLoaded = true;
                    return [];
                }
                this.isLoading = false;
                return this.loadNextPage();
            }

            this.shardOffset += rows.length;
            const normalized = DataNormalizer.normalizeCollection(rows, this.type === 'all' ? undefined : this.type);

            // Deduplicate
            const existingIds = new Set(this.items.map(i => i.id));
            const fresh = normalized.filter(i => !existingIds.has(i.id));
            this.items = [...this.items, ...fresh];
            return fresh;
        } catch (e) {
            console.error(`[CatalogDataSource] Shard ${this.shardQueue[this.shardIndex]} error:`, e.message);
            this.shardIndex++;
            this.shardOffset = 0;
            if (this.shardIndex >= this.shardQueue.length) this.fullDataLoaded = true;
            return null;
        } finally {
            this.isLoading = false;
        }
    }

    async search(query, category) {
        const q = (query || '').toLowerCase().trim();
        const cat = category || '';
        let localResults = [...this.items];
        if (cat) localResults = localResults.filter(i => i.category === cat || i.pipeline_tag === cat);
        const filtered = q ? localResults.filter(i =>
            i.name?.toLowerCase().includes(q) || i.author?.toLowerCase().includes(q) || i.id?.toLowerCase().includes(q)
        ) : localResults;

        if (q.length < 3) return filtered.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));

        // Federated SSR search
        try {
            const params = new URLSearchParams({ q, type: this.type, sort: 'fni', limit: '50', page: '1' });
            const res = await fetch(`/api/search?${params}`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const data = await res.json();
                if (data.results?.length > 0) return DataNormalizer.normalizeCollection(data.results, this.type);
            }
        } catch (e) { console.warn('[CatalogDataSource] API search fallback:', e); }

        // Local FTS5 fallback
        try {
            const safeQuery = q.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(t => t.length > 0).map(t => `"${t}"*`).join(' AND ');
            if (!safeQuery) return filtered;
            const sql = `SELECT e.* FROM search s JOIN entities e ON s.rowid = e.rowid WHERE search MATCH ? AND e.type = ? ORDER BY e.fni_score DESC LIMIT 50`;
            const rows = await this.dbClient.query(sql, [safeQuery, this.type]);
            return DataNormalizer.normalizeCollection(rows, this.type);
        } catch (e) { return filtered; }
    }

    // Compat methods for UniversalCatalog / CatalogUIControls
    async loadNextShard() { return this.loadNextPage(); }
    async augmentSearch() { return this.loadNextPage(); }
    get isLoadingShard() { return this.isLoading; }
}
