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

const ARGS = process.argv.slice(2);
const dbArg = ARGS.find(a => a.startsWith('--db='))?.split('=')[1];
const DB_PATH = dbArg || './output/data/meta.db';
const CDN_BASE = 'https://cdn.free2aitools.com';

async function probe() {
    console.log('[PROBE] 🏥 V22.8 Full-Shard Production VFS Integrity Probe...');

    if (!process.env.CLOUDFLARE_ZONE_ID) {
        console.warn('[PROBE] ⚠️ No Zone ID found. Skipping production probe (CI Dry Run).');
        return;
    }

    const db = new Database(DB_PATH, { readonly: true });

    // V22.8: Get one random entity per shard for full coverage
    const samples = db.prepare(`
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
    `).all();

    db.close();

    if (samples.length === 0) {
        console.error('[PROBE] ❌ No sharded entities found in DB! Probe failed.');
        process.exit(1);
    }

    console.log(`[PROBE] Testing ${samples.length} shards (1 entity per shard)...`);
    let failures = 0;

    for (const s of samples) {
        const url = `${CDN_BASE}/${s.bundle_key}`;
        const range = `bytes=${s.bundle_offset}-${s.bundle_offset + s.bundle_size - 1}`;

        try {
            const res = await fetch(url, {
                headers: { 'Range': range },
                signal: AbortSignal.timeout(10000)
            });

            if (res.status === 206) {
                const buffer = await res.arrayBuffer();
                if (buffer.byteLength === s.bundle_size) {
                    console.log(`  ✅ ${s.bundle_key} → ${s.id}: OK (${buffer.byteLength}B)`);
                } else {
                    console.error(`  ❌ ${s.bundle_key} → ${s.id}: Size ${buffer.byteLength} ≠ expected ${s.bundle_size}`);
                    failures++;
                }
            } else {
                console.error(`  ❌ ${s.bundle_key} → ${s.id}: HTTP ${res.status}`);
                failures++;
            }
        } catch (e) {
            console.error(`  ❌ ${s.bundle_key} → ${s.id}: ${e.message}`);
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
