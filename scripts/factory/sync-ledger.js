/**
 * V25.8.3 Sync Ledger — Feed the Density Booster Queue
 *
 * Scans Aggregate output (fused entities) and onboards them into dedup.db.
 * This fixes the "starvation" bug where Factory 1.5 has an empty work queue
 * because upsertEntities() was never called during the pack pipeline.
 *
 * Usage: node scripts/factory/sync-ledger.js
 * Environment:
 *   CACHE_DIR  — path to output/cache (default: ./output/cache)
 *   DEDUP_DB_PATH — path to dedup.db (default: ./output/data/dedup.db)
 */

import fs from 'fs/promises';
import path from 'path';
import { autoDecompress } from './lib/zstd-helper.js';
import { partitionMonolithStreamingly } from './lib/aggregator-stream-utils.js';
import { upsertEntities, openLedger } from './lib/dedup-manager.js';

const CACHE_DIR = process.env.CACHE_DIR || './output/cache';
const DEDUP_DB_PATH = process.env.DEDUP_DB_PATH || './output/data/dedup.db';
const BATCH_SIZE = 5000;

/**
 * Load all fused entities from Aggregate output.
 * Mirrors the loading logic in pack-utils.js collectAndSortMetadata().
 */
async function loadFusedEntities() {
    const fusedDir = path.join(CACHE_DIR, 'fused');
    let fusedFiles;
    try {
        fusedFiles = (await fs.readdir(fusedDir))
            .filter(f => f.endsWith('.json') || f.endsWith('.json.gz') || f.endsWith('.json.zst'));
    } catch {
        console.error(`[SYNC-LEDGER] FATAL: No fused directory at ${fusedDir}`);
        process.exit(1);
    }

    if (fusedFiles.length === 0) {
        console.error(`[SYNC-LEDGER] FATAL: No fused entities found in ${fusedDir}`);
        process.exit(1);
    }

    const entities = [];
    for (const file of fusedFiles) {
        const fullPath = path.join(fusedDir, file);
        try {
            // V26.6: O(1) streaming — bypasses V8 512MB string limit
            await partitionMonolithStreamingly(fullPath, (e) => {
                if (!e.id && !e.slug) return;
                entities.push(e);
            });
        } catch (e) {
            console.warn(`[SYNC-LEDGER] Skipping ${file}: ${e.message}`);
        }
    }

    console.log(`[SYNC-LEDGER] Loaded ${entities.length} entities from ${fusedFiles.length} fused shards`);
    return entities;
}

async function main() {
    console.log('[SYNC-LEDGER] V25.8.3 — Onboarding fused entities into dedup.db...');
    const startTime = Date.now();

    const allEntities = await loadFusedEntities();

    if (allEntities.length === 0) {
        console.warn('[SYNC-LEDGER] No entities to onboard. Exiting.');
        return;
    }

    // Batch upsert to avoid holding too much in memory
    let totalInserted = 0, totalRefreshed = 0;
    for (let i = 0; i < allEntities.length; i += BATCH_SIZE) {
        const batch = allEntities.slice(i, i + BATCH_SIZE);
        const result = upsertEntities(batch, DEDUP_DB_PATH);
        totalInserted += result.inserted;
        totalRefreshed += result.refreshed;
    }

    // Verify final state
    const db = openLedger(DEDUP_DB_PATH);
    const totalActive = db.prepare('SELECT COUNT(*) as c FROM ledger WHERE status = ?').get('active').c;
    const enrichStats = db.prepare("SELECT type, COUNT(*) as c FROM ledger WHERE has_fulltext = 0 AND status = 'active' GROUP BY type").all();
    const needEnrichment = enrichStats.reduce((sum, r) => sum + r.c, 0);
    db.close();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SYNC-LEDGER] ✅ Complete in ${elapsed}s`);
    console.log(`[SYNC-LEDGER]   Inserted: ${totalInserted} | Refreshed: ${totalRefreshed}`);
    console.log(`[SYNC-LEDGER]   Active: ${totalActive} | Need Enrichment: ${needEnrichment}`);
    for (const r of enrichStats) console.log(`[SYNC-LEDGER]     ${r.type}: ${r.c} need fulltext`);
}

main().catch(err => { console.error('[SYNC-LEDGER] Fatal:', err); process.exit(1); });
