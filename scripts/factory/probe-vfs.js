/**
 * VFS Production Health Probe (Post-Deployment Integrity)
 * 
 * Logic:
 * 1. Load local content.db to find 3 random entities with bundles.
 * 2. Execute Range Requests against the production CDN.
 * 3. Verify HTTP 206 and non-zero content.
 */

import Database from 'better-sqlite3';
// V19.4: Use native Node 20 fetch instead of node-fetch

const ARGS = process.argv.slice(2);
const dbArg = ARGS.find(a => a.startsWith('--db='))?.split('=')[1];
const DB_PATH = dbArg || './output/data/meta.db';
const CDN_BASE = 'https://cdn.free2aitools.com';

async function probe() {
    console.log('[PROBE] 🏥 Commencing Production VFS Integrity Probe...');

    if (!process.env.CLOUDFLARE_ZONE_ID) {
        console.warn('[PROBE] ⚠️ No Zone ID found. Skipping production probe (CI Dry Run).');
        return;
    }

    const db = new Database(DB_PATH, { readonly: true });

    // Pick 3 random entities that have bundles
    const samples = db.prepare(`
        SELECT id, bundle_key, bundle_offset, bundle_size 
        FROM entities 
        WHERE bundle_key IS NOT NULL 
        ORDER BY RANDOM() LIMIT 3
    `).all();

    db.close();

    if (samples.length === 0) {
        console.error('[PROBE] ❌ No sharded entities found in DB! Probe failed.');
        process.exit(1);
    }

    let failures = 0;

    for (const s of samples) {
        const url = `${CDN_BASE}/${s.bundle_key}`;
        const range = `bytes=${s.bundle_offset}-${s.bundle_offset + s.bundle_size - 1}`;

        console.log(`[PROBE] Testing ${s.id} @ ${url} (${range})...`);

        try {
            const res = await fetch(url, {
                headers: { 'Range': range },
                timeout: 5000
            });

            if (res.status === 206) {
                const buffer = await res.arrayBuffer();
                if (buffer.byteLength === s.bundle_size) {
                    console.log(`  ✅ ${s.id}: OK (${buffer.byteLength} bytes)`);
                } else {
                    console.error(`  ❌ ${s.id}: Size Mismatch! Got ${buffer.byteLength}, expected ${s.bundle_size}`);
                    failures++;
                }
            } else {
                console.error(`  ❌ ${s.id}: HTTP ${res.status} (${res.statusText})`);
                failures++;
            }
        } catch (e) {
            console.error(`  ❌ ${s.id}: Fetch Error: ${e.message}`);
            failures++;
        }
    }

    if (failures > 0) {
        console.error(`[PROBE] ❌ Probe Failed with ${failures} errors.`);
        process.exit(1);
    } else {
        console.log('[PROBE] 🛡️ All probes passed. Production VFS is coherent.');
    }
}

probe().catch(err => {
    console.error('[PROBE] ❌ Critical Probe Error:', err);
    process.exit(1);
});
