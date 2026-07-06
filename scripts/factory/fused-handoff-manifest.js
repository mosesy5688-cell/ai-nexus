#!/usr/bin/env node
/**
 * Fused Handoff Manifest (S1-BR EXACT-PRODUCER R2 HANDOFF).
 *
 * Narrow, pure (no R2, no network) module that:
 *  (a) generateManifest(dir)  -- walk a fused output dir, sha256 every file,
 *      compute a content set_sha256, parse the `.complete` sentinel, and emit
 *      the manifest object the persist/consumer jobs verify against.
 *  (b) verifyDirAgainstManifest(dir, manifest) -- EXACT set equality
 *      (extra/missing => fail), per-file size + sha256, set_sha256, the >=400
 *      part-count + >=400 complete_processed_shards gates, the `.complete` gate.
 *      Returns { ok, reason, code } -- never compares COUNT alone.
 *  (c) verifyDescriptor(descriptor, cur) -- provenance of the run-scoped handoff.
 * CES <=250 lines. Verifier of record for Compute (produce) + consume jobs.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isUploadEligible } from './lib/upload-eligibility.js';

export const SCHEMA_VERSION = 1;
export const CARRIER_TYPE = 'fused-entities';
export const PART_FILE_MIN = 400;
export const COMPLETE_SHARD_MIN = 400;
const PART_RE = /^part-\d+\.json\.zst$/;

function sha256File(absPath) {
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(absPath));
    return h.digest('hex');
}

/** STABLE-SORTED list of (relative_path, sha256) tuples -> single set hash. */
export function computeSetSha256(files) {
    const tuples = files
        .map((f) => [f.relative_path, f.sha256])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const h = crypto.createHash('sha256');
    for (const [rel, sha] of tuples) h.update(`${rel}\u0000${sha}\n`);
    return h.digest('hex');
}

/** List the fused-carrier files in a dir (data parts + the .complete sentinel). */
function listCarrierFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
        if (!e.isFile()) continue;
        // The handoff carrier set = part-*.json.zst data shards + the .complete
        // sentinel. manifest.json itself is NEVER counted (it must not contain
        // its own hash, and is uploaded LAST, after the carrier set).
        if (e.name === 'manifest.json' || e.name === 'handoff.json') continue;
        out.push(e.name);
    }
    return out.sort();
}

function parseComplete(dir) {
    const p = path.join(dir, '.complete');
    if (!fs.existsSync(p)) return { present: false, processedShards: 0 };
    try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { present: true, processedShards: Number(j.processedShards) || 0 };
    } catch {
        return { present: true, processedShards: 0 };
    }
}

/**
 * Build the manifest for a fused output directory.
 * `ctx` carries the run-provenance the manifest records (not derived from disk).
 */
export function generateManifest(dir, ctx = {}) {
    const names = listCarrierFiles(dir);
    const files = [];
    let totalBytes = 0;
    let partCount = 0;
    for (const name of names) {
        const buf = fs.readFileSync(path.join(dir, name));
        // GUARDED .json.zst parts (uploaded via `backup-dir`, factory-upload.yml:617) clear the SAME upload guard (isUploadEligible, .zst magic+16B); `.complete` is BYPASS (upload-file:621 + restore-file:744/902, always reaches R2) -> EXEMPT (its non-.zst 256B floor would false-fail). A refusable part fails LOUD at generate, never a late read-back FILE_MISSING.
        if (name.endsWith('.json.zst')) { const r = isUploadEligible(name, buf); if (!r.eligible) throw new Error(`MEMBER_UPLOAD_INELIGIBLE: fused part ${name}: ${r.reason}`); }
        files.push({ relative_path: name, size_bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
        totalBytes += buf.length;
        if (PART_RE.test(name)) partCount++;
    }
    const complete = parseComplete(dir);
    const manifest = {
        schema_version: SCHEMA_VERSION,
        carrier_type: CARRIER_TYPE,
        upstream_run_id: String(ctx.upstreamRunId ?? ''),
        factory_run_id: String(ctx.factoryRunId ?? ''),
        producer_run_attempt: Number(ctx.producerRunAttempt ?? 0),
        head_sha: String(ctx.headSha ?? ''),
        created_at: ctx.createdAt || new Date().toISOString(),
        file_count: files.length,
        part_file_count: partCount,
        total_bytes: totalBytes,
        complete_processed_shards: complete.processedShards,
        files,
        set_sha256: computeSetSha256(files)
    };
    return manifest;
}

function fail(code, reason) { return { ok: false, code, reason }; }

/**
 * Verify a directory against a manifest. EXACT set equality + sizes + per-file
 * hashes + set hash + count gates + .complete gate. NEVER count-only.
 */
export function verifyDirAgainstManifest(dir, manifest) {
    if (!manifest || typeof manifest !== 'object') return fail('MANIFEST_MALFORMED', 'manifest missing/not an object');
    if (manifest.carrier_type !== CARRIER_TYPE) return fail('CARRIER_MISMATCH', `carrier_type != ${CARRIER_TYPE}`);
    if (!Array.isArray(manifest.files)) return fail('MANIFEST_MALFORMED', 'manifest.files not an array');
    if (Object.prototype.hasOwnProperty.call(manifest, 'manifest_sha256')) {
        return fail('MANIFEST_SELF_HASH', 'manifest must NOT contain its own hash');
    }

    // .complete presence + processed-shards gate (sentinel is in the carrier set).
    const complete = parseComplete(dir);
    if (!complete.present) return fail('COMPLETE_MISSING', '.complete sentinel absent');
    if (complete.processedShards < COMPLETE_SHARD_MIN) {
        return fail('COMPLETE_SHARDS_LOW', `processedShards ${complete.processedShards} < ${COMPLETE_SHARD_MIN}`);
    }
    if (Number(manifest.complete_processed_shards) < COMPLETE_SHARD_MIN) {
        return fail('MANIFEST_SHARDS_LOW', `manifest.complete_processed_shards < ${COMPLETE_SHARD_MIN}`);
    }
    if (Number(manifest.part_file_count) < PART_FILE_MIN) {
        return fail('PART_COUNT_LOW', `manifest.part_file_count < ${PART_FILE_MIN}`);
    }

    // EXACT set equality between manifest.files and the actual on-disk carrier set.
    const actualNames = new Set(listCarrierFiles(dir));
    const manifestNames = new Set(manifest.files.map((f) => f.relative_path));
    for (const n of manifestNames) {
        if (!actualNames.has(n)) return fail('FILE_MISSING', `manifest file absent on disk: ${n}`);
    }
    for (const n of actualNames) {
        if (!manifestNames.has(n)) return fail('FILE_EXTRA', `disk file not in manifest: ${n}`);
    }

    // Per-file size + sha256 equality + a recomputed-from-disk part count gate.
    let diskPartCount = 0;
    for (const f of manifest.files) {
        const abs = path.join(dir, f.relative_path);
        const size = fs.statSync(abs).size;
        if (size !== Number(f.size_bytes)) {
            return fail('SIZE_MISMATCH', `size mismatch ${f.relative_path}: disk ${size} != manifest ${f.size_bytes}`);
        }
        const sha = sha256File(abs);
        if (sha !== f.sha256) {
            return fail('HASH_MISMATCH', `sha256 mismatch ${f.relative_path}`);
        }
        if (PART_RE.test(f.relative_path)) diskPartCount++;
    }
    if (diskPartCount < PART_FILE_MIN) return fail('PART_COUNT_LOW', `on-disk part count ${diskPartCount} < ${PART_FILE_MIN}`);

    // set_sha256 equality (recomputed from disk hashes via the manifest tuples).
    const recomputed = computeSetSha256(manifest.files);
    if (recomputed !== manifest.set_sha256) {
        return fail('SET_HASH_MISMATCH', 'manifest.set_sha256 != recomputed set hash');
    }

    return { ok: true, code: 'OK', reason: 'verified', set_sha256: manifest.set_sha256, file_count: manifest.files.length };
}

/**
 * Verify a run-scoped handoff descriptor's PROVENANCE (no R2). Rules:
 *  - structurally valid (required fields present, correct types);
 *  - may point ONLY at the CURRENT upstream id + CURRENT factory run id;
 *  - producer_attempt is a positive int <= the current run_attempt;
 *  - exact_staging_prefix matches the run + producer-attempt derivation
 *    (no list-latest / no prefix guess / no previous-run fallback).
 * Missing/malformed => fail-loud. `cur` = { upstreamRunId, factoryRunId, runAttempt }.
 */
export function verifyDescriptor(descriptor, cur) {
    if (!descriptor || typeof descriptor !== 'object') return fail('DESC_MALFORMED', 'descriptor missing/not an object');
    const req = ['producer_attempt', 'exact_staging_prefix', 'manifest_sha256', 'set_sha256', 'upstream_run_id', 'factory_run_id', 'head_sha', 'created_at'];
    for (const k of req) {
        if (descriptor[k] === undefined || descriptor[k] === null || descriptor[k] === '') {
            return fail('DESC_FIELD_MISSING', `descriptor.${k} missing`);
        }
    }
    const pa = Number(descriptor.producer_attempt);
    const curAtt = Number(cur.runAttempt);
    if (!Number.isInteger(pa) || pa < 1) return fail('DESC_ATTEMPT_INVALID', `producer_attempt ${descriptor.producer_attempt} not a positive int`);
    if (!Number.isInteger(curAtt) || curAtt < 1) return fail('DESC_CURATTEMPT_INVALID', `current run_attempt ${cur.runAttempt} invalid`);
    if (pa > curAtt) return fail('DESC_ATTEMPT_FUTURE', `producer_attempt ${pa} > current run_attempt ${curAtt}`);
    if (String(descriptor.upstream_run_id) !== String(cur.upstreamRunId)) {
        return fail('DESC_UPSTREAM_MISMATCH', `descriptor upstream ${descriptor.upstream_run_id} != current ${cur.upstreamRunId}`);
    }
    if (String(descriptor.factory_run_id) !== String(cur.factoryRunId)) {
        return fail('DESC_RUN_MISMATCH', `descriptor factory run ${descriptor.factory_run_id} != current ${cur.factoryRunId}`);
    }
    const expectPrefix = `state/_handoff/fused/${cur.upstreamRunId}/${cur.factoryRunId}/attempt-${pa}/`;
    if (String(descriptor.exact_staging_prefix) !== expectPrefix) {
        return fail('DESC_PREFIX_MISMATCH', `exact_staging_prefix ${descriptor.exact_staging_prefix} != derived ${expectPrefix}`);
    }
    return { ok: true, code: 'OK', reason: 'descriptor-verified', staging_prefix: expectPrefix, producer_attempt: pa, set_sha256: descriptor.set_sha256 };
}

// CLI: `generate <dir> <out-manifest>` (provenance via env), `verify <dir> <manifest>`,
// `verify-descriptor <descriptor.json>` (provenance via env). Consumer jobs use all three.
function runCli(argv) {
    const [cmd, ...rest] = argv;
    if (cmd === 'verify-descriptor') {
        const [descPath] = rest;
        let descriptor;
        try { descriptor = JSON.parse(fs.readFileSync(descPath, 'utf8')); }
        catch (e) { console.error(`[HANDOFF-DESC] FAIL DESC_UNREADABLE: ${e.message}`); return 1; }
        const res = verifyDescriptor(descriptor, {
            upstreamRunId: process.env.HANDOFF_UPSTREAM_RUN_ID,
            factoryRunId: process.env.HANDOFF_FACTORY_RUN_ID,
            runAttempt: process.env.HANDOFF_RUN_ATTEMPT
        });
        if (!res.ok) { console.error(`[HANDOFF-DESC] FAIL ${res.code}: ${res.reason}`); return 1; }
        // Emit staging prefix + set hash for the workflow to consume.
        process.stdout.write(`${res.staging_prefix}\t${res.set_sha256}\n`);
        console.error(`[HANDOFF-DESC] OK staging=${res.staging_prefix} producer_attempt=${res.producer_attempt}`);
        return 0;
    }
    if (cmd === 'generate') {
        const [dir, out] = rest;
        const manifest = generateManifest(dir, {
            upstreamRunId: process.env.HANDOFF_UPSTREAM_RUN_ID,
            factoryRunId: process.env.HANDOFF_FACTORY_RUN_ID,
            producerRunAttempt: process.env.HANDOFF_PRODUCER_ATTEMPT,
            headSha: process.env.HANDOFF_HEAD_SHA
        });
        fs.writeFileSync(out, JSON.stringify(manifest));
        process.stdout.write(`${manifest.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify') {
        const [dir, manifestPath] = rest;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = verifyDirAgainstManifest(dir, manifest);
        if (!res.ok) { console.error(`[HANDOFF-VERIFY] FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`[HANDOFF-VERIFY] OK set_sha256=${res.set_sha256} files=${res.file_count}`);
        process.stdout.write(`${res.set_sha256}\n`);
        return 0;
    }
    console.error('Usage: fused-handoff-manifest.js generate|verify|verify-descriptor <args>');
    return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', '').replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
    process.exit(runCli(process.argv.slice(2)));
}
