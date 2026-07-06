#!/usr/bin/env node
/**
 * Cycle-Output Handoff Manifest -- durable, R2-authoritative, attempt-scoped,
 * manifest-last verifier of record for the Factory 3/4 finalize -> 4/4 consumers
 * seam (carrier "cycle-output-authority").
 *
 * Authorized under Founder D-2026-0704-264 (FIX-2 / GAP-2 / C12). This mirrors the
 * FIX-3 shards-handoff-manifest.mjs shape: the exact-key GHA cache is DEMOTED to
 * verified acceleration and the mutable fixed-prefix R2 copy (state/cycle-output/)
 * is REPLACED by the attempt-scoped R2 authority. The attempt-scoped manifest/
 * descriptor (set_sha256 over the EXACT cycle-output member set, bound to the
 * producing 3/4 run id + producer attempt + head_sha) is the sole authority.
 *
 * A5 HYBRID (D-2026-0706-285, PR-A): the cache/** walk is CLASSIFIED (see classifyCycleMember)
 * so the manifest can never enumerate a member the uploader would refuse -- the confirmed 3/4
 * producer read-back + 4/4 consumer verify blocker. Regenerable `.meta.json` checksum sidecars
 * and empty-`{}` (sub-16B) alt-by-category placeholder frames are EXCLUDED by explicit class;
 * the consumer-required small JSONs (search-manifest / fni-thresholds / assertions/_summary) are
 * INCLUDED via the ADDITIVE/rescue-only required-JSON eligibility (MF-1: it can never block a
 * member the base floor accepts, so a >=floor member of ANY shape -- .gz/.jsonl/.ndjson -- stays
 * eligible exactly as base). Generate applies the SAME uploader opt (backup-dir --required-json)
 * to EVERY included member so generate == guard by construction; an UNKNOWN member fails loud
 * (UNCLASSIFIED_MEMBER) and an INCLUDED-but-refused member fails loud (MEMBER_UPLOAD_INELIGIBLE)
 * at generate. EXACT-set read-back is RETAINED.
 *
 * PAYLOAD SCOPE: the cycle-output payload is the finalize output/cache/** subtree
 * ONLY (the satellite results validated by the 3/4 "Verify Cycle Output
 * Completeness" gate and consumed by all four 4/4 jobs). output/data/ is 4/4-owned
 * (FIX-4 meta-NN.db + pack-db + state/vfs-data/) and is DELIBERATELY EXCLUDED --
 * this carrier NEVER covers output/data/. NO-REGISTRY-DOUBLE-BIND (D-264 D): any
 * `registry/` path segment or `global-registry*` file is EXCLUDED so the cycle-
 * output set can NEVER re-bind cache/registry/ / state/registry/ / global-registry
 * (owned by the FIX-1/FIX-1A registry carrier).
 *
 * PURE module -- filesystem + crypto ONLY (no R2, no network, no @aws-sdk). All R2
 * I/O is done by the workflow via the generic r2-workflow-cli.js subcommands
 * (backup-dir / upload-file / restore-dir / restore-file). This module only
 * (a) generateManifest(dir,ctx), (b) verifyDirAgainstManifest(dir,manifest) with
 * EXACT set equality + per-file sha + set_sha256 + required-class floors, and
 * (c) verifyDescriptor(descriptor,cur) provenance (finalize-run + producer_attempt
 * + head_sha + exact staging-prefix derivation). Never count-only.
 *
 * Cross-workflow note: the seam spans two DIFFERENT workflow runs (3/4 finalize
 * producer, 4/4 consumers). The single cycle key both sides derive IDENTICALLY is
 * the 3/4 Aggregate run id -- github.run_id on the producer, the 4/4
 * check-upstream upstream-run-id on the consumer. The staging prefix is therefore
 * scoped by that run id ONLY (single level); the harvest/cycle upstream id is
 * recorded as provenance but NEVER in the path.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isUploadEligible, ZSTD_MIN_BYTES } from './lib/upload-eligibility.js';

export const SCHEMA_VERSION = 1;
export const COMPLETION_STATE = 'complete';

// NO-REGISTRY-DOUBLE-BIND (D-264 D): exclude any `registry/` path segment or a
// `global-registry*` file from the cycle-output member set. The registry lives at
// the workspace-root cache/registry/ + state/registry/ + global-registry (a SEPARATE
// carrier); this defends against a hypothetical output/cache/registry/ leaking in.
const REGISTRY_EXCLUDE_RE = /(^|\/)(registry(\/|$)|global-registry[^/]*$)/;

// A5 HYBRID EXPLICIT MEMBERSHIP (D-2026-0706-285, PR-A). The cache/** walk is no longer a raw
// EXACT-set: each member is resolved to exactly ONE class so the manifest can NEVER enumerate a
// member the uploader (r2-handoff isUploadEligible) would refuse (the confirmed 3/4 read-back /
// 4/4 verify blocker), and a genuinely UNKNOWN member fails LOUD instead of silently included:
//   * OPTIONAL_ACCELERATOR (EXCLUDE): the `<payload>.meta.json` MD5 checksum sidecars
//     (smart-writer.js). ONLY consumer = smart-writer getRemoteHash() at PRODUCE time; zero
//     serve/4-4 readers; regenerable; NOT authoritative cycle-output -> never a member.
//   * EMPTY_PLACEHOLDER (EXCLUDE): a sub-16B (empty-`{}`) alt-by-category frame for a sparse
//     category. The Rust alt-linker path emits a bare 11B `{}` (< the .zst 16B floor). Consumer
//     knowledge-cache-reader.fetchCategoryAlts treats absent == present-empty (both -> []), so
//     excluding it is DATA-SAFE (proven-safe fallback per the PR-A decision rule; alt-linker.js
//     is at the CES 250-line ceiling so a net-zero producer normalize is infeasible). A >=16B
//     (real-data) alt frame is INCLUDED authoritative.
//   * TRANSPORT (INCLUDE, class-scoped required-JSON eligibility): the small consumer-required
//     JSONs cache/search-manifest.json (search-worker-loader full search) + cache/fni-thresholds
//     .json (master-fusion 4/4) + cache/assertions/_summary.json (verify-assertions). Below the
//     256B floor but consumer-required -> eligible on JSON validity (isUploadEligible requiredJson).
//   * AUTHORITATIVE (INCLUDE, default eligibility): any other JSON-family payload.
//   * anything else (a non-JSON-family member, e.g. a stray .bin) -> UNCLASSIFIED_MEMBER fail loud.
const META_SIDECAR_RE = /\.meta\.json$/;
const ALT_FRAME_RE = /^cache\/relations\/alt-by-category\/[^/]+\.json\.zst$/;
const AUTHORITATIVE_SHAPE_RE = /\.(zst|gz|json|jsonl|ndjson)$/;
const TRANSPORT_JSON = Object.freeze(new Set([
    'cache/search-manifest.json',
    'cache/fni-thresholds.json',
    'cache/assertions/_summary.json',
]));
const EXCLUDED_CLASSES = new Set(['optional', 'placeholder']);

/** Resolve a walked cache/** member (relative posix path) to exactly one class:
 *  'optional' | 'placeholder' (EXCLUDED) | 'transport' | 'authoritative' (INCLUDED), or throw
 *  UNCLASSIFIED_MEMBER. The empty-placeholder test needs the on-disk size (< 16B == empty frame),
 *  so `absPath` is stat'd only for an alt-by-category .json.zst. Used by BOTH generate and verify
 *  enumeration => membership is consistent by construction. */
function classifyCycleMember(rel, absPath) {
    if (META_SIDECAR_RE.test(rel)) return 'optional';           // regenerable checksum sidecar
    if (ALT_FRAME_RE.test(rel)) {
        let size = Infinity;
        try { size = fs.statSync(absPath).size; } catch { size = Infinity; }
        return size < ZSTD_MIN_BYTES ? 'placeholder' : 'authoritative'; // empty-{} sparse cat vs real
    }
    if (TRANSPORT_JSON.has(rel)) return 'transport';            // consumer-required small JSON
    if (AUTHORITATIVE_SHAPE_RE.test(rel)) return 'authoritative';
    throw new HandoffManifestError('UNCLASSIFIED_MEMBER', `cache member in no explicit class: ${rel}`);
}

// Carrier registry: distinct R2 prefix root + producer job + membership contract.
// A class {name, re, min}: `re` matched on the relative path; `min` is the floor.
// `memberRoots` walks each root subdir (single root `cache` => output/cache/**).
export const CARRIERS = Object.freeze({
    'cycle-output-authority': Object.freeze({
        prefixRoot: 'state/_handoff/cycle-output',
        producerJob: 'finalize',
        // Single member root: output/cache/** (walked then CLASSIFIED, A5). output/data/ is NOT a
        // member (4/4-owned). EXACT-set equality (no fixed count) over the classified set + floors.
        memberRoots: Object.freeze([
            Object.freeze({ dir: 'cache', extensions: null }),
        ]),
        excludeRe: REGISTRY_EXCLUDE_RE,
        classify: true,
        // Every INCLUDED member must be upload-eligible under the SAME predicate the uploader
        // applies (isUploadEligible) -- a member the guard would refuse fails LOUD
        // (MEMBER_UPLOAD_INELIGIBLE) at generate, never a late read-back FILE_MISSING.
        assertMemberEligibility: true,
        // The finalize producer uploads this set with `backup-dir --required-json`, so the generate
        // assert MUST pass the SAME opt to EVERY included member (the ADDITIVE/rescue-only predicate
        // is behavior-identical to the default for a >=floor member of ANY shape, and rescues ONLY a
        // sub-floor valid JSON) -> generate == uploader eligibility by construction (MF-1).
        uploaderRequiredJson: true,
        // Required-class floors mirror the 3/4 completeness gate's hard requirements
        // (the metadata files 4/4 pack-db depends on + non-empty knowledge/rankings).
        classes: Object.freeze([
            { name: 'mesh_graph', re: /^cache\/mesh\/graph\.json(\.zst|\.gz)?$/, min: 1 },
            { name: 'search_core', re: /^cache\/search-core\.json(\.zst|\.gz)?$/, min: 1 },
            { name: 'category_stats', re: /^cache\/category_stats\.json(\.zst|\.gz)?$/, min: 1 },
            { name: 'knowledge_index', re: /^cache\/knowledge\/index\.json\.zst$/, min: 1 },
            { name: 'trending', re: /^cache\/trending\.json\.zst$/, min: 1 },
            { name: 'rankings', re: /^cache\/rankings\/[^/]+/, min: 1 },
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
// LAST) + handoff.json (the descriptor) are excluded only at the STAGING ROOT;
// _manifest.json (backup-dir's own restore sidecar in r2-handoff.js) is excluded at
// ANY depth. Traversal/absolute rejected. cache/** members keep their own filenames.
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
// filtered by optional extensions, excluding reserved sidecars + excludeRe members.
// Symlink/traversal reject.
function walkInto(absDir, relBase, extensions, excludeRe, out) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; } // absent root => no members (a below-floor class fails downstream)
    for (const e of entries) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        const abs = path.join(absDir, e.name);
        if (excludeRe && excludeRe.test(rel)) continue; // no-registry-double-bind (dir + file)
        if (e.isSymbolicLink()) throw new HandoffManifestError('UNSAFE_MEMBER', `symlink member: ${rel}`);
        if (e.isDirectory()) { walkInto(abs, rel, extensions, excludeRe, out); continue; }
        if (!e.isFile()) continue;
        if (isReserved(rel)) continue;
        if (rel.split('/').some((s) => s === '..')) throw new HandoffManifestError('UNSAFE_MEMBER', `traversal member: ${rel}`);
        if (!extMatch(rel, extensions)) continue;
        out.push(rel);
    }
}

/** List carrier files under baseDir per the carrier's membership shape (one member root per
 *  subdir), then (A5) resolve each to its class and DROP the EXCLUDED classes (optional
 *  accelerator sidecar + empty-placeholder alt frame); a genuinely UNKNOWN member throws
 *  UNCLASSIFIED_MEMBER. This is the SINGLE membership function used by BOTH generate and verify,
 *  so the classification is consistent by construction. Returns sorted posix relative paths. */
export function listCarrierFiles(baseDir, carrier) {
    const raw = [];
    for (const r of carrier.memberRoots) walkInto(path.join(baseDir, r.dir), r.dir, r.extensions, carrier.excludeRe, raw);
    if (!carrier.classify) return raw.sort();
    const out = [];
    for (const rel of raw) {
        if (!EXCLUDED_CLASSES.has(classifyCycleMember(rel, path.join(baseDir, rel)))) out.push(rel);
    }
    return out.sort();
}

function countClasses(files, classes) {
    return classes.map((c) => ({ name: c.name, min: c.min, count: files.filter((f) => c.re.test(f.relative_path)).length }));
}

export function buildStagingPrefix(carrierType, finalizeRunId, attempt) {
    const root = carrierConfig(carrierType).prefixRoot;
    return `${root}/${finalizeRunId}/attempt-${attempt}/`;
}

/** Build the manifest for a carrier directory. `ctx` carries run provenance (not
 *  derived from disk). Enforces required-class floors at generate. */
export function generateManifest(baseDir, ctx = {}) {
    const carrier = carrierConfig(ctx.carrierType);
    const names = listCarrierFiles(baseDir, carrier);
    const files = [];
    let totalBytes = 0;
    for (const rel of names) {
        const abs = path.join(baseDir, rel);
        const buf = fs.readFileSync(abs);
        // A5 (MF-1): every INCLUDED member must be upload-eligible under the SAME predicate the
        // uploader applies. Pass the uploader's opt (backup-dir --required-json) to EVERY member,
        // NOT only the transport class -- with the ADDITIVE/rescue-only predicate this is
        // behavior-identical to the default for a >=floor member of ANY shape (.gz/.jsonl/.ndjson
        // never JSON-parsed) and rescues ONLY a sub-floor valid JSON, so generate == guard exactly.
        // A member the guard would refuse fails LOUD here (never a silently-unsatisfiable manifest
        // -> late read-back FILE_MISSING); this also fails a corrupt required member loud.
        if (carrier.assertMemberEligibility) {
            const { eligible, reason } = isUploadEligible(rel, buf, carrier.uploaderRequiredJson ? { requiredJson: true } : {});
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
    return {
        schema_version: SCHEMA_VERSION,
        carrier_type: ctx.carrierType,
        finalize_run_id: String(ctx.finalizeRunId ?? ''),
        upstream_run_id: String(ctx.upstreamRunId ?? ''),
        producer_job_identity: carrier.producerJob,
        producer_attempt: Number(ctx.producerAttempt ?? 0),
        head_sha: String(ctx.headSha ?? ''),
        exact_staging_prefix: buildStagingPrefix(ctx.carrierType, ctx.finalizeRunId, ctx.producerAttempt),
        created_at_utc: ctx.createdAt || new Date().toISOString(),
        completion_state: COMPLETION_STATE,
        member_count: files.length,
        required_file_classes: requiredClasses,
        file_count: files.length,
        total_bytes: totalBytes,
        files,
        set_sha256: computeSetSha256(files),
    };
}

/** Verify a directory against a manifest. EXACT set equality (extra/missing => fail),
 *  per-file size + sha256, set_sha256, required-class floors + counts. Never count-only. */
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
    // A registry-shaped member in the manifest can never be a legitimate cycle-output
    // member (it would have been excluded at generate); reject a re-bind attempt.
    for (const n of manifestNames) if (carrier.excludeRe && carrier.excludeRe.test(n)) return fail('REGISTRY_DOUBLE_BIND', `registry member forbidden in cycle-output set: ${n}`);
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
    if (Number(manifest.member_count) !== manifest.files.length) return fail('MEMBER_COUNT_MISMATCH', `member_count ${manifest.member_count} != files ${manifest.files.length}`);
    if (computeSetSha256(manifest.files) !== manifest.set_sha256) return fail('SET_HASH_MISMATCH', 'manifest.set_sha256 != recomputed set hash');
    return { ok: true, code: 'OK', reason: 'verified', set_sha256: manifest.set_sha256, file_count: manifest.files.length };
}

/** Verify a run-scoped handoff descriptor's PROVENANCE (no R2). Binds the producing
 *  3/4 finalize run id + producer_attempt (positive int) + head_sha (recorded git sha;
 *  equality enforced only when the consumer supplies an expected value) + the EXACT
 *  staging-prefix derivation (no list-latest / prefix-guess / mutable-latest / fixed /
 *  two-level / foreign cycle). The cross-workflow 4/4 consumer supplies NO runAttempt
 *  and NO headSha (it cannot know the 3/4 head sha). */
export function verifyDescriptor(descriptor, cur) {
    if (!descriptor || typeof descriptor !== 'object') return fail('DESC_MALFORMED', 'descriptor missing/not an object');
    const req = ['carrier_type', 'finalize_run_id', 'producer_attempt', 'exact_staging_prefix', 'manifest_sha256', 'set_sha256', 'head_sha', 'created_at'];
    for (const k of req) if (descriptor[k] === undefined || descriptor[k] === null || descriptor[k] === '') return fail('DESC_FIELD_MISSING', `descriptor.${k} missing`);
    if (!CARRIERS[descriptor.carrier_type]) return fail('CARRIER_UNKNOWN', `carrier_type "${descriptor.carrier_type}"`);
    if (cur.carrierType && descriptor.carrier_type !== cur.carrierType) return fail('DESC_CARRIER_MISMATCH', `descriptor carrier ${descriptor.carrier_type} != expected ${cur.carrierType}`);
    if (!isSha256Hex(descriptor.set_sha256)) return fail('DESC_SET_SHA_INVALID', 'set_sha256 not a sha256');
    if (!isSha256Hex(descriptor.manifest_sha256)) return fail('DESC_MANIFEST_SHA_INVALID', 'manifest_sha256 not a sha256');
    if (!isGitSha(descriptor.head_sha)) return fail('DESC_HEAD_SHA_INVALID', 'head_sha not a 40-hex git sha');
    const pa = Number(descriptor.producer_attempt);
    if (!Number.isInteger(pa) || pa < 1) return fail('DESC_ATTEMPT_INVALID', `producer_attempt ${descriptor.producer_attempt} not a positive int`);
    // Optional same-run bound (omitted for the cross-workflow cycle-output seam):
    // producer_attempt cannot exceed a supplied consuming run attempt.
    if (cur.runAttempt != null && cur.runAttempt !== '') {
        const curAtt = Number(cur.runAttempt);
        if (!Number.isInteger(curAtt) || curAtt < 1) return fail('DESC_CURATTEMPT_INVALID', `current run_attempt ${cur.runAttempt} invalid`);
        if (pa > curAtt) return fail('DESC_ATTEMPT_FUTURE', `producer_attempt ${pa} > current run_attempt ${curAtt}`);
    }
    if (String(descriptor.finalize_run_id) !== String(cur.finalizeRunId)) return fail('DESC_FINALIZE_RUN_MISMATCH', `descriptor finalize_run_id ${descriptor.finalize_run_id} != current ${cur.finalizeRunId}`);
    if (cur.headSha != null && cur.headSha !== '' && String(descriptor.head_sha) !== String(cur.headSha)) return fail('DESC_HEAD_SHA_MISMATCH', `descriptor head_sha ${descriptor.head_sha} != current ${cur.headSha}`);
    const expectPrefix = buildStagingPrefix(descriptor.carrier_type, cur.finalizeRunId, pa);
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
        finalizeRunId: process.env.HANDOFF_FINALIZE_RUN_ID,
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
        const manifest = generateManifest(dir, envCtx(carrierType));
        fs.writeFileSync(out, JSON.stringify(manifest));
        process.stdout.write(`${manifest.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify') {
        const [dir, manifestPath] = positional;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = verifyDirAgainstManifest(dir, manifest);
        if (!res.ok) { console.error(`[CYCLE-OUTPUT-HANDOFF-VERIFY] FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`[CYCLE-OUTPUT-HANDOFF-VERIFY] OK set_sha256=${res.set_sha256} files=${res.file_count}`);
        process.stdout.write(`${res.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify-descriptor') {
        const [descPath] = positional;
        let descriptor;
        try { descriptor = JSON.parse(fs.readFileSync(descPath, 'utf8')); }
        catch (e) { console.error(`[CYCLE-OUTPUT-HANDOFF-DESC] FAIL DESC_UNREADABLE: ${e.message}`); return 1; }
        const res = verifyDescriptor(descriptor, {
            carrierType: carrierType || undefined,
            finalizeRunId: process.env.HANDOFF_FINALIZE_RUN_ID,
            runAttempt: process.env.HANDOFF_RUN_ATTEMPT,
            headSha: process.env.HANDOFF_HEAD_SHA,
        });
        if (!res.ok) { console.error(`[CYCLE-OUTPUT-HANDOFF-DESC] FAIL ${res.code}: ${res.reason}`); return 1; }
        process.stdout.write(`${res.staging_prefix}\t${res.set_sha256}\n`);
        console.error(`[CYCLE-OUTPUT-HANDOFF-DESC] OK staging=${res.staging_prefix} producer_attempt=${res.producer_attempt}`);
        return 0;
    }
    console.error('Usage: cycle-output-handoff-manifest.mjs generate|verify|verify-descriptor <args> --carrier=cycle-output-authority');
    return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', '').replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) { try { process.exit(runCli(process.argv.slice(2))); } catch (e) { console.error(`[CYCLE-OUTPUT-HANDOFF] FATAL ${e.code || ''}: ${e.message}`); process.exit(1); } }
