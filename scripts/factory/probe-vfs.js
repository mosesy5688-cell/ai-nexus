/**
 * VFS Production Health Probe (Post-Deployment Integrity)
 * 
 * V22.8: Full-shard coverage — probes 1 random entity per shard
 * Logic:
 * 1. Load local meta.db to find all unique shards.
 * 2. For each shard, pick 1 random entity.
 * 3. Execute Range Request against production CDN.
 * 4. Verify HTTP 206 and correct content size.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const ARGS = process.argv.slice(2);
const dbArg = ARGS.find(a => a.startsWith('--db='))?.split('=')[1];
const DATA_DIR = './output/data';
const CDN_BASE = 'https://cdn.free2aitools.com';

// V25.9.5: search.db retired. Sample from meta-NN.db union — each meta shard
// holds ~1/40 of entities; unioning all slots covers every bundle_key.
function collectSamplesFromShards() {
    if (dbArg) {
        const db = new Database(dbArg, { readonly: true });
        const rows = db.prepare(SAMPLE_SQL).all();
        db.close();
        return rows;
    }
    const metaFiles = fs.readdirSync(DATA_DIR)
        .filter(f => /^meta-\d{2}\.db$/.test(f))
        .map(f => path.join(DATA_DIR, f));
    if (metaFiles.length === 0) throw new Error(`No meta-NN.db found in ${DATA_DIR}`);

    const perBundle = new Map();
    for (const file of metaFiles) {
        const db = new Database(file, { readonly: true });
        for (const row of db.prepare(SAMPLE_SQL).all()) {
            if (!perBundle.has(row.bundle_key)) perBundle.set(row.bundle_key, row);
        }
        db.close();
    }
    return Array.from(perBundle.values());
}

const SAMPLE_SQL = `
    SELECT e.id, e.bundle_key, e.bundle_offset, e.bundle_size
    FROM entities e
    INNER JOIN (
        SELECT bundle_key, MIN(rowid) as rid
        FROM (
            SELECT bundle_key, rowid FROM entities
            WHERE bundle_key IS NOT NULL
            ORDER BY RANDOM()
        )
        GROUP BY bundle_key
    ) s ON e.rowid = s.rid
`;

async function probe() {
    console.log('[PROBE] 🏥 V25.9.5 Full-Shard Production VFS Integrity Probe...');

    if (!process.env.CLOUDFLARE_ZONE_ID) {
        console.warn('[PROBE] ⚠️ No Zone ID found. Skipping production probe (CI Dry Run).');
        return;
    }

    const samples = collectSamplesFromShards();

    if (samples.length === 0) {
        console.error('[PROBE] ❌ No sharded entities found in DB! Probe failed.');
        process.exit(1);
    }

    console.log(`[PROBE] Testing ${samples.length} shards (1 entity per shard)...`);
    let failures = 0;

    // V25.9.6: retry ONLY on timeout/network error (catch branch).
    // Real failures (HTTP non-206, size mismatch) fail immediately — do not mask data corruption.
    // 2/391 false-positive rate observed when CDN cold-miss tail latency crossed 10s;
    // 15s × 3 retries absorbs the ~99p cold-miss latency without hiding true regressions.
    for (const s of samples) {
        const url = `${CDN_BASE}/${s.bundle_key}`;
        const range = `bytes=${s.bundle_offset}-${s.bundle_offset + s.bundle_size - 1}`;

        let lastErr = null;
        let success = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const res = await fetch(url, {
                    headers: { 'Range': range },
                    signal: AbortSignal.timeout(15000)
                });

                if (res.status === 206) {
                    const buffer = await res.arrayBuffer();
                    if (buffer.byteLength === s.bundle_size) {
                        const retryTag = attempt > 0 ? ` (retry ${attempt})` : '';
                        console.log(`  ✅ ${s.bundle_key} → ${s.id}: OK (${buffer.byteLength}B)${retryTag}`);
                        success = true;
                    } else {
                        lastErr = `Size ${buffer.byteLength} ≠ expected ${s.bundle_size}`;
                    }
                } else {
                    lastErr = `HTTP ${res.status}`;
                }
                break; // non-timeout outcomes (success or real failure) — do not retry
            } catch (e) {
                lastErr = e.message;
                if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            }
        }
        if (!success) {
            console.error(`  ❌ ${s.bundle_key} → ${s.id}: ${lastErr}`);
            failures++;
        }
    }

    if (failures > 0) {
        console.error(`[PROBE] ❌ ${failures}/${samples.length} shards FAILED. Deployment integrity compromised.`);
        process.exit(1);
    } else {
        console.log(`[PROBE] 🛡️ All ${samples.length} shards verified. Production VFS is coherent.`);
    }
}

probe().catch(err => {
    console.error('[PROBE] ❌ Critical Probe Error:', err);
    process.exit(1);
});
