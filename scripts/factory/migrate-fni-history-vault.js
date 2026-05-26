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

const SRC_PREFIX = 'meta/backup/fni-history/';
const DST_PREFIX = 'vault/legacy/fni-history-snapshots/';
const TARGET_REGEX = /^meta\/backup\/fni-history\/fni-history-W\d+\.json\.zst$/;
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

async function run() {
    console.log(`[V27.69] mode=${isDryRun ? 'DRY-RUN' : 'COMMIT'} bucket=${BUCKET}`);
    console.log(`[V27.69] src=${SRC_PREFIX} dst=${DST_PREFIX}`);

    const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: SRC_PREFIX, MaxKeys: 1000 }));
    const all = list.Contents || [];
    console.log(`[V27.69] prefix scan: ${all.length} total objects under ${SRC_PREFIX}`);

    const targets = all.filter(o => o.Key && TARGET_REGEX.test(o.Key));
    if (targets.length === 0) {
        console.log('[V27.69] 0 targets match /fni-history-W\\d+\\.json\\.zst$/ — nothing to do');
        return;
    }

    console.log(`[V27.69] targets identified: ${targets.length}`);
    for (const obj of targets) {
        const sizeMB = (obj.Size / 1024 / 1024).toFixed(2);
        const dstKey = obj.Key.replace(SRC_PREFIX, DST_PREFIX);
        console.log(`  - ${obj.Key} (${sizeMB} MB) → ${dstKey}`);
    }

    if (isDryRun) {
        console.log('[V27.69] DRY-RUN: no R2 mutation performed');
        return;
    }

    console.log('[V27.69] COMMIT phase 1/2: CopyObject to vault');
    for (const obj of targets) {
        const dstKey = obj.Key.replace(SRC_PREFIX, DST_PREFIX);
        await s3.send(new CopyObjectCommand({
            Bucket: BUCKET,
            CopySource: `${BUCKET}/${encodeURIComponent(obj.Key).replace(/%2F/g, '/')}`,
            Key: dstKey
        }));
        console.log(`  ✅ copied ${obj.Key} → ${dstKey}`);
    }

    console.log('[V27.69] COMMIT phase 2/2: DeleteObjects from src');
    const deleteResp = await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: targets.map(o => ({ Key: o.Key })), Quiet: false }
    }));
    const deleted = (deleteResp.Deleted || []).length;
    const errors = (deleteResp.Errors || []);
    console.log(`  ✅ deleted ${deleted}/${targets.length} objects from src`);
    if (errors.length > 0) {
        console.error(`[V27.69] FAIL: ${errors.length} delete errors`, errors);
        process.exit(1);
    }

    console.log('[V27.69] migration complete — vault preserved + src cleaned');
}

run().catch(e => { console.error('[V27.69] FATAL:', e?.message, e?.stack); process.exit(1); });
