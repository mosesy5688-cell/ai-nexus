#!/usr/bin/env node
/**
 * Shards Handoff Manifest -- durable, R2-authoritative, attempt-scoped,
 * manifest-last verifier of record for the Factory 2/4 -> 3/4 shards seam
 * (PRIMARY carrier "shards-authority") AND the intra-2/4 prepared-entity-data
 * predecessor (GAP-5 carrier "prepared-entity-data-authority").
 *
 * Authorized under Founder D-2026-0704-262 (FIX-3 / C10 + GAP-5). This mirrors
 * the D-245 vfs-derived-handoff-manifest.mjs shape: GHA cache is DEMOTED to
 * verified acceleration, and the fixed-prefix R2 copies (state/shards/,
 * state/prepared-entity-data/) are DEMOTED to non-authoritative compat/legacy.
 * The attempt-scoped R2 manifest/descriptor (set_sha256 over the exact member
 * set, bound to process-run + producer attempt + head_sha) is the sole authority.
 *
 * PURE module -- filesystem + crypto ONLY (no R2, no network, no @aws-sdk). All
 * R2 I/O is done by the workflow via the generic r2-workflow-cli.js subcommands
 * (backup-dir / upload-file / restore-dir / restore-file). This module only
 * (a) generateManifest(dir,ctx,opts), (b) verifyDirAgainstManifest(dir,manifest)
 * with EXACT set equality + per-file sha + set_sha256 + required-class floors +
 * (for shards) EXACT-20 member identity, and (c) verifyDescriptor(descriptor,cur)
 * provenance (process-run + producer_attempt + head_sha + exact staging-prefix
 * derivation). Never count-only.
 *
 * Cross-workflow note: the shards seam spans two DIFFERENT workflow runs (2/4
 * producer, 3/4 consumer), so the single cycle key both sides derive IDENTICALLY
 * is the Process (2/4) run id -- github.run_id on the producer, process-id
 * (github.event.workflow_run.id) on the consumer. The staging prefix is therefore
 * scoped by process_run_id ONLY (the harvest upstream id is NOT reliably shared
 * across the two runs, so it is recorded as provenance but never in the path).
 * The prepared-entity-data seam is intra-2/4 (same run id, matrix consumers may
 * run at a later attempt after a rerun-failed-jobs), handled by descriptor-last.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isUploadEligible } from './lib/upload-eligibility.js';

export const SCHEMA_VERSION = 1;
export const COMPLETION_STATE = 'complete';
export const SHARD_TOTAL = 20;
const SHARD_RE = /^shard-\d+\.json\.zst$/;

// Carrier registry: distinct R2 prefix root + producer job + membership contract.
// A class {name, re, min}: `re` matched on the relative path; `min` is the floor.
// `exactMembers` (shards only) pins the EXACT member set (no gap/dup/foreign name).
// `memberRoots` (prepared-entity-data) walks each root subdir with its own filter.
export const CARRIERS = Object.freeze({
    'shards-authority': Object.freeze({
        prefixRoot: 'state/_handoff/shards',
        producerJob: 'save-shards-cache',
        extensions: Object.freeze(['.json.zst']),
        exactMembers: Object.freeze(Array.from({ length: SHARD_TOTAL }, (_, i) => `shard-${i}.json.zst`)),
        classes: Object.freeze([{ name: 'shard', re: SHARD_RE, min: SHARD_TOTAL }]),
    }),
    'prepared-entity-data-authority': Object.freeze({
        prefixRoot: 'state/_handoff/prepared-entity-data',
        producerJob: 'prepare-data',
        // D-262 A3 HYBRID EXPLICIT MEMBERSHIP: data/ carries the AUTHORITATIVE prepared
        // set (manifest + merged shards, .json/.json.zst). cache/ is NO LONGER an
        // unfiltered walk -- it is CLASSIFIED: each cache file is either a PROVEN
        // optional-accelerator EXCLUDE or, matching NO explicit class, an
        // UNCLASSIFIED_MEMBER fail-loud (never a silent include, never a silent drop).
        // The EXCLUDE families are the FULL set of STEADY-STATE accelerators reachable in
        // cache/ at the 2/4 "Establish Prepared-Entity-Data R2 Authority" generate step
        // (factory-process.yml) = the whole-cache/ cycle-<run>-harvest carrier MINUS the
        // "Free Disk" step (removes cache/registry/, cache/fni-history/, cache/global-registry.json.zst):
        //   - entity-checksums (2/4 change-detection accel; cache-manager.js) -- also its
        //     legacy .gz fallback (r2-registry-restore.js) + legacy uncompressed .json.
        //   - task-checksums   (4/4 aggregate incremental-rebuild accel; aggregator-
        //     incremental.js, carried into the harvest cache) -- also its legacy .json.
        //   - daily-accum      (global-stats accel; registry-accum.js; monolith + shard dir).
        //   - fni-history      (7-day trend accel; registry-history.js; FREED here, kept
        //     defensively for the pre-free window / monolith form).
        // Each is independently hydrated by the consumer + has a safe-absent default, so it
        // is NOT authoritative prepared DATA (the data/ set is). Net current members = the
        // data/ set ONLY. EXACT-set equality (no fixed count) + class floors. A genuinely
        // UNKNOWN cache file (any other name) still fails loud -- INTENTIONALLY. NOTE: on a
        // total-registry-loss disaster-recovery path (both meta/backup/registry AND
        // vault/legacy/registry return 0 shards) a LEGACY monolith cache/global-registry.json.gz
        // could reach generate; it is DELIBERATELY NOT excluded -- a 100MB+ registry monolith in
        // the prepared-entity-data context is an anomaly that MUST surface (UNCLASSIFIED_MEMBER),
        // never be silently tolerated. It is never prepared-entity-data.
        memberRoots: Object.freeze([
            Object.freeze({ dir: 'data', extensions: Object.freeze(['.json', '.json.zst']) }),
            Object.freeze({
                dir: 'cache',
                classification: Object.freeze({
                    includes: Object.freeze([]),
                    optionalAcceleratorExcludes: Object.freeze([
                        /^cache\/entity-checksums\.json(\.zst|\.gz)?$/,
                        /^cache\/task-checksums\.json(\.zst|\.gz)?$/,
                        /^cache\/daily-accum(\.json(\.zst|\.gz)?|\/.*)$/,
                        /^cache\/fni-history(\.json(\.zst|\.gz)?|\/.*)$/,
                    ]),
                }),
            }),
        ]),
        // Every INCLUDED member must be upload-eligible under the SAME predicate the
        // uploader applies (isUploadEligible) -- a REQUIRED member the guard would refuse
        // fails LOUD (MEMBER_UPLOAD_INELIGIBLE) at generate, never a late FILE_MISSING.
        assertMemberEligibility: true,
        classes: Object.freeze([
            { name: 'data_manifest', re: /^data\/manifest\.json$/, min: 1 },
            { name: 'merged_shard', re: /^data\/merged_shard_.*\.json\.zst$/, min: 1 },
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
    // JSON framing is collision-resistant (escapes any special char in a path) and
    // pure ASCII -- no NUL separator (which would flag the source as binary).
    return crypto.createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
}

// Reserved sidecars NEVER part of a carrier set: the handoff manifest.json (uploaded
// LAST) + handoff.json (the descriptor) are excluded only at the STAGING ROOT (so a
// real member like data/manifest.json is preserved); _manifest.json (backup-dir's own
// restore sidecar in r2-handoff.js) is excluded at ANY depth. Traversal/absolute rejected.
const ROOT_RESERVED = new Set(['manifest.json', 'handoff.json', '_manifest.json']);
function isReserved(rel) {
    if (rel === '_manifest.json' || rel.endsWith('/_manifest.json')) return true;
    return ROOT_RESERVED.has(rel);
}
function extMatch(rel, extensions) {
    if (!extensions || extensions.length === 0) return true;
    return extensions.some((e) => rel.endsWith(e));
}

// Recursively collect files under absDir (posix relative paths, prefixed by relBase),
// filtered by optional extensions, excluding reserved sidecars. Symlink/traversal reject.
function walkInto(absDir, relBase, extensions, out) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; } // absent root => no members (a below-floor class fails downstream)
    for (const e of entries) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        const abs = path.join(absDir, e.name);
        if (e.isSymbolicLink()) throw new HandoffManifestError('UNSAFE_MEMBER', `symlink member: ${rel}`);
        if (e.isDirectory()) { walkInto(abs, rel, extensions, out); continue; }
        if (!e.isFile()) continue;
        if (isReserved(rel)) continue;
        if (rel.split('/').some((s) => s === '..')) throw new HandoffManifestError('UNSAFE_MEMBER', `traversal member: ${rel}`);
        if (!extMatch(rel, extensions)) continue;
        out.push(rel);
    }
}

// Explicit membership classification for a CLASSIFIED member root (e.g. cache/): the
// dir is walked UNFILTERED (reserved sidecars/symlinks/traversal handled by walkInto),
// then EACH file is resolved to exactly one class -- an INCLUDED authoritative member
// (appended), a PROVEN optional-accelerator EXCLUDE (skipped), or, matching NO class,
// an UNCLASSIFIED_MEMBER fail-loud. Never a silent include, never a silent drop. The
// current cache/ classification has zero `includes`, so a clean cache/ yields 0 members.
function classifyRoot(absDir, relBase, classification, out) {
    const raw = [];
    walkInto(absDir, relBase, null, raw);
    const includes = classification.includes || [];
    const excludes = classification.optionalAcceleratorExcludes || [];
    for (const rel of raw) {
        if (includes.some((re) => re.test(rel))) { out.push(rel); continue; }
        if (excludes.some((re) => re.test(rel))) continue; // proven optional accelerator (proposal S4)
        throw new HandoffManifestError('UNCLASSIFIED_MEMBER', `cache member in no explicit class: ${rel}`);
    }
}

/** List carrier files under baseDir per the carrier's membership shape (single-root
 *  ext-filtered OR multi-root; a classified root applies explicit membership). Returns
 *  sorted posix relative paths. This is the SINGLE membership function used by BOTH
 *  generate and verify -- so the exclusion/classification is consistent by construction. */
export function listCarrierFiles(baseDir, carrier) {
    const out = [];
    if (Array.isArray(carrier.memberRoots)) {
        for (const r of carrier.memberRoots) {
            if (r.classification) classifyRoot(path.join(baseDir, r.dir), r.dir, r.classification, out);
            else walkInto(path.join(baseDir, r.dir), r.dir, r.extensions, out);
        }
    } else {
        walkInto(baseDir, '', carrier.extensions, out);
    }
    return out.sort();
}

function countClasses(files, classes) {
    return classes.map((c) => ({ name: c.name, min: c.min, count: files.filter((f) => c.re.test(f.relative_path)).length }));
}

export function buildStagingPrefix(carrierType, processRunId, attempt) {
    const root = carrierConfig(carrierType).prefixRoot;
    return `${root}/${processRunId}/attempt-${attempt}/`;
}

/** Build the manifest for a carrier directory. `ctx` carries run provenance (not
 *  derived from disk). Enforces required-class floors + EXACT membership at generate. */
export function generateManifest(baseDir, ctx = {}, opts = {}) {
    const carrier = carrierConfig(ctx.carrierType);
    const names = listCarrierFiles(baseDir, carrier);
    const files = [];
    let totalBytes = 0;
    for (const rel of names) {
        // rel already carries the member-root dir (multi-root) or is root-relative
        // (single-root), so the member abs path is uniformly baseDir + rel.
        const abs = path.join(baseDir, rel);
        const buf = fs.readFileSync(abs);
        // A3 (D-262): every INCLUDED member must be upload-eligible under the SAME
        // predicate the uploader applies -- a REQUIRED member the guard would refuse
        // fails LOUD here (never a silently-unsatisfiable manifest -> late FILE_MISSING).
        if (carrier.assertMemberEligibility) {
            const { eligible, reason } = isUploadEligible(rel, buf);
            if (!eligible) throw new HandoffManifestError('MEMBER_UPLOAD_INELIGIBLE', `included member ${rel} upload-ineligible: ${reason}`);
        }
        const size = buf.length;
        files.push({ relative_path: rel, size_bytes: size, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
        totalBytes += size;
    }
    const requiredClasses = countClasses(files, carrier.classes);
    for (const rc of requiredClasses) {
        if (rc.count < rc.min) throw new HandoffManifestError('REQUIRED_CLASS_BELOW_FLOOR', `class ${rc.name}: ${rc.count} < min ${rc.min}`);
    }
    if (carrier.exactMembers) assertExactMembersOrThrow(files.map((f) => f.relative_path), carrier.exactMembers);
    return {
        schema_version: SCHEMA_VERSION,
        carrier_type: ctx.carrierType,
        process_run_id: String(ctx.processRunId ?? ''),
        upstream_run_id: String(ctx.upstreamRunId ?? ''),
        producer_job_identity: carrier.producerJob,
        producer_attempt: Number(ctx.producerAttempt ?? 0),
        head_sha: String(ctx.headSha ?? ''),
        exact_staging_prefix: buildStagingPrefix(ctx.carrierType, ctx.processRunId, ctx.producerAttempt),
        created_at_utc: ctx.createdAt || new Date().toISOString(),
        completion_state: COMPLETION_STATE,
        member_count: carrier.exactMembers ? carrier.exactMembers.length : files.length,
        required_file_classes: requiredClasses,
        file_count: files.length,
        total_bytes: totalBytes,
        files,
        set_sha256: computeSetSha256(files),
    };
}

function assertExactMembersOrThrow(actual, expected) {
    const a = [...actual].sort();
    const e = [...expected].sort();
    if (a.length !== e.length) throw new HandoffManifestError('MEMBER_SET_NOT_EXACT', `member count ${a.length} != required ${e.length}`);
    for (let i = 0; i < e.length; i += 1) if (a[i] !== e[i]) throw new HandoffManifestError('MEMBER_SET_NOT_EXACT', `member ${a[i]} != required ${e[i]}`);
}

/** Verify a directory against a manifest. EXACT set equality (extra/missing => fail),
 *  per-file size + sha256, set_sha256, required-class floors + counts, and (shards)
 *  EXACT-20 member identity. Never count-only. */
export function verifyDirAgainstManifest(baseDir, manifest) {
    if (!manifest || typeof manifest !== 'object') return fail('MANIFEST_MALFORMED', 'manifest missing/not an object');
    if (!CARRIERS[manifest.carrier_type]) return fail('CARRIER_UNKNOWN', `carrier_type "${manifest.carrier_type}"`);
    if (!Array.isArray(manifest.files)) return fail('MANIFEST_MALFORMED', 'manifest.files not an array');
    if (Object.prototype.hasOwnProperty.call(manifest, 'manifest_sha256')) return fail('MANIFEST_SELF_HASH', 'manifest must NOT carry its own hash');
    const carrier = carrierConfig(manifest.carrier_type);

    let actualNames;
    try { actualNames = new Set(listCarrierFiles(baseDir, carrier)); }
    catch (e) { return fail(e.code || 'UNSAFE_MEMBER', e.message); }
    const manifestNames = new Set(manifest.files.map((f) => f.relative_path));
    for (const n of manifestNames) if (!actualNames.has(n)) return fail('FILE_MISSING', `manifest file absent on disk: ${n}`);
    for (const n of actualNames) if (!manifestNames.has(n)) return fail('FILE_EXTRA', `disk file not in manifest: ${n}`);

    for (const f of manifest.files) {
        if (String(f.relative_path).split('/').some((s) => s === '..')) return fail('UNSAFE_MEMBER', `traversal member: ${f.relative_path}`);
        const abs = path.join(baseDir, f.relative_path);
        const size = fs.statSync(abs).size;
        if (size !== Number(f.size_bytes)) return fail('SIZE_MISMATCH', `size mismatch ${f.relative_path}: disk ${size} != manifest ${f.size_bytes}`);
        if (!isSha256Hex(f.sha256) || sha256File(abs) !== f.sha256) return fail('HASH_MISMATCH', `sha256 mismatch ${f.relative_path}`);
    }
    // required-class floors + count agreement (a partial set => below floor).
    const recomputed = countClasses(manifest.files, carrier.classes);
    const declared = Array.isArray(manifest.required_file_classes) ? manifest.required_file_classes : [];
    for (const rc of recomputed) {
        if (rc.count < rc.min) return fail('REQUIRED_CLASS_BELOW_FLOOR', `class ${rc.name}: ${rc.count} < min ${rc.min}`);
        const d = declared.find((x) => x && x.name === rc.name);
        if (!d || Number(d.count) !== rc.count) return fail('REQUIRED_CLASS_COUNT_MISMATCH', `class ${rc.name}: manifest ${d && d.count} != disk ${rc.count}`);
    }
    // EXACT-20 shard membership (replaces the count-floor==0 / >=20 acceptance).
    if (carrier.exactMembers) {
        try { assertExactMembersOrThrow(manifest.files.map((f) => f.relative_path), carrier.exactMembers); }
        catch (e) { return fail(e.code, e.message); }
        if (Number(manifest.member_count) !== carrier.exactMembers.length) return fail('MEMBER_COUNT_MISMATCH', `member_count ${manifest.member_count} != ${carrier.exactMembers.length}`);
    }
    if (computeSetSha256(manifest.files) !== manifest.set_sha256) return fail('SET_HASH_MISMATCH', 'manifest.set_sha256 != recomputed set hash');
    return { ok: true, code: 'OK', reason: 'verified', set_sha256: manifest.set_sha256, file_count: manifest.files.length };
}

/** Verify a run-scoped handoff descriptor's PROVENANCE (no R2). Binds the current
 *  Process (2/4) run id + producer_attempt (positive int; <= current run_attempt only
 *  when a same-run current attempt is supplied) + head_sha (recorded git sha; equality
 *  enforced only when the consumer supplies an expected value) + the EXACT staging-prefix
 *  derivation (no list-latest / prefix-guess / mutable-latest / fixed / foreign cycle). */
export function verifyDescriptor(descriptor, cur) {
    if (!descriptor || typeof descriptor !== 'object') return fail('DESC_MALFORMED', 'descriptor missing/not an object');
    const req = ['carrier_type', 'process_run_id', 'producer_attempt', 'exact_staging_prefix', 'manifest_sha256', 'set_sha256', 'head_sha', 'created_at'];
    for (const k of req) if (descriptor[k] === undefined || descriptor[k] === null || descriptor[k] === '') return fail('DESC_FIELD_MISSING', `descriptor.${k} missing`);
    if (!CARRIERS[descriptor.carrier_type]) return fail('CARRIER_UNKNOWN', `carrier_type "${descriptor.carrier_type}"`);
    if (cur.carrierType && descriptor.carrier_type !== cur.carrierType) return fail('DESC_CARRIER_MISMATCH', `descriptor carrier ${descriptor.carrier_type} != expected ${cur.carrierType}`);
    if (!isSha256Hex(descriptor.set_sha256)) return fail('DESC_SET_SHA_INVALID', 'set_sha256 not a sha256');
    if (!isSha256Hex(descriptor.manifest_sha256)) return fail('DESC_MANIFEST_SHA_INVALID', 'manifest_sha256 not a sha256');
    if (!isGitSha(descriptor.head_sha)) return fail('DESC_HEAD_SHA_INVALID', 'head_sha not a 40-hex git sha');
    const pa = Number(descriptor.producer_attempt);
    if (!Number.isInteger(pa) || pa < 1) return fail('DESC_ATTEMPT_INVALID', `producer_attempt ${descriptor.producer_attempt} not a positive int`);
    // Same-run bound (prepared-entity-data / rerun-failed-jobs): producer_attempt cannot
    // exceed the consuming run's attempt. Omitted for the cross-workflow shards seam.
    if (cur.runAttempt != null && cur.runAttempt !== '') {
        const curAtt = Number(cur.runAttempt);
        if (!Number.isInteger(curAtt) || curAtt < 1) return fail('DESC_CURATTEMPT_INVALID', `current run_attempt ${cur.runAttempt} invalid`);
        if (pa > curAtt) return fail('DESC_ATTEMPT_FUTURE', `producer_attempt ${pa} > current run_attempt ${curAtt}`);
    }
    if (String(descriptor.process_run_id) !== String(cur.processRunId)) return fail('DESC_PROCESS_RUN_MISMATCH', `descriptor process_run_id ${descriptor.process_run_id} != current ${cur.processRunId}`);
    if (cur.headSha != null && cur.headSha !== '' && String(descriptor.head_sha) !== String(cur.headSha)) return fail('DESC_HEAD_SHA_MISMATCH', `descriptor head_sha ${descriptor.head_sha} != current ${cur.headSha}`);
    const expectPrefix = buildStagingPrefix(descriptor.carrier_type, cur.processRunId, pa);
    if (String(descriptor.exact_staging_prefix) !== expectPrefix) return fail('DESC_PREFIX_MISMATCH', `exact_staging_prefix ${descriptor.exact_staging_prefix} != derived ${expectPrefix}`);
    return { ok: true, code: 'OK', reason: 'descriptor-verified', staging_prefix: expectPrefix, producer_attempt: pa, set_sha256: descriptor.set_sha256 };
}

// ============================================================================
// CLI: generate | verify | verify-descriptor. Provenance via env; carrier via
// --carrier=. The producer + consumer workflow steps use all three.
// ============================================================================
function parseFlag(argv, name) { const a = (argv || []).find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ''; }
function envCtx(carrierType) {
    return {
        carrierType,
        processRunId: process.env.HANDOFF_PROCESS_RUN_ID,
        upstreamRunId: process.env.HANDOFF_UPSTREAM_RUN_ID,
        producerAttempt: process.env.HANDOFF_PRODUCER_ATTEMPT,
        headSha: process.env.HANDOFF_HEAD_SHA,
    };
}

function runCli(argv) {
    const [cmd, ...rest] = argv;
    const positional = rest.filter((a) => !a.startsWith('--'));
    const carrierType = parseFlag(rest, 'carrier');
    if (cmd === 'generate') {
        const [dir, out] = positional;
        const manifest = generateManifest(dir, envCtx(carrierType), {});
        fs.writeFileSync(out, JSON.stringify(manifest));
        process.stdout.write(`${manifest.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify') {
        const [dir, manifestPath] = positional;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = verifyDirAgainstManifest(dir, manifest);
        if (!res.ok) { console.error(`[SHARDS-HANDOFF-VERIFY] FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`[SHARDS-HANDOFF-VERIFY] OK set_sha256=${res.set_sha256} files=${res.file_count}`);
        process.stdout.write(`${res.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify-descriptor') {
        const [descPath] = positional;
        let descriptor;
        try { descriptor = JSON.parse(fs.readFileSync(descPath, 'utf8')); }
        catch (e) { console.error(`[SHARDS-HANDOFF-DESC] FAIL DESC_UNREADABLE: ${e.message}`); return 1; }
        const res = verifyDescriptor(descriptor, {
            carrierType: carrierType || undefined,
            processRunId: process.env.HANDOFF_PROCESS_RUN_ID,
            runAttempt: process.env.HANDOFF_RUN_ATTEMPT,
            headSha: process.env.HANDOFF_HEAD_SHA,
        });
        if (!res.ok) { console.error(`[SHARDS-HANDOFF-DESC] FAIL ${res.code}: ${res.reason}`); return 1; }
        process.stdout.write(`${res.staging_prefix}\t${res.set_sha256}\n`);
        console.error(`[SHARDS-HANDOFF-DESC] OK staging=${res.staging_prefix} producer_attempt=${res.producer_attempt}`);
        return 0;
    }
    console.error('Usage: shards-handoff-manifest.mjs generate|verify|verify-descriptor <args> --carrier=<shards-authority|prepared-entity-data-authority>');
    return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', '').replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) { try { process.exit(runCli(process.argv.slice(2))); } catch (e) { console.error(`[SHARDS-HANDOFF] FATAL ${e.code || ''}: ${e.message}`); process.exit(1); } }
