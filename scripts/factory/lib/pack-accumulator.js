/**
 * V25.9 Pack Accumulator — SQLite-backed O(1) Memory Entity Store
 *
 * Replaces the monolithic JS array pattern in collectAndSortMetadata.
 * Entities are streamed into a temporary SQLite DB, sorted via index,
 * and iterated with O(1) memory via cursor-based generators.
 *
 * Memory footprint: ~50MB (SQLite page cache) vs ~2.5GB (413k JS objects).
 */

import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';

export class PackAccumulator {
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.db = null;
        this._count = 0;
    }

    async init() {
        await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
        const existing = await fs.stat(this.dbPath).catch(() => null);
        if (existing) await fs.unlink(this.dbPath);

        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = OFF');
        this.db.pragma('synchronous = OFF');
        this.db.pragma('page_size = 16384');

        this.db.exec(`
            CREATE TABLE entities (
                id TEXT PRIMARY KEY,
                data TEXT,
                fni_score REAL DEFAULT 0,
                trending_rank INTEGER DEFAULT 999999,
                is_trending INTEGER DEFAULT 0,
                name TEXT DEFAULT '',
                icon TEXT DEFAULT ''
            );
            CREATE INDEX idx_pack_fni ON entities(fni_score DESC, trending_rank ASC, id ASC);
        `);

        this._insertStmt = this.db.prepare(`
            INSERT OR REPLACE INTO entities (id, data, fni_score, trending_rank, is_trending, name, icon)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
    }

    beginTransaction() { this.db.exec('BEGIN TRANSACTION'); }

    commitTransaction() {
        this.db.exec('COMMIT');
        this._count = this.db.prepare('SELECT count(*) as c FROM entities').get().c;
    }

    /**
     * Ingest a single entity with trending/trend context baked in.
     * Entity is stored as full JSON blob; hot fields extracted for indexing.
     */
    ingest(entity, trendingInfo, trendValue) {
        const id = entity.id || entity.slug;
        if (!id) return;

        entity._trending_rank = trendingInfo.rank;
        entity.is_trending = trendingInfo.is_trending;
        entity._trend_7d = trendValue;

        this._insertStmt.run(
            id,
            JSON.stringify(entity),
            entity.fni_score ?? entity.fni ?? 0,
            trendingInfo.rank,
            trendingInfo.is_trending ? 1 : 0,
            entity.name || entity.displayName || id,
            entity.icon || ''
        );
    }

    get count() { return this._count; }

    /**
     * Iterate ALL entities sorted by fni_score DESC (streaming, O(1) memory).
     * Each call yields a fresh parsed entity — caller owns the object lifecycle.
     */
    *iterate() {
        const stmt = this.db.prepare(
            'SELECT data FROM entities ORDER BY fni_score DESC, trending_rank ASC, id ASC'
        );
        for (const row of stmt.iterate()) {
            yield JSON.parse(row.data);
        }
    }

    /**
     * Materialize top K entities as an array (for hot-shard/vector-core).
     * Safe: 30k entities ≈ 45MB — well within V8 comfort zone.
     */
    getTopK(k) {
        const stmt = this.db.prepare(
            'SELECT data FROM entities ORDER BY fni_score DESC, trending_rank ASC, id ASC LIMIT ?'
        );
        return stmt.all(k).map(r => JSON.parse(r.data));
    }

    /**
     * Build entity lookup map for the V25.1 Distiller's mesh pre-joining.
     * Returns Map<id, {name, icon}> — ~40MB for 413k entities.
     */
    getEntityLookup() {
        const lookup = new Map();
        const stmt = this.db.prepare('SELECT id, name, icon FROM entities');
        for (const row of stmt.iterate()) {
            lookup.set(row.id, { name: row.name || row.id, icon: row.icon || '📦' });
        }
        return lookup;
    }

    /** Close DB and delete temp file. */
    async close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        await fs.unlink(this.dbPath).catch(() => {});
    }
}
