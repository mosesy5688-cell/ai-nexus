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
            const raw = await fs.readFile(fullPath);
            const parsed = JSON.parse((await autoDecompress(raw)).toString('utf-8'));

            const batch = parsed.entities || (parsed.id ? [parsed] : [parsed]);
            for (const e of batch) {
                if (!e.id && !e.slug) continue;
                entities.push(e);
            }
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
    const paperCount = db.prepare("SELECT COUNT(*) as c FROM ledger WHERE type = 'paper' AND status = 'active'").get().c;
    const needEnrichment = db.prepare("SELECT COUNT(*) as c FROM ledger WHERE type = 'paper' AND has_fulltext = 0 AND status = 'active'").get().c;
    db.close();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SYNC-LEDGER] ✅ Complete in ${elapsed}s`);
    console.log(`[SYNC-LEDGER]   Inserted: ${totalInserted} | Refreshed: ${totalRefreshed}`);
    console.log(`[SYNC-LEDGER]   Active: ${totalActive} | Papers: ${paperCount} | Need Enrichment: ${needEnrichment}`);
}

main().catch(err => { console.error('[SYNC-LEDGER] Fatal:', err); process.exit(1); });
