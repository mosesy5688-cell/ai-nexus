/**
 * V26.9 Sync Ledger — Feed the Density Booster Queue
 *
 * Reads search.db (SQLite cursor, O(1) memory) and upserts into dedup.db.
 * Replaces the previous fused-entity JSON loading that caused OOM at 436K+ entities.
 *
 * Usage: node scripts/factory/sync-ledger.js
 * Environment:
 *   DEDUP_DB_PATH — path to dedup.db (default: ./output/data/dedup.db)
 *   SEARCH_DB_PATH — path to search.db (default: ./output/data/search.db)
 *   UMID_SALT — required for generateUMID fallback
 */

import Database from 'better-sqlite3';
import { upsertEntities, openLedger } from './lib/dedup-manager.js';

const DEDUP_DB_PATH = process.env.DEDUP_DB_PATH || './output/data/dedup.db';
const SEARCH_DB_PATH = process.env.SEARCH_DB_PATH || './output/data/search.db';
const BATCH_SIZE = 5000;

async function main() {
    console.log('[SYNC-LEDGER] V26.9 — Streaming from search.db into dedup.db...');
    const startTime = Date.now();

    const searchDb = new Database(SEARCH_DB_PATH, { readonly: true });
    const totalCount = searchDb.prepare('SELECT COUNT(*) as c FROM entities').get().c;
    console.log(`[SYNC-LEDGER] search.db: ${totalCount} entities`);

    if (totalCount === 0) {
        searchDb.close();
        console.warn('[SYNC-LEDGER] No entities in search.db. Exiting.');
        return;
    }

    // SQLite cursor iteration — O(1) memory, no JSON parse, no Zstd
    // V25.9.6: has_fulltext sourced from master-fusion (authoritative); upsertEntities applies MAX semantics.
    const stmt = searchDb.prepare(
        'SELECT id, umid, slug, name, type, author, source, fni_score, has_fulltext FROM entities'
    );

    let batch = [];
    let totalInserted = 0, totalRefreshed = 0, processed = 0;

    for (const row of stmt.iterate()) {
        batch.push(row);
        if (batch.length >= BATCH_SIZE) {
            const result = upsertEntities(batch, DEDUP_DB_PATH);
            totalInserted += result.inserted;
            totalRefreshed += result.refreshed;
            processed += batch.length;
            batch = [];
            if (processed % 50000 === 0) {
                console.log(`[SYNC-LEDGER]   Progress: ${processed}/${totalCount}`);
            }
        }
    }

    // Final batch
    if (batch.length > 0) {
        const result = upsertEntities(batch, DEDUP_DB_PATH);
        totalInserted += result.inserted;
        totalRefreshed += result.refreshed;
        processed += batch.length;
    }

    searchDb.close();

    // Verify final state
    const db = openLedger(DEDUP_DB_PATH);
    const totalActive = db.prepare('SELECT COUNT(*) as c FROM ledger WHERE status = ?').get('active').c;
    const enrichedCount = db.prepare("SELECT COUNT(*) as c FROM ledger WHERE has_fulltext = 1 AND status = 'active'").get().c;
    // Factory 1.5 only enriches papers — models get README at 1/4 harvest
    const enrichTargetTypes = ['paper'];
    const enrichStats = db.prepare(
        `SELECT type, COUNT(*) as c FROM ledger WHERE has_fulltext = 0 AND status = 'active' AND type IN (${enrichTargetTypes.map(() => '?').join(',')}) GROUP BY type`
    ).all(...enrichTargetTypes);
    const needEnrichment = enrichStats.reduce((sum, r) => sum + r.c, 0);
    db.close();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SYNC-LEDGER] ✅ Complete in ${elapsed}s`);
    console.log(`[SYNC-LEDGER]   Processed: ${processed} | Inserted: ${totalInserted} | Refreshed: ${totalRefreshed}`);
    console.log(`[SYNC-LEDGER]   Active: ${totalActive} | Already Enriched: ${enrichedCount}`);
    console.log(`[SYNC-LEDGER]   Need Enrichment (papers only): ${needEnrichment}`);
    for (const r of enrichStats) console.log(`[SYNC-LEDGER]     ${r.type}: ${r.c} need fulltext`);
}

main().catch(err => { console.error('[SYNC-LEDGER] Fatal:', err); process.exit(1); });
