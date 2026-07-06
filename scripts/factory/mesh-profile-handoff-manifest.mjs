#!/usr/bin/env node
/**
 * Mesh-Profile Handoff Manifest -- durable, R2-authoritative, attempt-scoped,
 * manifest-last verifier of record for the Factory 4/4 mesh-baking -> consumers
 * (vfs-pack-db / vfs-derived / upload) seam (carrier "mesh-profile-authority").
 *
 * Authorized under Founder VFS_PRODUCER_ARTIFACT_EXACT_CYCLE_AUTHORITY_4_OF_4
 * (AUTHORITY-M). Mirrors the cycle-output-handoff-manifest.mjs / vfs-derived shape:
 * the exact-key GHA cache is DEMOTED to verified acceleration and the MUTABLE
 * fixed-prefix R2 copies (state/mesh-profile-dict/ + state/mesh-profile-shards/) are
 * REPLACED as authority by the attempt-scoped R2 authority. The attempt-scoped
 * manifest/descriptor (set_sha256 over the EXACT mesh-profile member set, dict_sha256,
 * expected_shard_count, bound to upstream_run_id + factory_run_id(4/4) + producer
 * attempt + head_sha + code_version) is the sole current-cycle authority.
 *
 * PAYLOAD SCOPE: profile-evidence-dict.json.zst (exactly 1) + profile-shards/**. An
 * INCLUDE filter picks ONLY those from output/cache/mesh/ -- graph.json / stats.json /
 * any other sibling is NEVER a member. NEVER a registry / cycle-output / meta member
 * (no double-bind).
 *
 * PURE module -- filesystem + crypto ONLY (no R2, no network, no @aws-sdk). All R2
 * I/O is done by the workflow via r2-workflow-cli.js (backup-dir / upload-file /
 * restore-dir / restore-file). This module only (a) generateManifest(dir,ctx),
 * (b) verifyDirAgainstManifest(dir,manifest) with EXACT set equality + per-file sha +
 * set_sha256 + class floors + expected_shard_count + dict_sha256, and
 * (c) verifyDescriptor(descriptor,cur) provenance. Never count-only.
 *
 * Same-run note: producer (mesh-baking) + consumers run in ONE 4/4 workflow run, so
 * github.run_id (factory_run_id) is IDENTICAL both sides and the check-upstream
 * upstream-run-id is IDENTICAL. Each consumer resolves
 * state/_handoff/mesh-profile/<upstream>/<run_id>/handoff.json deterministically --
 * NO new `needs:` DAG edge required (same discipline FIX-2 uses cross-workflow).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isUploadEligible } from './lib/upload-eligibility.js';

export const SCHEMA_VERSION = 1;
export const COMPLETION_STATE = 'complete';

// A member is a mesh-profile member IFF it matches this (the single evidence dict OR
// anything under profile-shards/). No-double-bind: a registry / cycle-output / meta
// path can never match, and graph.json / stats.json siblings are ignored.
const MESH_PROFILE_INCLUDE_RE = /^(profile-evidence-dict\.json\.zst|profile-shards\/.+)$/;

export const CARRIERS = Object.freeze({
    'mesh-profile-authority': Object.freeze({
        prefixRoot: 'state/_handoff/mesh-profile',
        producerJob: 'mesh-baking',
        // Upload-path classification for the generate-time upload-eligibility assert
        // (Founder D-2026-0706-285, PR-C family-completeness hardening). A GUARDED member
        // reaches R2 via `backup-dir` (the r2-handoff guard CAN refuse it) so generate MUST
        // assert isUploadEligible on it -> a guard-refusable member fails LOUD
        // (MEMBER_UPLOAD_INELIGIBLE) at generate, never a late read-back FILE_MISSING. A
        // BYPASS member reaches R2 via `upload-file` (never guard-refused; always uploaded
        // regardless of size) so it is EXEMPT from the assert -- asserting it would be a
        // FALSE fail-loud on a member that uploads fine. profile-shards/** are GUARDED
        // (factory-upload.yml:254 `backup-dir output/cache/mesh/profile-shards/`);
        // profile-evidence-dict.json.zst is the SOLE BYPASS member (factory-upload.yml:255
        // `upload-file … profile-evidence-dict.json.zst`). Default is GUARDED (assert): only a
        // path matching bypassRe is exempt -> a future member is asserted unless proven bypass.
        bypassRe: /^profile-evidence-dict\.json\.zst$/,
        classes: Object.freeze([
            { name: 'evidence_dict', re: /^profile-evidence-dict\.json\.zst$/, min: 1 },
            { name: 'profile_shard', re: /^profile-shards\/.+/, min: 1 },
        ]),
    }),
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const GITSHA_RE = /^[0-9a-f]{40}$/;
export function isSha256Hex(v) { return typeof v === 'string' && SHA256_RE.test(v); }
export function isGitSha(v) { return typeof v === 'string' && GITSHA_RE.test(v); }
export function carrierConfig(carrierType) {
    const c = CARRIERS[carrierType];
    if (!c) throw new HandoffManifestError('CARRIER_UNKNOWN', `unknown carrier_type "${carrierType}"`);
    return c;
}

export class HandoffManifestError extends Error {
    constructor(code, message) { super(`${code}: ${message}`); this.name = 'HandoffManifestError'; this.code = code; }
}
function fail(code, reason) { return { ok: false, code, reason }; }
function sha256File(absPath) { return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex'); }

/** STABLE-SORTED list of (relative_path, sha256) tuples -> single set hash. */
export function computeSetSha256(files) {
    const tuples = files.map((f) => [f.relative_path, f.sha256])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return crypto.createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
}

// Reserved sidecars NEVER part of the carrier set: manifest.json (uploaded LAST) +
// handoff.json (the descriptor) at the staging root; _manifest.json (backup-dir's own
// restore sidecar) at ANY depth. INCLUDE filter already excludes them, this is defence.
const ROOT_RESERVED = new Set(['manifest.json', 'handoff.json', '_manifest.json']);
function isReserved(rel) {
    if (rel === '_manifest.json' || rel.endsWith('/_manifest.json')) return true;
    return ROOT_RESERVED.has(rel);
}

/** List mesh-profile members under baseDir (INCLUDE-filtered posix relative paths).
 *  Symlink/traversal reject. graph.json/stats.json + reserved sidecars excluded. */
export function listCarrierFiles(baseDir) {
    const out = [];
    const walk = (absDir, relBase) => {
        let entries;
        try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const rel = relBase ? `${relBase}/${e.name}` : e.name;
            const abs = path.join(absDir, e.name);
            if (e.isSymbolicLink()) throw new HandoffManifestError('UNSAFE_MEMBER', `symlink member: ${rel}`);
            if (e.isDirectory()) { walk(abs, rel); continue; }
            if (!e.isFile()) continue;
            if (isReserved(rel)) continue;
            if (rel.split('/').some((s) => s === '..')) throw new HandoffManifestError('UNSAFE_MEMBER', `traversal member: ${rel}`);
            if (!MESH_PROFILE_INCLUDE_RE.test(rel)) continue;
            out.push(rel);
        }
    };
    walk(baseDir, '');
    return out.sort();
}

function countClasses(files, classes) {
    return classes.map((c) => ({ name: c.name, min: c.min, count: files.filter((f) => c.re.test(f.relative_path)).length }));
}

export function buildStagingPrefix(carrierType, upstreamRunId, factoryRunId, attempt) {
    const root = carrierConfig(carrierType).prefixRoot;
    return `${root}/${upstreamRunId}/${factoryRunId}/attempt-${attempt}/`;
}

function dictShaOf(baseDir, files) {
    const dict = files.find((f) => /^profile-evidence-dict\.json\.zst$/.test(f.relative_path));
    return dict ? sha256File(path.join(baseDir, dict.relative_path)) : null;
}
function shardCountOf(files) { return files.filter((f) => /^profile-shards\/.+/.test(f.relative_path)).length; }

/** Build the manifest for the mesh-profile carrier directory. `ctx` carries run
 *  provenance (not disk-derived). Enforces class floors + freezes expected_shard_count
 *  + dict_sha256 from the producer's own readdir at generate. */
export function generateManifest(baseDir, ctx = {}) {
    const carrier = carrierConfig(ctx.carrierType);
    const names = listCarrierFiles(baseDir);
    const files = [];
    let totalBytes = 0;
    for (const rel of names) {
        const abs = path.join(baseDir, rel);
        const buf = fs.readFileSync(abs);
        // GUARDED member (profile-shards/**, uploaded via `backup-dir`) MUST clear the SAME upload
        // guard the uploader applies (isUploadEligible, DEFAULT opts -- members are .zst; the .zst
        // magic + 16B floor) -> a guard-refusable shard fails LOUD MEMBER_UPLOAD_INELIGIBLE at
        // generate, never a silently-unsatisfiable manifest -> late read-back FILE_MISSING. The
        // BYPASS member (bypassRe: profile-evidence-dict.json.zst, uploaded via `upload-file`) is
        // EXEMPT -- it always reaches R2 and asserting it could false-fail a member that uploads fine.
        if (!carrier.bypassRe.test(rel)) {
            const { eligible, reason } = isUploadEligible(rel, buf);
            if (!eligible) throw new HandoffManifestError('MEMBER_UPLOAD_INELIGIBLE', `guarded member ${rel} upload-ineligible: ${reason}`);
        }
        const size = buf.length;
        files.push({ relative_path: rel, size_bytes: size, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
        totalBytes += size;
    }
    const requiredClasses = countClasses(files, carrierConfig(ctx.carrierType).classes);
    for (const rc of requiredClasses) {
        if (rc.count < rc.min) throw new HandoffManifestError('REQUIRED_CLASS_BELOW_FLOOR', `class ${rc.name}: ${rc.count} < min ${rc.min}`);
    }
    return {
        schema_version: SCHEMA_VERSION,
        carrier_type: ctx.carrierType,
        upstream_run_id: String(ctx.upstreamRunId ?? ''),
        factory_run_id: String(ctx.factoryRunId ?? ''),
        producer_job_identity: carrierConfig(ctx.carrierType).producerJob,
        producer_attempt: Number(ctx.producerAttempt ?? 0),
        head_sha: String(ctx.headSha ?? ''),
        code_version: String(ctx.codeVersion ?? ''),
        exact_staging_prefix: buildStagingPrefix(ctx.carrierType, ctx.upstreamRunId, ctx.factoryRunId, ctx.producerAttempt),
        created_at_utc: ctx.createdAt || new Date().toISOString(),
        completion_state: COMPLETION_STATE,
        required_file_classes: requiredClasses,
        expected_shard_count: shardCountOf(files),
        dict_sha256: dictShaOf(baseDir, files),
        member_count: files.length,
        total_bytes: totalBytes,
        files,
        set_sha256: computeSetSha256(files),
    };
}

/** Verify a directory against a manifest. EXACT set equality (extra/missing => fail),
 *  per-file size + sha256, set_sha256, class floors + counts, expected_shard_count ==
 *  actual, dict_sha256 == recomputed. Never count-only. */
export function verifyDirAgainstManifest(baseDir, manifest) {
    if (!manifest || typeof manifest !== 'object') return fail('MANIFEST_MALFORMED', 'manifest missing/not an object');
    if (!CARRIERS[manifest.carrier_type]) return fail('CARRIER_UNKNOWN', `carrier_type "${manifest.carrier_type}"`);
    if (!Array.isArray(manifest.files)) return fail('MANIFEST_MALFORMED', 'manifest.files not an array');
    if (Object.prototype.hasOwnProperty.call(manifest, 'manifest_sha256')) return fail('MANIFEST_SELF_HASH', 'manifest must NOT carry its own hash');
    const carrier = carrierConfig(manifest.carrier_type);

    let actualNames;
    try { actualNames = new Set(listCarrierFiles(baseDir)); }
    catch (e) { return fail(e.code || 'UNSAFE_MEMBER', e.message); }
    const manifestNames = new Set(manifest.files.map((f) => f.relative_path));
    for (const n of manifestNames) if (!MESH_PROFILE_INCLUDE_RE.test(n)) return fail('FOREIGN_MEMBER', `non-mesh-profile member in manifest: ${n}`);
    for (const n of manifestNames) if (!actualNames.has(n)) return fail('FILE_MISSING', `manifest file absent on disk: ${n}`);
    for (const n of actualNames) if (!manifestNames.has(n)) return fail('FILE_EXTRA', `disk file not in manifest: ${n}`);

    for (const f of manifest.files) {
        if (String(f.relative_path).split('/').some((s) => s === '..')) return fail('UNSAFE_MEMBER', `traversal member: ${f.relative_path}`);
        const abs = path.join(baseDir, f.relative_path);
        const size = fs.statSync(abs).size;
        if (size !== Number(f.size_bytes)) return fail('SIZE_MISMATCH', `size mismatch ${f.relative_path}: disk ${size} != manifest ${f.size_bytes}`);
        if (!isSha256Hex(f.sha256) || sha256File(abs) !== f.sha256) return fail('HASH_MISMATCH', `sha256 mismatch ${f.relative_path}`);
    }
    const recomputed = countClasses(manifest.files, carrier.classes);
    const declared = Array.isArray(manifest.required_file_classes) ? manifest.required_file_classes : [];
    for (const rc of recomputed) {
        if (rc.count < rc.min) return fail('REQUIRED_CLASS_BELOW_FLOOR', `class ${rc.name}: ${rc.count} < min ${rc.min}`);
        const d = declared.find((x) => x && x.name === rc.name);
        if (!d || Number(d.count) !== rc.count) return fail('REQUIRED_CLASS_COUNT_MISMATCH', `class ${rc.name}: manifest ${d && d.count} != disk ${rc.count}`);
    }
    const shardCount = shardCountOf(manifest.files);
    if (Number(manifest.expected_shard_count) !== shardCount) return fail('SHARD_COUNT_MISMATCH', `expected_shard_count ${manifest.expected_shard_count} != disk ${shardCount}`);
    const diskDictSha = dictShaOf(baseDir, manifest.files);
    if (!isSha256Hex(manifest.dict_sha256) || manifest.dict_sha256 !== diskDictSha) return fail('DICT_SHA_MISMATCH', `dict_sha256 ${manifest.dict_sha256} != disk ${diskDictSha}`);
    if (Number(manifest.member_count) !== manifest.files.length) return fail('MEMBER_COUNT_MISMATCH', `member_count ${manifest.member_count} != files ${manifest.files.length}`);
    if (computeSetSha256(manifest.files) !== manifest.set_sha256) return fail('SET_HASH_MISMATCH', 'manifest.set_sha256 != recomputed set hash');
    return { ok: true, code: 'OK', reason: 'verified', set_sha256: manifest.set_sha256, expected_shard_count: shardCount, dict_sha256: manifest.dict_sha256, file_count: manifest.files.length };
}

/** Verify a run-scoped handoff descriptor's PROVENANCE (no R2). Binds current upstream +
 *  factory run(4/4) + producer_attempt (positive int <= supplied run attempt) + head_sha +
 *  code_version + dict_sha256 + expected_shard_count + the EXACT staging-prefix derivation
 *  (no list-latest / prefix-guess / fixed / foreign cycle). */
export function verifyDescriptor(descriptor, cur) {
    if (!descriptor || typeof descriptor !== 'object') return fail('DESC_MALFORMED', 'descriptor missing/not an object');
    const req = ['carrier_type', 'upstream_run_id', 'factory_run_id', 'producer_attempt', 'exact_staging_prefix', 'manifest_sha256', 'set_sha256', 'dict_sha256', 'expected_shard_count', 'head_sha', 'created_at'];
    for (const k of req) if (descriptor[k] === undefined || descriptor[k] === null || descriptor[k] === '') return fail('DESC_FIELD_MISSING', `descriptor.${k} missing`);
    if (!CARRIERS[descriptor.carrier_type]) return fail('CARRIER_UNKNOWN', `carrier_type "${descriptor.carrier_type}"`);
    if (cur.carrierType && descriptor.carrier_type !== cur.carrierType) return fail('DESC_CARRIER_MISMATCH', `descriptor carrier ${descriptor.carrier_type} != expected ${cur.carrierType}`);
    if (!isSha256Hex(descriptor.set_sha256)) return fail('DESC_SET_SHA_INVALID', 'set_sha256 not a sha256');
    if (!isSha256Hex(descriptor.manifest_sha256)) return fail('DESC_MANIFEST_SHA_INVALID', 'manifest_sha256 not a sha256');
    if (!isSha256Hex(descriptor.dict_sha256)) return fail('DESC_DICT_SHA_INVALID', 'dict_sha256 not a sha256');
    if (!isGitSha(descriptor.head_sha)) return fail('DESC_HEAD_SHA_INVALID', 'head_sha not a 40-hex git sha');
    const esc = Number(descriptor.expected_shard_count);
    if (!Number.isInteger(esc) || esc < 1) return fail('DESC_SHARD_COUNT_INVALID', `expected_shard_count ${descriptor.expected_shard_count} not a positive int`);
    const pa = Number(descriptor.producer_attempt);
    if (!Number.isInteger(pa) || pa < 1) return fail('DESC_ATTEMPT_INVALID', `producer_attempt ${descriptor.producer_attempt} not a positive int`);
    if (cur.runAttempt != null && cur.runAttempt !== '') {
        const curAtt = Number(cur.runAttempt);
        if (!Number.isInteger(curAtt) || curAtt < 1) return fail('DESC_CURATTEMPT_INVALID', `current run_attempt ${cur.runAttempt} invalid`);
        if (pa > curAtt) return fail('DESC_ATTEMPT_FUTURE', `producer_attempt ${pa} > current run_attempt ${curAtt}`);
    }
    if (String(descriptor.upstream_run_id) !== String(cur.upstreamRunId)) return fail('DESC_UPSTREAM_MISMATCH', `descriptor upstream ${descriptor.upstream_run_id} != current ${cur.upstreamRunId}`);
    if (String(descriptor.factory_run_id) !== String(cur.factoryRunId)) return fail('DESC_RUN_MISMATCH', `descriptor factory run ${descriptor.factory_run_id} != current ${cur.factoryRunId}`);
    if (cur.headSha != null && cur.headSha !== '' && String(descriptor.head_sha) !== String(cur.headSha)) return fail('DESC_HEAD_SHA_MISMATCH', `descriptor head_sha ${descriptor.head_sha} != current ${cur.headSha}`);
    if (cur.codeVersion != null && cur.codeVersion !== '' && String(descriptor.code_version) !== String(cur.codeVersion)) return fail('DESC_VERSION_MISMATCH', `descriptor code_version ${descriptor.code_version} != current ${cur.codeVersion}`);
    const expectPrefix = buildStagingPrefix(descriptor.carrier_type, cur.upstreamRunId, cur.factoryRunId, pa);
    if (String(descriptor.exact_staging_prefix) !== expectPrefix) return fail('DESC_PREFIX_MISMATCH', `exact_staging_prefix ${descriptor.exact_staging_prefix} != derived ${expectPrefix}`);
    return { ok: true, code: 'OK', reason: 'descriptor-verified', staging_prefix: expectPrefix, producer_attempt: pa, set_sha256: descriptor.set_sha256, dict_sha256: descriptor.dict_sha256, expected_shard_count: esc };
}

// ============================================================================
// CLI: generate | verify | verify-descriptor. Provenance via env; carrier via
// --carrier=. The producer + consumer workflow steps use all three.
// ============================================================================
function parseFlag(argv, name) { const a = (argv || []).find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ''; }
function envCtx(carrierType) {
    return {
        carrierType,
        upstreamRunId: process.env.HANDOFF_UPSTREAM_RUN_ID,
        factoryRunId: process.env.HANDOFF_FACTORY_RUN_ID,
        producerAttempt: process.env.HANDOFF_PRODUCER_ATTEMPT,
        headSha: process.env.HANDOFF_HEAD_SHA,
        codeVersion: process.env.HANDOFF_MESH_CODE_VERSION,
    };
}

function runCli(argv) {
    const [cmd, ...rest] = argv;
    const positional = rest.filter((a) => !a.startsWith('--'));
    const carrierType = parseFlag(rest, 'carrier');
    if (cmd === 'generate') {
        const [dir, out] = positional;
        const manifest = generateManifest(dir, envCtx(carrierType));
        fs.writeFileSync(out, JSON.stringify(manifest));
        process.stdout.write(`${manifest.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify') {
        const [dir, manifestPath] = positional;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = verifyDirAgainstManifest(dir, manifest);
        if (!res.ok) { console.error(`[MESH-PROFILE-VERIFY] FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`[MESH-PROFILE-VERIFY] OK set_sha256=${res.set_sha256} shards=${res.expected_shard_count} dict=${res.dict_sha256}`);
        process.stdout.write(`${res.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify-descriptor') {
        const [descPath] = positional;
        let descriptor;
        try { descriptor = JSON.parse(fs.readFileSync(descPath, 'utf8')); }
        catch (e) { console.error(`[MESH-PROFILE-DESC] FAIL DESC_UNREADABLE: ${e.message}`); return 1; }
        const res = verifyDescriptor(descriptor, {
            carrierType: carrierType || undefined,
            upstreamRunId: process.env.HANDOFF_UPSTREAM_RUN_ID,
            factoryRunId: process.env.HANDOFF_FACTORY_RUN_ID,
            runAttempt: process.env.HANDOFF_RUN_ATTEMPT,
            headSha: process.env.HANDOFF_HEAD_SHA,
            codeVersion: process.env.HANDOFF_MESH_CODE_VERSION,
        });
        if (!res.ok) { console.error(`[MESH-PROFILE-DESC] FAIL ${res.code}: ${res.reason}`); return 1; }
        process.stdout.write(`${res.staging_prefix}\t${res.set_sha256}\t${res.dict_sha256}\t${res.expected_shard_count}\n`);
        console.error(`[MESH-PROFILE-DESC] OK staging=${res.staging_prefix} producer_attempt=${res.producer_attempt}`);
        return 0;
    }
    console.error('Usage: mesh-profile-handoff-manifest.mjs generate|verify|verify-descriptor <args> --carrier=mesh-profile-authority');
    return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', '').replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) { try { process.exit(runCli(process.argv.slice(2))); } catch (e) { console.error(`[MESH-PROFILE-HANDOFF] FATAL ${e.code || ''}: ${e.message}`); process.exit(1); } }
