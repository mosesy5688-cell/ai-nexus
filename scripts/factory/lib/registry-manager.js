import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { loadRegistryShardsSequentially } from './registry-loader.js';
import { saveRegistryShard } from './registry-saver.js';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { mergeEntities } from '../../ingestion/lib/entity-merger.js';
import { SHARD_SIZE } from './registry-utils.js';

export class RegistryManager {
    constructor() {
        this.accumulatorPath = './cache/accumulator.db';
        this.db = null;
        this.count = 0;
        this.didLoadFromStorage = false;
    }

    /**
     * Initialize temporary SQLite accumulator
     * Allows O(1) memory merging of 1M+ entities.
     */
    async initAccumulator() {
        console.log('[REGISTRY] Initializing SQLite Accumulator...');
        await fs.mkdir(path.dirname(this.accumulatorPath), { recursive: true });
        if (await fs.stat(this.accumulatorPath).catch(() => null)) {
            await fs.unlink(this.accumulatorPath);
        }
        this.db = new Database(this.accumulatorPath);

        // Optimized pragmas for heavy ingest
        this.db.pragma('journal_mode = OFF');
        this.db.pragma('synchronous = OFF');
        this.db.pragma('page_size = 16384');

        this.db.exec(`
            CREATE TABLE registry (
                id TEXT PRIMARY KEY,
                data TEXT, -- Full JSON blob
                fni_score REAL,
                status TEXT, -- 'archived' or 'active'
                last_seen TEXT
            );
            CREATE INDEX idx_fni ON registry(fni_score DESC);
        `);
    }

    /**
     * Load existing sharded registry into accumulator
     */
    async load() {
        if (!this.db) await this.initAccumulator();

        console.log('[REGISTRY] Hydrating accumulator from sharded registry...');
        const insert = this.db.prepare('INSERT INTO registry (id, data, fni_score, status, last_seen) VALUES (?, ?, ?, ?, ?)');

        let total = 0;
        await loadRegistryShardsSequentially(async (entities) => {
            const transaction = this.db.transaction((batch) => {
                for (const e of batch) {
                    insert.run(e.id, JSON.stringify(e), e.fni_score || 0, 'archived', e._last_seen || '');
                    total++;
                }
            });
            transaction(entities);
        }, { slim: false });

        this.count = total;
        this.didLoadFromStorage = total > 0;
        console.log(`  [REGISTRY] Hydrated ${total} entities into accumulator.`);
        return { count: total };
    }

    /**
     * Merge current batch entities into the accumulator using UPSERT
     */
    async mergeCurrentBatch(batchEntities) {
        if (!this.db) await this.initAccumulator();

        console.log(`[REGISTRY] UPSERT-Merging ${batchEntities.length} entities...`);
        const select = this.db.prepare('SELECT data FROM registry WHERE id = ?');
        const upsert = this.db.prepare(`
            INSERT INTO registry (id, data, fni_score, status, last_seen) 
            VALUES (:id, :data, :fni_score, :status, :last_seen)
            ON CONFLICT(id) DO UPDATE SET
                data = excluded.data,
                fni_score = excluded.fni_score,
                status = excluded.status,
                last_seen = excluded.last_seen
        `);

        const now = new Date().toISOString();
        let updated = 0;
        let added = 0;

        const transaction = this.db.transaction((batch) => {
            for (const e of batch) {
                const id = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
                const existingRow = select.get(id);

                let finalData;
                if (existingRow) {
                    const existing = JSON.parse(existingRow.data);
                    const merged = mergeEntities(existing, e);
                    finalData = { ...merged, id, status: 'active', _last_seen: now };
                    updated++;
                } else {
                    finalData = { ...e, id, status: 'active', _last_seen: now };
                    added++;
                }

                upsert.run({
                    id,
                    data: JSON.stringify(finalData),
                    fni_score: finalData.fni_score || 0,
                    status: 'active',
                    last_seen: now
                });
            }
        });

        transaction(batchEntities);

        // Apply FNI decay for unvisited (archived) entities
        console.log('[REGISTRY] Applying global FNI decay...');
        this.db.exec("UPDATE registry SET fni_score = fni_score * 0.95 WHERE status = 'archived'");

        console.log(`  [REGISTRY] Stats: ${added} added, ${updated} updated.`);
        this.count = this.db.prepare('SELECT count(*) as count FROM registry').get().count;
        return {
            didLoadFromStorage: this.didLoadFromStorage,
            count: this.count,
            added,
            updated
        };
    }

    /**
     * Get all entities as an array (Memory Intensive)
     * Use only when downstream requires a monolith.
     */
    getAllEntities() {
        if (!this.db) return [];
        const rows = this.db.prepare('SELECT data FROM registry').all();
        return rows.map(r => JSON.parse(r.data));
    }

    /**
     * Get a streaming iterator for entities (Memory Efficient)
     * Returns an iterator that yields parsed JSON entities.
     */
    *getStreamingIterator(orderBy = 'fni_score DESC') {
        if (!this.db) return;
        const select = this.db.prepare(`SELECT data FROM registry ORDER BY ${orderBy}`);
        for (const row of select.iterate()) {
            yield JSON.parse(row.data);
        }
    }

    /**
     * Save the accumulator back to sharded Registry JSON
     * Sorts by FNI Score to maintain index parity.
     */
    async save() {
        if (!this.db) return;

        console.log(`[REGISTRY] Exporting ${this.count} entities to sharded storage...`);
        const select = this.db.prepare('SELECT data FROM registry ORDER BY fni_score DESC');

        let shardIndex = 0;
        let shardBatch = [];

        for (const row of select.iterate()) {
            shardBatch.push(JSON.parse(row.data));
            if (shardBatch.length >= SHARD_SIZE) {
                await saveRegistryShard(shardIndex++, shardBatch);
                shardBatch = [];
            }
        }

        if (shardBatch.length > 0) {
            await saveRegistryShard(shardIndex++, shardBatch);
        }

        console.log(`  [REGISTRY] Saved ${shardIndex} shards.`);

        // Cleanup
        this.db.close();
        this.db = null;
        await fs.unlink(this.accumulatorPath);
    }
}
