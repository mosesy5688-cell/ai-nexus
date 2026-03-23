#!/usr/bin/env node
/**
 * V26.3 R2 Workflow CLI — Replaces inline `node -e` R2 blocks in workflow YAML.
 * All operations go through r2-bridge.js (Rust FFI with JS fallback).
 *
 * Usage:
 *   node r2-workflow-cli.js upload-file <localPath> <r2Key>
 *   node r2-workflow-cli.js upload-buffer <localPath> <r2Key> [--content-type=...]
 *   node r2-workflow-cli.js restore-file <r2Key> <localPath>
 *   node r2-workflow-cli.js restore-dir <r2Prefix> <localDir> [--strict]
 *   node r2-workflow-cli.js backup-dir <localDir> <r2Prefix> [--extensions=.json,.zst]
 *   node r2-workflow-cli.js restore-rust-ffi [crate1,crate2,...]
 */
import fs from 'fs';
import {
    initR2Bridge, createR2ClientFFI,
    backupFileToR2FFI, restoreFileFromR2FFI,
    backupDirectoryToR2FFI, restoreDirectoryFromR2FFI,
    uploadFileFFI, uploadBufferToR2FFI
} from './lib/r2-bridge.js';

const [action, ...rest] = process.argv.slice(2);
const DEFAULT_CRATES = 'shard-router,fni-calc,mesh-engine,content-extractor,stream-aggregator,satellite-tasks,r2-engine';

async function main() {
    initR2Bridge();
    const client = createR2ClientFFI();

    switch (action) {
        case 'upload-file': {
            const [localPath, r2Key] = rest.filter(a => !a.startsWith('--'));
            if (!localPath || !r2Key) { console.error('Usage: upload-file <localPath> <r2Key>'); process.exit(1); }
            const result = await uploadFileFFI(client, localPath, r2Key);
            console.log(`[R2-CLI] upload-file: ${result?.success ? 'OK' : 'FAIL'} ${localPath} -> ${r2Key}`);
            if (!result?.success) process.exit(1);
            break;
        }
        case 'upload-buffer': {
            const positional = rest.filter(a => !a.startsWith('--'));
            const [localPath, r2Key] = positional;
            if (!localPath || !r2Key) { console.error('Usage: upload-buffer <localPath> <r2Key>'); process.exit(1); }
            const ct = parseOpt(rest, 'content-type', 'application/octet-stream');
            const data = fs.readFileSync(localPath);
            await uploadBufferToR2FFI(client, r2Key, data, ct);
            console.log(`[R2-CLI] upload-buffer: OK ${localPath} -> ${r2Key} (${ct})`);
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
            const [r2Key, localPath] = rest;
            if (!r2Key || !localPath) { console.error('Usage: restore-file <r2Key> <localPath>'); process.exit(1); }
            const result = await restoreFileFromR2FFI(r2Key, localPath);
            console.log(`[R2-CLI] restore-file: ${result?.success ? 'OK' : 'MISS'} ${r2Key} -> ${localPath}`);
            break;
        }
        case 'restore-dir': {
            const positional = rest.filter(a => !a.startsWith('--'));
            const [r2Prefix, localDir] = positional;
            if (!r2Prefix || !localDir) { console.error('Usage: restore-dir <r2Prefix> <localDir>'); process.exit(1); }
            const strict = rest.includes('--strict');
            const result = await restoreDirectoryFromR2FFI(client, r2Prefix, localDir);
            console.log(`[R2-CLI] restore-dir: ${result?.count || 0} files restored from ${r2Prefix}`);
            if (strict && !result?.count) { console.error('[R2-CLI] FATAL: No files restored (strict mode)'); process.exit(1); }
            break;
        }
        case 'backup-dir': {
            const positional = rest.filter(a => !a.startsWith('--'));
            const [localDir, r2Prefix] = positional;
            if (!localDir || !r2Prefix) { console.error('Usage: backup-dir <localDir> <r2Prefix>'); process.exit(1); }
            const extStr = parseOpt(rest, 'extensions', null);
            const extensions = extStr ? extStr.split(',') : null;
            const result = await backupDirectoryToR2FFI(client, localDir, r2Prefix, { extensions });
            console.log(`[R2-CLI] backup-dir: ${result?.count || 0} files backed up to ${r2Prefix}`);
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
        default:
            console.error(`Unknown action: ${action}`);
            console.error('Actions: upload-file, upload-buffer, backup-file, restore-file, restore-dir, backup-dir, restore-rust-ffi, backup-rust-ffi');
            process.exit(1);
    }
}

function parseOpt(args, name, defaultVal) {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : defaultVal;
}

main().catch(err => { console.error(`[R2-CLI] Fatal: ${err.message}`); process.exit(1); });
