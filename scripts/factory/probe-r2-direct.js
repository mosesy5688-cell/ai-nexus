/**
 * R2 Origin Direct Probe — V27.3 (L2 deployment verification)
 *
 * Samples one entity per shard from local meta-NN.db (same sampling as
 * probe-vfs.js V25.9.6) and issues Range GETs against the R2 origin via
 * the S3 SDK, bypassing the Cloudflare CDN entirely. Confirms that the
 * bytes we uploaded to R2 are actually fetchable at the offsets recorded
 * in the meta DBs — orthogonal to CDN edge state.
 *
 * Three-tier model:
 *   L1 (V27.2 verifier)          local pack-db output internally consistent
 *   L2 (this probe)              R2 origin holds the bytes meta references
 *   L3 (V19.2 probe-vfs.js)      CDN delivers the bytes to end users
 *
 * Failure of L2 means: R2 origin is inconsistent (partial multipart, byte
 * truncation during upload, multipart ETag-byte mismatch). Cannot be fixed
 * by CDN purge; the build must re-pack / re-upload before any L3 probe is
 * meaningful.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const DATA_DIR = './output/data';
const BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';
const PROBE_BATCH = 10;
const PROBE_BATCH_DELAY_MS = 200;
const PROBE_RETRY_ATTEMPTS = 3;
const PROBE_RETRY_BASE_MS = 500;

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

function makeClient() {
    const accountId = process.env.R2_ACCOUNT_ID
        || process.env.CLOUDFLARE_ACCOUNT_ID
        || process.env.CF_ACCOUNT_ID;
    if (!accountId) throw new Error('R2_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID env missing');
    if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
        throw new Error('R2 credentials missing');
    }
    return new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

function collectSamplesFromShards() {
    const metaFiles = fs.readdirSync(DATA_DIR)
        .filter(f => /^meta-\d+\.db$/.test(f))
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

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

function classifyRangeError(err) {
    const name = err && err.name ? err.name : '';
    const msg = err && err.message ? err.message : String(err);
    if (name === 'InvalidRange' || /InvalidRange|416|Range Not Satisfiable/i.test(msg)) {
        return 'InvalidRange (offset+size exceeds R2 object size)';
    }
    if (name === 'NoSuchKey' || /NoSuchKey|NotFound/i.test(msg)) return 'NoSuchKey (object absent from R2)';
    return msg;
}

async function probeOne(s3, sample) {
    const start = sample.bundle_offset;
    const end = sample.bundle_offset + sample.bundle_size - 1;
    const range = `bytes=${start}-${end}`;
    for (let attempt = 0; attempt < PROBE_RETRY_ATTEMPTS; attempt++) {
        try {
            const res = await s3.send(new GetObjectCommand({
                Bucket: BUCKET, Key: sample.bundle_key, Range: range,
            }));
            const buf = await streamToBuffer(res.Body);
            if (buf.byteLength !== sample.bundle_size) {
                return { sample, ok: false, err: `Size ${buf.byteLength} != ${sample.bundle_size}` };
            }
            return { sample, ok: true, attempt };
        } catch (err) {
            const classified = classifyRangeError(err);
            if (classified.startsWith('InvalidRange') || classified.startsWith('NoSuchKey')) {
                return { sample, ok: false, err: classified };
            }
            if (attempt < PROBE_RETRY_ATTEMPTS - 1) {
                await new Promise(r => setTimeout(r, PROBE_RETRY_BASE_MS * (attempt + 1)));
                continue;
            }
            return { sample, ok: false, err: classified };
        }
    }
}

// V27.9: also probe each meta-NN.db file at R2 origin. The original V27.3
// probe samples (offset, size) from LOCAL meta DBs and verifies bytes are
// fetchable from `data/fused-shard-NNN.bin`. That validates the shard
// binaries but skips the meta DB files themselves — a meta-NN.db that's
// truncated or corrupted at R2 origin would NOT be detected because
// production reads it via R2 binding and the probe never touches that path.
// This extension compares R2 size to local size + verifies SQLite magic
// header for every meta-NN.db, catching:
//   - upload never landed (404 / object missing)
//   - upload truncated (size mismatch)
//   - upload corrupted (magic header wrong)
async function probeMetaDbs(s3) {
    const metaFiles = fs.readdirSync(DATA_DIR)
        .filter(f => /^meta-\d+\.db$/.test(f))
        .map(f => ({ name: f, localPath: path.join(DATA_DIR, f), localSize: fs.statSync(path.join(DATA_DIR, f)).size }));
    if (metaFiles.length === 0) return { total: 0, failures: 0 };
    console.log(`[R2-PROBE] Probing ${metaFiles.length} meta-NN.db files at R2 origin (size + SQLite magic)...`);
    let failures = 0;
    for (const m of metaFiles) {
        try {
            const head = await s3.send(new (await import('@aws-sdk/client-s3')).HeadObjectCommand({
                Bucket: BUCKET, Key: `data/${m.name}`,
            }));
            if (head.ContentLength !== m.localSize) {
                console.error(`  FAIL ${m.name}: R2 size ${head.ContentLength} != local size ${m.localSize}`);
                failures++; continue;
            }
            const res = await s3.send(new GetObjectCommand({
                Bucket: BUCKET, Key: `data/${m.name}`, Range: 'bytes=0-15',
            }));
            const header = await streamToBuffer(res.Body);
            const magic = Buffer.from(header).toString('ascii', 0, 15);
            if (magic !== 'SQLite format 3') {
                console.error(`  FAIL ${m.name}: bad magic header '${magic}' (expected 'SQLite format 3')`);
                failures++; continue;
            }
            console.log(`  OK ${m.name} (${m.localSize} bytes, magic OK)`);
        } catch (err) {
            const msg = classifyRangeError(err);
            console.error(`  FAIL ${m.name}: ${msg}`);
            failures++;
        }
    }
    return { total: metaFiles.length, failures };
}

async function main() {
    console.log('[R2-PROBE] V27.9 R2 Origin Direct Probe (L2 verification: shards + meta DBs)');

    if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
        console.warn('[R2-PROBE] R2 credentials missing - skipping (CI dry run)');
        return;
    }

    const s3 = makeClient();

    // Phase 1: probe meta-NN.db files themselves
    const metaResult = await probeMetaDbs(s3);
    if (metaResult.failures > 0) {
        console.error(`[R2-PROBE] FAIL ${metaResult.failures}/${metaResult.total} meta DBs. R2 origin corrupt — re-upload meta DBs before continuing.`);
        process.exit(1);
    }
    if (metaResult.total > 0) console.log(`[R2-PROBE] PASS - all ${metaResult.total} meta DBs coherent at R2 origin.`);

    // Phase 2: probe one entity per shard against the shard binary
    const samples = collectSamplesFromShards();
    if (samples.length === 0) {
        console.error('[R2-PROBE] No sharded entities in meta DBs. Probe failed.');
        process.exit(1);
    }

    console.log(`[R2-PROBE] Testing ${samples.length} shards via R2 origin (bucket=${BUCKET})...`);
    let failures = 0;

    for (let b = 0; b < samples.length; b += PROBE_BATCH) {
        const batch = samples.slice(b, b + PROBE_BATCH);
        const results = await Promise.all(batch.map(s => probeOne(s3, s)));
        for (const r of results) {
            if (r.ok) {
                const retryNote = r.attempt > 0 ? ` (retry ${r.attempt})` : '';
                console.log(`  OK ${r.sample.bundle_key} -> ${r.sample.id}${retryNote}`);
            } else {
                console.error(`  FAIL ${r.sample.bundle_key} -> ${r.sample.id}: ${r.err}`);
                failures++;
            }
        }
        if (b + PROBE_BATCH < samples.length) {
            await new Promise(r => setTimeout(r, PROBE_BATCH_DELAY_MS));
        }
    }

    if (failures > 0) {
        console.error(`[R2-PROBE] FAIL ${failures}/${samples.length} shards. R2 origin inconsistent — re-pack and re-upload before further verification.`);
        process.exit(1);
    }
    console.log(`[R2-PROBE] PASS - all ${samples.length} shards R2-origin coherent.`);
}

main().catch(err => { console.error('[R2-PROBE] Critical:', err.message); process.exit(1); });
