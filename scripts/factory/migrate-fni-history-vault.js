#!/usr/bin/env node
/**
 * V27.69 one-shot R2 migration: meta/backup/fni-history/fni-history-W*.json.zst
 * → vault/legacy/fni-history-snapshots/. Pre-V25.13 weekly monolith snapshots
 * are dead archive per aggregator-maintenance.js:71-86. No reader (filter:
 * loadFniHistory wants part-* or shard-*, not W*). No writer (V25.13 removed
 * backupStateFiles inline write). purgeStaleShards skips them (prefix scan
 * limited to .../part-). They linger in R2 forever, get re-restored by every
 * factory-aggregate cron's `restore-dir meta/backup/fni-history/`, and trigger
 * V27.63 magic-check BLOCKED warnings each cycle.
 *
 * Operation: CopyObject (preserve history) + DeleteObjects (eliminate cron
 * noise). Idempotent: re-run with no targets matched is a no-op.
 *
 * Modes:
 *   node migrate-fni-history-vault.js --dry-run   # list targets, no mutation
 *   node migrate-fni-history-vault.js --commit    # execute copy + delete
 *
 * Mutually exclusive — refuse both / neither.
 */
import { ListObjectsV2Command, CopyObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createR2Client } from './lib/r2-helpers.js';

// V27.70 hotfix: V27.69 first dry-run on `meta/backup/fni-history/` returned 0
// matches because (a) actual filename is `fni-history-2026-W14.json.zst` with
// date middle segment (my regex assumed no date), AND (b) BLOCKED files live in
// `state/cycle-output/meta/backup/fni-history/` — restored locally each cycle
// by `restore-dir state/cycle-output/` (factory-upload.yml:450) then scanned by
// backup-dir + magic-check rejected. Direct `meta/backup/fni-history/` prefix
// in R2 only contains live `part-*.json.zst` shards.
const SCAN_PREFIXES = [
    'meta/backup/fni-history/',
    'state/cycle-output/meta/backup/fni-history/',
];
const DST_PREFIX = 'vault/legacy/fni-history-snapshots/';
// Match both naming forms: fni-history-W<N>.json.zst (pre-V25.13) AND
// fni-history-<year>-W<N>.json.zst (later variant seen in 4/4 run 26426751493 log).
const TARGET_REGEX = /\/fni-history-(?:\d+-)?W\d+\.json\.zst$/;
const BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isCommit = args.includes('--commit');

if (isDryRun === isCommit) {
    console.error('[V27.69] FAIL: must specify exactly one of --dry-run or --commit');
    process.exit(2);
}

const s3 = createR2Client();
if (!s3) {
    console.error('[V27.69] FAIL: R2 credentials missing (CLOUDFLARE_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY required)');
    process.exit(2);
}

// Build vault dst key: collapse SCAN_PREFIXES to a single vault namespace so
// state/cycle-output/.../fni-history-2026-W14.json.zst → vault/legacy/fni-history-snapshots/fni-history-2026-W14.json.zst.
function toVaultKey(srcKey) {
    const filename = srcKey.split('/').pop();
    const stateMarker = srcKey.startsWith('state/cycle-output/') ? 'cycle-output/' : '';
    return `${DST_PREFIX}${stateMarker}${filename}`;
}

// V27.70: paginated ListObjectsV2 with ContinuationToken (state/cycle-output/
// has 10K+ keys, single MaxKeys=1000 page would miss).
async function listAllUnder(prefix) {
    const all = [];
    let token;
    do {
        const resp = await s3.send(new ListObjectsV2Command({
            Bucket: BUCKET, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token
        }));
        if (resp.Contents) all.push(...resp.Contents);
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return all;
}

async function run() {
    console.log(`[V27.69] mode=${isDryRun ? 'DRY-RUN' : 'COMMIT'} bucket=${BUCKET}`);
    console.log(`[V27.69] scan prefixes: ${SCAN_PREFIXES.join(', ')}`);
    console.log(`[V27.69] dst=${DST_PREFIX}`);

    const allTargets = [];
    for (const prefix of SCAN_PREFIXES) {
        const objs = await listAllUnder(prefix);
        console.log(`[V27.69] prefix scan: ${objs.length} total objects under ${prefix}`);
        const matched = objs.filter(o => o.Key && TARGET_REGEX.test(o.Key));
        console.log(`[V27.69]   matched W-series: ${matched.length}`);
        allTargets.push(...matched);
    }

    if (allTargets.length === 0) {
        console.log('[V27.69] 0 targets across all prefixes — nothing to do');
        return;
    }

    console.log(`[V27.69] total targets identified: ${allTargets.length}`);
    for (const obj of allTargets) {
        const sizeMB = (obj.Size / 1024 / 1024).toFixed(2);
        console.log(`  - ${obj.Key} (${sizeMB} MB) → ${toVaultKey(obj.Key)}`);
    }

    if (isDryRun) {
        console.log('[V27.69] DRY-RUN: no R2 mutation performed');
        return;
    }

    console.log('[V27.69] COMMIT phase 1/2: CopyObject to vault');
    for (const obj of allTargets) {
        const dstKey = toVaultKey(obj.Key);
        await s3.send(new CopyObjectCommand({
            Bucket: BUCKET,
            CopySource: `${BUCKET}/${encodeURIComponent(obj.Key).replace(/%2F/g, '/')}`,
            Key: dstKey
        }));
        console.log(`  ✅ copied ${obj.Key} → ${dstKey}`);
    }

    console.log('[V27.69] COMMIT phase 2/2: DeleteObjects from src');
    // DeleteObjects max 1000 keys per call — chunk if exceeded.
    const CHUNK = 1000;
    let totalDeleted = 0, totalErrors = [];
    for (let i = 0; i < allTargets.length; i += CHUNK) {
        const batch = allTargets.slice(i, i + CHUNK);
        const resp = await s3.send(new DeleteObjectsCommand({
            Bucket: BUCKET,
            Delete: { Objects: batch.map(o => ({ Key: o.Key })), Quiet: false }
        }));
        totalDeleted += (resp.Deleted || []).length;
        if (resp.Errors) totalErrors.push(...resp.Errors);
    }
    console.log(`  ✅ deleted ${totalDeleted}/${allTargets.length} objects from src`);
    if (totalErrors.length > 0) {
        console.error(`[V27.69] FAIL: ${totalErrors.length} delete errors`, totalErrors);
        process.exit(1);
    }

    console.log('[V27.69] migration complete — vault preserved + src cleaned');
}

run().catch(e => { console.error('[V27.69] FATAL:', e?.message, e?.stack); process.exit(1); });
