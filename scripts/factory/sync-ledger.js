/**
 * V26.5 Sync Ledger — Feed the Density Booster Queue
 *
 * Reads meta-NN.db shards (SQLite cursor, O(1) memory) and upserts into dedup.db.
 * V26.5: search.db eliminated — reads from 96 meta shards directly.
 *
 * Usage: node scripts/factory/sync-ledger.js
 * Environment:
 *   DEDUP_DB_PATH — path to dedup.db (default: ./output/data/dedup.db)
 *   SHARD_DIR — path to meta shard directory (default: ./output/data)
 *   UMID_SALT — required for generateUMID fallback
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { upsertEntities, aggregateStats } from './lib/dedup-manager.js';

const SHARD_DIR = process.env.SHARD_DIR || './output/data';
const BATCH_SIZE = 5000;

async function main() {
    console.log('[SYNC-LEDGER] V26.6 — Streaming from meta shards into sharded dedup ledger...');
    const startTime = Date.now();

    const shardFiles = fs.readdirSync(SHARD_DIR).filter(f => /^meta-\d+\.db$/.test(f)).sort();
    if (shardFiles.length === 0) {
        console.warn('[SYNC-LEDGER] No meta shards found. Exiting.');
        return;
    }
    console.log(`[SYNC-LEDGER] Found ${shardFiles.length} meta shards`);

    let batch = [];
    let totalInserted = 0, totalRefreshed = 0, processed = 0;

    for (const file of shardFiles) {
        const db = new Database(path.join(SHARD_DIR, file), { readonly: true });
        const stmt = db.prepare('SELECT id, umid, slug, name, type, author, source, fni_score, has_fulltext FROM entities');
        for (const row of stmt.iterate()) {
            batch.push(row);
            if (batch.length >= BATCH_SIZE) {
                const result = upsertEntities(batch);
                totalInserted += result.inserted;
                totalRefreshed += result.refreshed;
                processed += batch.length;
                batch = [];
                if (processed % 50000 === 0) console.log(`[SYNC-LEDGER]   Progress: ${processed}`);
            }
        }
        db.close();
    }

    if (batch.length > 0) {
        const result = upsertEntities(batch);
        totalInserted += result.inserted;
        totalRefreshed += result.refreshed;
        processed += batch.length;
    }

    const { totalActive, enriched, needByType } = aggregateStats();
    const needEnrichment = Object.values(needByType).reduce((s, c) => s + c, 0);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SYNC-LEDGER] ✅ Complete in ${elapsed}s`);
    console.log(`[SYNC-LEDGER]   Processed: ${processed} | Inserted: ${totalInserted} | Refreshed: ${totalRefreshed}`);
    console.log(`[SYNC-LEDGER]   Active: ${totalActive} | Already Enriched: ${enriched}`);
    console.log(`[SYNC-LEDGER]   Need Enrichment (papers only): ${needEnrichment}`);
    for (const [type, count] of Object.entries(needByType)) console.log(`[SYNC-LEDGER]     ${type}: ${count} need fulltext`);
}

main().catch(err => { console.error('[SYNC-LEDGER] Fatal:', err); process.exit(1); });
