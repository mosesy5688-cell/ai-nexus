#!/usr/bin/env node
/**
 * V26.3 R2 Workflow CLI — Replaces inline `node -e` R2 blocks in workflow YAML. All ops go through r2-bridge.js
 * (Rust FFI with JS fallback). Actions: upload-file <localPath> <r2Key> | upload-buffer <localPath> <r2Key>
 * [--content-type=...] | restore-file <r2Key> <localPath> [--strict] | restore-dir <r2Prefix> <localDir> [--strict] |
 * backup-dir <localDir> <r2Prefix> [--extensions=.json,.zst] [--required-json] | restore-rust-ffi [crate,...] |
 * backup-rust-ffi [crate,...] | list-prefix <r2Prefix> [--delimiter=/] | delete-prefix <r2Prefix> [--dry-run] |
 * handoff-establish | handoff-consume --role=<merge-core-persist|finalize> | satellite-registry-establish/preflight |
 * satellite-registry-consume --role=<...> | harvest-handoff-establish --role=<...> | harvest-handoff-consume.
 * handoff-* / satellite-registry-* / harvest-handoff-* : attempt-scoped R2 authority carriers in
 * aggregate-handoff.mjs / satellite-registry-handoff.mjs / harvest-authoritative-handoff.mjs.
 */
import fs from 'fs';
import { pathToFileURL } from 'url';
import {
    initR2Bridge, createR2ClientFFI, backupFileToR2FFI, restoreFileFromR2FFI,
    backupDirectoryToR2FFI, restoreDirectoryFromR2FFI, uploadFileFFI, uploadBufferToR2FFI
} from './lib/r2-bridge.js';

const [action, ...rest] = process.argv.slice(2);
const DEFAULT_CRATES = 'shard-router,fni-calc,content-extractor,stream-aggregator,satellite-tasks,r2-engine,markdown-renderer,ivf-pq,identity-cluster';

async function main() {
    initR2Bridge();
    // D-380 §5.1 LAZY client: created ONLY inside actions that use it; backup-dir/restore-dir make their OWN JS
    // client in r2-handoff.js (FFI `client` arg unused for dir ops => pass undefined), no up-front construction.
    switch (action) {
        case 'upload-file': {
            const client = createR2ClientFFI();
            const [localPath, r2Key] = rest.filter(a => !a.startsWith('--'));
            if (!localPath || !r2Key) { console.error('Usage: upload-file <localPath> <r2Key>'); process.exit(1); }
            const result = await uploadFileFFI(client, localPath, r2Key);
            console.log(`[R2-CLI] upload-file: ${result?.success ? 'OK' : 'FAIL'} ${localPath} -> ${r2Key}`);
            if (!result?.success) process.exit(1);
            break;
        }
        case 'upload-buffer': {
            const client = createR2ClientFFI();
            const positional = rest.filter(a => !a.startsWith('--'));
            const [localPath, r2Key] = positional;
            if (!localPath || !r2Key) { console.error('Usage: upload-buffer <localPath> <r2Key>'); process.exit(1); }
            const ct = parseOpt(rest, 'content-type', 'application/octet-stream');
            const stat = fs.statSync(localPath);
            const sizeMb = (stat.size / 1048576).toFixed(0);
            if (stat.size > 100 * 1024 * 1024) {
                const { Upload } = await import('@aws-sdk/lib-storage');
                const { createR2Client } = await import('./lib/r2-helpers.js');
                const s3Client = createR2Client();
                const stream = fs.createReadStream(localPath);
                const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
                const upload = new Upload({ client: s3Client, params: { Bucket: bucket, Key: r2Key, Body: stream, ContentType: ct }, partSize: 64 * 1024 * 1024 });
                await upload.done();
                console.log(`[R2-CLI] upload-buffer (S3 multipart stream): ${localPath} -> ${r2Key} (${sizeMb}MB)`);
            } else {
                const data = fs.readFileSync(localPath);
                await uploadBufferToR2FFI(client, r2Key, data, ct);
                console.log(`[R2-CLI] upload-buffer: ${localPath} -> ${r2Key} (${sizeMb}MB)`);
            }
            break;
        }
        case 'backup-file': {
            const [localPath, r2Key] = rest;
            if (!localPath || !r2Key) { console.error('Usage: backup-file <localPath> <r2Key>'); process.exit(1); }
            const minSize = parseOpt(rest, 'min-size', 1024);
            const result = await backupFileToR2FFI(localPath, r2Key, { minSize });
            console.log(`[R2-CLI] backup-file: ${result?.success ? 'OK' : 'SKIP'} ${localPath} -> ${r2Key}`);
            break;
        }
        case 'restore-file': {
            const positional = rest.filter(a => !a.startsWith('--'));
            const [r2Key, localPath] = positional;
            if (!r2Key || !localPath) { console.error('Usage: restore-file <r2Key> <localPath>'); process.exit(1); }
            const strict = rest.includes('--strict');
            const result = await restoreFileFromR2FFI(r2Key, localPath);
            console.log(`[R2-CLI] restore-file: ${result?.success ? 'OK' : 'MISS'} ${r2Key} -> ${localPath}`);
            if (strict && !result?.success) { console.error('[R2-CLI] FATAL: restore-file failed (strict mode)'); process.exit(1); }
            break;
        }
        case 'restore-dir': {
            const positional = rest.filter(a => !a.startsWith('--'));
            const [r2Prefix, localDir] = positional;
            if (!r2Prefix || !localDir) { console.error('Usage: restore-dir <r2Prefix> <localDir> [--strict]'); process.exit(1); }
            const strict = rest.includes('--strict');
            const result = await restoreDirectoryFromR2FFI(undefined, r2Prefix, localDir, { strict });
            // D-382 §3.2: structured (non-exit-changing) result line so tests assert the exact restore outcome through the REAL CLI seam.
            console.log(`[R2-CLI-RESULT] ${JSON.stringify({ action: 'restore-dir', success: !!result?.success, restored: result?.restored || 0, expected: result?.expected || 0, missing: result?.missing || [], failed: result?.failed || [], source: result?.source || 'none', manifestFound: !!result?.manifestFound, reason: result?.reason })}`);
            console.log(`[R2-CLI] restore-dir: ${result?.restored || 0}/${result?.expected || 0} restored from ${r2Prefix} (source=${result?.source || 'none'})`);
            if (!result?.success) console.error(`[R2-CLI] restore-dir INCOMPLETE: missing ${result?.missing?.length ?? '?'} (reason=${result?.reason || 'n/a'})`);
            // D-380 §8: strict exit decided by result.success, NOT count>0 -- a 4015/4016 short restore MUST exit non-zero.
            if (strict && !result?.success) { console.error('[R2-CLI] FATAL: restore-dir incomplete (strict mode)'); process.exit(1); }
            break;
        }
        case 'backup-dir': {
            const positional = rest.filter(a => !a.startsWith('--'));
            const [localDir, r2Prefix] = positional;
            if (!localDir || !r2Prefix) { console.error('Usage: backup-dir <localDir> <r2Prefix>'); process.exit(1); }
            const extensions = parseOpt(rest, 'extensions', null)?.split(',') || null;
            const result = await backupDirectoryToR2FFI(undefined, localDir, r2Prefix, { extensions, requiredJson: rest.includes('--required-json') });
            if (!result?.success) { console.error(`[R2-CLI] FATAL: backup-dir NOT committed (${result?.reason || 'incomplete'}) -> ${r2Prefix}`); process.exit(1); } // D-356 fail-closed default; best-effort call-sites keep `|| true`
            console.log(`[R2-CLI] backup-dir OK: ${result.count || 0} new / ${result.verified}/${result.expected} verified -> ${r2Prefix}`);
            break;
        }
        case 'restore-rust-ffi': {
            const crates = (rest[0] || DEFAULT_CRATES).split(',');
            for (const c of crates) {
                const r2Key = `vault/rust-ffi/${c}-rust.node`;
                const localPath = `rust/${c}/${c}-rust.node`;
                const r = await restoreFileFromR2FFI(r2Key, localPath);
                console.log(`  ${c}: ${r?.success ? 'restored' : 'not available'}`);
            }
            break;
        }
        case 'backup-rust-ffi': {
            const crates = (rest[0] || DEFAULT_CRATES).split(',');
            for (const c of crates) {
                const localPath = `rust/${c}/${c}-rust.node`;
                const r2Key = `vault/rust-ffi/${c}-rust.node`;
                const r = await backupFileToR2FFI(localPath, r2Key, { minSize: 1024 });
                console.log(`  ${c}: ${r?.success ? 'backed up' : 'skipped'}`);
            }
            console.log('[R2-CLI] Rust FFI binaries backed up to R2 vault');
            break;
        }
        case 'handoff-establish': {
            // Producer (merge-core-compute): establish the attempt-scoped
            // authoritative R2 core handoff. All logic lives in the injectable
            // aggregate-handoff.mjs library; this is the workflow-facing wiring.
            const { runHandoffEstablishCli } = await import('./aggregate-handoff.mjs');
            await runHandoffEstablishCli(process.env);
            break;
        }
        case 'handoff-consume': {
            // Consumer (merge-core-persist OR finalize, --role=...): independently
            // load + verify + extract the current-attempt manifest/archive.
            const { runHandoffConsumeCli } = await import('./aggregate-handoff.mjs');
            await runHandoffConsumeCli(process.env, rest);
            break;
        }
        case 'satellite-registry-establish':
        case 'satellite-registry-preflight':
        case 'satellite-registry-consume': {
            const m = await import('./satellite-registry-handoff.mjs');
            const run = { 'satellite-registry-establish': m.runSatelliteEstablishCli, 'satellite-registry-preflight': m.runSatellitePreflightCli, 'satellite-registry-consume': m.runSatelliteConsumeCli }[action];
            await run(process.env, rest);
            break;
        }
        case 'harvest-handoff-establish':
        case 'harvest-handoff-consume': {
            // D-236/D-237: per-source Factory 1/4 harvest R2 authority (establish per role; consume = Merge resolver). Logic in harvest-authoritative-handoff.mjs.
            const m = await import('./harvest-authoritative-handoff.mjs');
            if (action === 'harvest-handoff-establish') await m.runHarvestEstablishCli(process.env, rest);
            else await m.runHarvestConsumeCli(process.env);
            break;
        }
        case 'list-prefix': {
            const positional = rest.filter(a => !a.startsWith('--'));
            const [r2Prefix] = positional;
            if (!r2Prefix) { console.error('Usage: list-prefix <r2Prefix> [--delimiter=/]'); process.exit(1); }
            const delimiter = parseOpt(rest, 'delimiter', null);
            const { keys, prefixes } = await listPrefix(r2Prefix, delimiter);
            const out = delimiter ? prefixes : keys;
            for (const k of out) console.log(k);
            console.error(`[R2-CLI] list-prefix: ${out.length} ${delimiter ? 'common-prefixes' : 'keys'} under ${r2Prefix}`);
            break;
        }
        case 'delete-prefix': {
            const positional = rest.filter(a => !a.startsWith('--'));
            const [r2Prefix] = positional;
            if (!r2Prefix) { console.error('Usage: delete-prefix <r2Prefix> [--dry-run]'); process.exit(1); }
            assertHandoffStagingPrefix(r2Prefix);
            const dryRun = rest.includes('--dry-run');
            const { keys } = await listPrefix(r2Prefix, null);
            if (dryRun) {
                console.error(`[R2-CLI] delete-prefix DRY-RUN: would delete ${keys.length} objects under ${r2Prefix}`);
                break;
            }
            const deleted = await deleteKeys(keys);
            console.error(`[R2-CLI] delete-prefix: deleted ${deleted}/${keys.length} objects under ${r2Prefix}`);
            break;
        }
        default:
            console.error(`Unknown action: ${action}`);
            console.error('Actions: upload-file, upload-buffer, backup-file, restore-file, restore-dir, backup-dir, restore-rust-ffi, backup-rust-ffi, list-prefix, delete-prefix, handoff-establish, handoff-consume, satellite-registry-establish, satellite-registry-preflight, satellite-registry-consume, harvest-handoff-establish, harvest-handoff-consume');
            process.exit(1);
    }
}

function parseOpt(args, name, defaultVal) {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : defaultVal;
}

// Safety: delete-prefix may ONLY operate inside the handoff staging tree. This
// blocks the bounded GC (or a mis-call) from ever deleting state/fused-entities/
// (the compatibility publication copy), any other state/ carrier, or a bare/root
// prefix. Fail-loud rather than guess a lenient scope.
const HANDOFF_STAGING_ROOT = 'state/_handoff/';
function assertHandoffStagingPrefix(prefix) {
    const p = String(prefix || '');
    if (!p.startsWith(HANDOFF_STAGING_ROOT) || p.length <= HANDOFF_STAGING_ROOT.length) {
        console.error(`[R2-CLI] FATAL: delete-prefix refused — '${p}' is not under '${HANDOFF_STAGING_ROOT}'. Only handoff staging prefixes are deletable.`);
        process.exit(1);
    }
}

async function s3AndBucket() {
    const { createR2Client } = await import('./lib/r2-helpers.js');
    return { s3: createR2Client(), bucket: process.env.R2_BUCKET || 'ai-nexus-assets' };
}

// List object keys under a prefix (paginated). With a delimiter, also returns the
// immediate CommonPrefixes (used by the GC to enumerate old run "directories").
async function listPrefix(prefix, delimiter) {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const { s3, bucket } = await s3AndBucket();
    const keys = []; const prefixes = []; let tk;
    do {
        const r = await s3.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix, MaxKeys: 1000,
            Delimiter: delimiter || undefined, ContinuationToken: tk
        }));
        for (const o of r.Contents || []) keys.push(o.Key);
        for (const cp of r.CommonPrefixes || []) prefixes.push(cp.Prefix);
        tk = r.NextContinuationToken;
    } while (tk);
    return { keys, prefixes };
}

async function deleteKeys(keys) {
    if (keys.length === 0) return 0;
    const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
    const { s3, bucket } = await s3AndBucket();
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000).map(Key => ({ Key }));
        const r = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch } }));
        deleted += (r.Deleted || []).length;
        for (const err of r.Errors || []) console.error(`[R2-CLI] delete error ${err.Key}: ${err.Message}`);
    }
    return deleted;
}

export { main };
// D-380: gate auto-run so tests import + drive main() in-process. As a real script the guard is true (unchanged).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(err => { console.error(`[R2-CLI] Fatal: ${err.message || err.name || 'unknown'}`); process.exit(1); });
}
