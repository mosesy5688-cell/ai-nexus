#!/usr/bin/env node
/**
 * VFS-Derived Handoff Manifest — durable, R2-authoritative, attempt-scoped,
 * manifest-last verifier of record for the Factory 4/4 VFS Pack -> VFS Derived
 * seam (PRIMARY: carrier_type "vfs-pack-authority") AND the VFS Derived -> Upload
 * sitemap/RSS seam (SECONDARY: carrier_type "vfs-derived-authority").
 *
 * Authorized under Founder D-2026-0704-245. Binding design record:
 * FREE2AITOOLS_VFS_PACK_DERIVED_HANDOFF_RELIABILITY_IMPLEMENTATION_GATE_PROPOSAL_v1
 * (Option A = exact-producer R2 staging; the fused S1-BR sibling pattern). GHA cache
 * is DEMOTED to verified acceleration; R2 is the correctness authority.
 *
 * PURE module — filesystem + crypto ONLY (no R2, no network, no @aws-sdk). The R2
 * I/O is done by the workflow via the generic r2-workflow-cli.js subcommands
 * (backup-dir / upload-file / restore-dir / delete-prefix / list-prefix). This module
 * only (a) generateManifest(dir,ctx,opts), (b) verifyDirAgainstManifest(dir,manifest,
 * opts) with EXACT set equality + per-file sha + set_sha256 + required-class gates, and
 * (c) verifyDescriptor(descriptor,cur) provenance (run + attempt + head-SHA + version +
 * parent-set binding + exact staging-prefix derivation). Never count-only.
 *
 * Named for the BROADER scope (it covers BOTH the vfs-pack primary carrier consumed by
 * VFS Derived, and the vfs-derived secondary carrier consumed by Final Upload).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isUploadEligible } from './lib/upload-eligibility.js';

export const SCHEMA_VERSION = 1;
export const COMPLETION_STATE = 'complete';
const META_DB_RE = /(^|\/)meta-\d+\.db$/;
// Carrier registry: distinct R2 prefix root + producer job + required file classes.
// A class {name, re, min}: `re` matched on the relative path; `min` is the floor
// (min 0 => empty permitted for that class; the generator contract for RSS).
export const CARRIERS = Object.freeze({
    'vfs-pack-authority': Object.freeze({
        prefixRoot: 'state/_handoff/vfs-pack',
        producerJob: 'vfs-pack-db',
        classes: Object.freeze([{ name: 'meta_db', re: META_DB_RE, min: 1 }]),
        // D-246: RSS-generator inputs are a CAPTURED_IF_PRESENT / FLOOR_ZERO member class
        // carried ALONGSIDE the meta set (recorded separately, NOT in the set hash). Each
        // is staged under `rss-inputs/<...>` when present at produce time; the consumer
        // recovers every DECLARED-PRESENT input BEFORE rss-generator (fail-closed) and
        // SKIPs declared-absent (paused/floor-zero) ones — so a present input can never be
        // silently lost, while the paused/static-historical RSS behavior is preserved.
        rssInputs: Object.freeze([
            Object.freeze({ name: 'reports_index', localPath: 'output/cache/reports/index.json.zst', stagedPath: 'rss-inputs/reports/index.json.zst' }),
            Object.freeze({ name: 'knowledge_index', localPath: 'output/cache/knowledge/index.json.zst', stagedPath: 'rss-inputs/knowledge/index.json.zst' }),
        ]),
    }),
    'vfs-derived-authority': Object.freeze({
        prefixRoot: 'state/_handoff/vfs-derived',
        producerJob: 'vfs-derived',
        // PR-B (D-2026-0706-285): every INCLUDED sitemap/RSS member must be upload-eligible under
        // the SAME predicate the uploader applies (isUploadEligible, DEFAULT opts -- the Final-
        // Upload backup-dir step passes NO --required-json) so the manifest can NEVER enumerate a
        // member the guard refuses (the exact-set read-back FILE_MISSING blocker). Every member is
        // AUTHORITATIVE (sitemap-index/child .xml/.gz + present rss .xml) -> default eligibility;
        // there is NO empty-placeholder/optional class (rss-generator SKIPS-EMPTY, the sitemap
        // index/children are corpus-large), so a sub-floor present member is CORRUPTION -> fail loud.
        // The vfs-pack meta_db carrier deliberately has NO such flag => its generate path is UNCHANGED.
        assertMemberEligibility: true,
        classes: Object.freeze([
            { name: 'sitemap', re: /(^|\/)(sitemap\.xml|sitemaps\/.+)$/, min: 1 },
            { name: 'rss', re: /(^|\/)rss\/.+$/, min: 0 },
        ]),
    }),
});
const SHA256_RE = /^[0-9a-f]{64}$/;
export function isSha256Hex(v) { return typeof v === 'string' && SHA256_RE.test(v); }
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
    const h = crypto.createHash('sha256');
    for (const [rel, sha] of tuples) h.update(`${rel}\u0000${sha}\n`);
    return h.digest('hex');
}

// Reserved sidecar/descriptor basenames that are NEVER part of the carrier set
// (manifest.json is uploaded LAST; handoff.json is the descriptor; _manifest.json is
// backup-dir's own restore sidecar). A path-traversal / absolute member is rejected.
const RESERVED = new Set(['manifest.json', 'handoff.json', '_manifest.json']);
function extMatch(rel, extensions) {
    if (!extensions || extensions.length === 0) return true;
    return extensions.some((e) => rel.endsWith(e));
}

/** Recursively list carrier files under `dir` (posix relative paths), filtered by
 *  optional extensions, excluding the reserved sidecars. Symlinks rejected. */
export function listCarrierFiles(dir, extensions) {
    const out = [];
    const walk = (absDir, relPrefix) => {
        for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
            const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
            const abs = path.join(absDir, e.name);
            if (e.isSymbolicLink()) throw new HandoffManifestError('UNSAFE_MEMBER', `symlink member: ${rel}`);
            if (e.isDirectory()) { walk(abs, rel); continue; }
            if (!e.isFile()) continue;
            if (RESERVED.has(e.name)) continue;
            if (rel.split('/').some((s) => s === '..')) throw new HandoffManifestError('UNSAFE_MEMBER', `traversal member: ${rel}`);
            if (!extMatch(rel, extensions)) continue;
            out.push(rel);
        }
    };
    walk(dir, '');
    return out.sort();
}

function countClasses(files, classes) {
    return classes.map((c) => ({ name: c.name, min: c.min, count: files.filter((f) => c.re.test(f.relative_path)).length }));
}

// Reject absolute + traversal rel paths (reused for the RSS-input local/staged paths so
// the NEW recovery path can never introduce a traversal/symlink escape — D-246 §G/R1-F2).
function assertSafeRel(rel) {
    const r = String(rel).replace(/\\/g, '/');
    if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || r.startsWith('/')) throw new HandoffManifestError('UNSAFE_MEMBER', `absolute path: ${rel}`);
    if (r.split('/').some((s) => s === '..')) throw new HandoffManifestError('UNSAFE_MEMBER', `traversal path: ${rel}`);
    return r;
}

// D-246: probe the carrier's declared RSS inputs under `baseDir`. CAPTURED_IF_PRESENT /
// FLOOR_ZERO — a legitimately-absent input is recorded present:false (NOT an error), so a
// paused/floor-zero input is distinguishable from an unrecovered one. Symlink => reject.
export function probeRssInputs(carrierType, baseDir) {
    const decls = carrierConfig(carrierType).rssInputs || [];
    return decls.map((d) => {
        assertSafeRel(d.localPath); assertSafeRel(d.stagedPath);
        const abs = path.join(baseDir, d.localPath);
        let present = false; let sha256 = null; let sizeBytes = null;
        try {
            const st = fs.lstatSync(abs);
            if (st.isSymbolicLink()) throw new HandoffManifestError('UNSAFE_MEMBER', `rss input symlink: ${d.localPath}`);
            if (st.isFile()) { present = true; sizeBytes = st.size; sha256 = sha256File(abs); }
        } catch (e) { if (e instanceof HandoffManifestError) throw e; /* ENOENT => legitimately absent */ }
        return { name: d.name, local_path: d.localPath, staged_path: d.stagedPath, present, size_bytes: sizeBytes, sha256 };
    });
}

// D-246: the recovery plan the consumer restores BEFORE rss-generator = ONLY the
// DECLARED-PRESENT inputs (absent ones are skipped/recorded). Each entry is safe-checked.
export function rssRecoveryPlan(manifest) {
    const decl = Array.isArray(manifest.rss_inputs) ? manifest.rss_inputs : [];
    return decl.filter((e) => e && e.present).map((e) => {
        assertSafeRel(e.staged_path); assertSafeRel(e.local_path);
        return { staged_path: e.staged_path, local_path: e.local_path, sha256: e.sha256 };
    });
}

// D-246 §C 6-state fail-closed verify of the RECOVERED RSS inputs against the manifest:
//   present:true  -> file must exist under recoverBaseDir + sha256 == manifest (states 3/4/
//                    6/7/8 => fail-closed: missing recovery OR stale predecessor content);
//   present:false -> SKIP, recorded (states 1/5: paused/floor-zero, non-fatal).
export function verifyRssInputs(manifest, recoverBaseDir) {
    const decl = Array.isArray(manifest.rss_inputs) ? manifest.rss_inputs : [];
    const recovered = []; const skipped = [];
    for (const e of decl) {
        if (!e || typeof e !== 'object' || !e.name) return fail('RSS_INPUT_MALFORMED', 'rss_inputs entry malformed');
        assertSafeRel(e.staged_path); assertSafeRel(e.local_path);
        if (!e.present) { skipped.push(e.name); continue; }
        if (!isSha256Hex(e.sha256)) return fail('RSS_INPUT_SHA_INVALID', `${e.name} declared present without a sha256`);
        const abs = path.join(recoverBaseDir, e.local_path);
        let st;
        try { st = fs.lstatSync(abs); } catch { return fail('RSS_INPUT_MISSING', `declared-present rss input not recovered: ${e.name}`); }
        if (st.isSymbolicLink()) return fail('UNSAFE_MEMBER', `rss input symlink: ${e.name}`);
        if (!st.isFile() || sha256File(abs) !== e.sha256) return fail('RSS_INPUT_HASH_MISMATCH', `rss input ${e.name} sha != manifest (missing/stale predecessor)`);
        recovered.push(e.name);
    }
    return { ok: true, code: 'OK', reason: 'rss-inputs-verified', recovered, skipped };
}

/** Build the manifest for a carrier directory. `ctx` carries run provenance (not
 *  derived from disk). Enforces each required class floor at generate time. */
export function generateManifest(dir, ctx = {}, opts = {}) {
    const carrier = carrierConfig(ctx.carrierType);
    const names = listCarrierFiles(dir, opts.extensions);
    const files = [];
    let totalBytes = 0;
    for (const rel of names) {
        const abs = path.join(dir, rel);
        // PR-B (D-2026-0706-285): assert the SECONDARY (sitemap/RSS) carrier's members are upload-
        // eligible under the uploader's DEFAULT predicate (no --required-json) so generate == guard
        // by construction. A member the guard would refuse (a sub-256B .xml/.gz -- e.g. a degenerate
        // single-child sitemap index -- or a sub-16B/no-magic .zst) fails LOUD MEMBER_UPLOAD_INELIGIBLE
        // here, never a late read-back FILE_MISSING. Gated on the carrier flag => the vfs-pack meta_db
        // carrier (no flag) keeps its exact byte-identical statSync+sha256File path (D-245 unregressed).
        if (carrier.assertMemberEligibility) {
            const { eligible, reason } = isUploadEligible(rel, fs.readFileSync(abs));
            if (!eligible) throw new HandoffManifestError('MEMBER_UPLOAD_INELIGIBLE', `included member ${rel} upload-ineligible: ${reason}`);
        }
        const size = fs.statSync(abs).size;
        files.push({ relative_path: rel, size_bytes: size, sha256: sha256File(abs) });
        totalBytes += size;
    }
    const requiredClasses = countClasses(files, carrier.classes);
    for (const rc of requiredClasses) {
        if (rc.count < rc.min) throw new HandoffManifestError('REQUIRED_CLASS_BELOW_FLOOR', `class ${rc.name}: ${rc.count} < min ${rc.min}`);
    }
    const metaDbCount = files.filter((f) => META_DB_RE.test(f.relative_path)).length;
    // D-246: RSS-generator inputs recorded per-input (present + sha) ALONGSIDE — never
    // folded into the meta `files`/`set_sha256`. `rssBaseDir` locates them (default cwd).
    const rssInputs = carrier.rssInputs ? probeRssInputs(ctx.carrierType, opts.rssBaseDir ?? '.') : null;
    return {
        schema_version: SCHEMA_VERSION,
        carrier_type: ctx.carrierType,
        upstream_3_4_run_id: String(ctx.upstreamRunId ?? ''),
        factory_4_4_run_id: String(ctx.factoryRunId ?? ''),
        factory_4_4_run_attempt: Number(ctx.producerAttempt ?? 0),
        producer_job_identity: carrier.producerJob,
        producer_attempt: Number(ctx.producerAttempt ?? 0),
        head_sha: String(ctx.headSha ?? ''),
        vfs_pack_code_version: String(ctx.vfsPackCodeVersion ?? ''),
        parent_set_sha256: ctx.parentSetSha ? String(ctx.parentSetSha) : null,
        exact_staging_prefix: buildStagingPrefix(ctx.carrierType, ctx.upstreamRunId, ctx.factoryRunId, ctx.producerAttempt),
        created_at_utc: ctx.createdAt || new Date().toISOString(),
        completion_state: COMPLETION_STATE,
        meta_db_count: metaDbCount,
        required_file_classes: requiredClasses,
        ...(rssInputs ? { rss_inputs: rssInputs } : {}),
        file_count: files.length,
        total_bytes: totalBytes,
        files,
        set_sha256: computeSetSha256(files),
    };
}

export function buildStagingPrefix(carrierType, upstreamRunId, factoryRunId, attempt) {
    const root = carrierConfig(carrierType).prefixRoot;
    return `${root}/${upstreamRunId}/${factoryRunId}/attempt-${attempt}/`;
}

/** Verify a directory against a manifest. EXACT set equality (extra/missing => fail),
 *  per-file size + sha256, set_sha256, required-class floors + counts. Never count-only. */
export function verifyDirAgainstManifest(dir, manifest, opts = {}) {
    if (!manifest || typeof manifest !== 'object') return fail('MANIFEST_MALFORMED', 'manifest missing/not an object');
    if (!CARRIERS[manifest.carrier_type]) return fail('CARRIER_UNKNOWN', `carrier_type "${manifest.carrier_type}"`);
    if (!Array.isArray(manifest.files)) return fail('MANIFEST_MALFORMED', 'manifest.files not an array');
    if (Object.prototype.hasOwnProperty.call(manifest, 'manifest_sha256')) return fail('MANIFEST_SELF_HASH', 'manifest must NOT carry its own hash');
    const carrier = carrierConfig(manifest.carrier_type);

    let actualNames;
    try { actualNames = new Set(listCarrierFiles(dir, opts.extensions)); }
    catch (e) { return fail(e.code || 'UNSAFE_MEMBER', e.message); }
    const manifestNames = new Set(manifest.files.map((f) => f.relative_path));
    for (const n of manifestNames) if (!actualNames.has(n)) return fail('FILE_MISSING', `manifest file absent on disk: ${n}`);
    for (const n of actualNames) if (!manifestNames.has(n)) return fail('FILE_EXTRA', `disk file not in manifest: ${n}`);

    for (const f of manifest.files) {
        if (String(f.relative_path).split('/').some((s) => s === '..')) return fail('UNSAFE_MEMBER', `traversal member: ${f.relative_path}`);
        const abs = path.join(dir, f.relative_path);
        const size = fs.statSync(abs).size;
        if (size !== Number(f.size_bytes)) return fail('SIZE_MISMATCH', `size mismatch ${f.relative_path}: disk ${size} != manifest ${f.size_bytes}`);
        if (!isSha256Hex(f.sha256) || sha256File(abs) !== f.sha256) return fail('HASH_MISMATCH', `sha256 mismatch ${f.relative_path}`);
    }
    // required-class floors + count-agreement (a partial meta set => below floor).
    const recomputed = countClasses(manifest.files, carrier.classes);
    const declared = Array.isArray(manifest.required_file_classes) ? manifest.required_file_classes : [];
    for (const rc of recomputed) {
        if (rc.count < rc.min) return fail('REQUIRED_CLASS_BELOW_FLOOR', `class ${rc.name}: ${rc.count} < min ${rc.min}`);
        const d = declared.find((x) => x && x.name === rc.name);
        if (!d || Number(d.count) !== rc.count) return fail('REQUIRED_CLASS_COUNT_MISMATCH', `class ${rc.name}: manifest ${d && d.count} != disk ${rc.count}`);
    }
    const metaDbCount = manifest.files.filter((f) => META_DB_RE.test(f.relative_path)).length;
    if (Number(manifest.meta_db_count) !== metaDbCount) return fail('META_COUNT_MISMATCH', `meta_db_count ${manifest.meta_db_count} != disk ${metaDbCount}`);
    if (computeSetSha256(manifest.files) !== manifest.set_sha256) return fail('SET_HASH_MISMATCH', 'manifest.set_sha256 != recomputed set hash');
    return { ok: true, code: 'OK', reason: 'verified', set_sha256: manifest.set_sha256, file_count: manifest.files.length, meta_db_count: metaDbCount };
}

/** Verify a run-scoped handoff descriptor's PROVENANCE (no R2). Binds current
 *  upstream + factory run + producer_attempt (positive int <= current run_attempt) +
 *  head-SHA + vfs_pack_code_version (+ parent_set_sha for the secondary carrier) +
 *  the exact staging-prefix derivation (no list-latest / prefix-guess / prior-run). */
export function verifyDescriptor(descriptor, cur) {
    if (!descriptor || typeof descriptor !== 'object') return fail('DESC_MALFORMED', 'descriptor missing/not an object');
    const req = ['carrier_type', 'producer_attempt', 'exact_staging_prefix', 'manifest_sha256', 'set_sha256', 'upstream_run_id', 'factory_run_id', 'head_sha', 'created_at'];
    for (const k of req) if (descriptor[k] === undefined || descriptor[k] === null || descriptor[k] === '') return fail('DESC_FIELD_MISSING', `descriptor.${k} missing`);
    if (!CARRIERS[descriptor.carrier_type]) return fail('CARRIER_UNKNOWN', `carrier_type "${descriptor.carrier_type}"`);
    if (cur.carrierType && descriptor.carrier_type !== cur.carrierType) return fail('DESC_CARRIER_MISMATCH', `descriptor carrier ${descriptor.carrier_type} != expected ${cur.carrierType}`);
    if (!isSha256Hex(descriptor.set_sha256)) return fail('DESC_SET_SHA_INVALID', 'set_sha256 not a sha256');
    if (!isSha256Hex(descriptor.manifest_sha256)) return fail('DESC_MANIFEST_SHA_INVALID', 'manifest_sha256 not a sha256');
    const pa = Number(descriptor.producer_attempt);
    const curAtt = Number(cur.runAttempt);
    if (!Number.isInteger(pa) || pa < 1) return fail('DESC_ATTEMPT_INVALID', `producer_attempt ${descriptor.producer_attempt} not a positive int`);
    if (!Number.isInteger(curAtt) || curAtt < 1) return fail('DESC_CURATTEMPT_INVALID', `current run_attempt ${cur.runAttempt} invalid`);
    if (pa > curAtt) return fail('DESC_ATTEMPT_FUTURE', `producer_attempt ${pa} > current run_attempt ${curAtt}`);
    if (String(descriptor.upstream_run_id) !== String(cur.upstreamRunId)) return fail('DESC_UPSTREAM_MISMATCH', `descriptor upstream ${descriptor.upstream_run_id} != current ${cur.upstreamRunId}`);
    if (String(descriptor.factory_run_id) !== String(cur.factoryRunId)) return fail('DESC_RUN_MISMATCH', `descriptor factory run ${descriptor.factory_run_id} != current ${cur.factoryRunId}`);
    if (cur.headSha != null && cur.headSha !== '' && String(descriptor.head_sha) !== String(cur.headSha)) return fail('DESC_HEAD_SHA_MISMATCH', `descriptor head_sha ${descriptor.head_sha} != current ${cur.headSha}`);
    if (cur.vfsPackCodeVersion != null && cur.vfsPackCodeVersion !== '' && String(descriptor.vfs_pack_code_version) !== String(cur.vfsPackCodeVersion)) return fail('DESC_VERSION_MISMATCH', `descriptor version ${descriptor.vfs_pack_code_version} != current ${cur.vfsPackCodeVersion}`);
    if (cur.parentSetSha != null && cur.parentSetSha !== '' && String(descriptor.parent_set_sha256) !== String(cur.parentSetSha)) return fail('DESC_PARENT_SET_MISMATCH', `descriptor parent_set ${descriptor.parent_set_sha256} != current ${cur.parentSetSha}`);
    const expectPrefix = buildStagingPrefix(descriptor.carrier_type, cur.upstreamRunId, cur.factoryRunId, pa);
    if (String(descriptor.exact_staging_prefix) !== expectPrefix) return fail('DESC_PREFIX_MISMATCH', `exact_staging_prefix ${descriptor.exact_staging_prefix} != derived ${expectPrefix}`);
    return { ok: true, code: 'OK', reason: 'descriptor-verified', staging_prefix: expectPrefix, producer_attempt: pa, set_sha256: descriptor.set_sha256 };
}

// ============================================================================
// AUTHORITY-W (warm_read) — Founder VFS_PRODUCER_ARTIFACT_EXACT_CYCLE_AUTHORITY_4_OF_4.
// A STRICTLY ADDITIVE sibling of the meta_db authority: a SEPARATE warm-read-manifest.json
// (own set_sha256) over the shared warm-read producer artifacts (vector-core.bin,
// hot-shard.bin, id-index.bin, term_index/**) staged into the SAME vfs-pack attempt
// prefix. The meta_db manifest.json + its set_sha256 stay BYTE-IDENTICAL (D-245/FIX-4
// unregressed); the descriptor gains ONLY additive warm_read_set_sha256 + member count.
// warm_read NEVER carries a .db member (that is the meta_db authority — no double-bind).
// ============================================================================
export const WARM_READ_MEMBER_CLASS = 'warm_read';
// Exact membership of the warm_read set, output/data-relative. A file is a warm_read
// member IFF it matches this (the 3 named bins OR anything under term_index/). meta-*.db /
// rankings-*.db + any stray bin (e.g. cluster-ann-index.bin) are NOT matched => ignored.
const WARM_READ_INCLUDE_RE = /^(vector-core\.bin|hot-shard\.bin|id-index\.bin|term_index\/.+)$/;
const DB_MEMBER_RE = /\.db$/;
// Required-class floors. term_index_bucket matches BOTH the per-prefix _bucket.json.zst
// AND high-freq <term>_<i>.json.zst chunks (any file inside a term_index prefix subdir);
// the top-level term_index/_manifest.json.zst is the manifest class (no prefix subdir).
export const WARM_READ_CLASSES = Object.freeze([
    { name: 'vector_core', re: /^vector-core\.bin$/, min: 1 },
    { name: 'hot_shard', re: /^hot-shard\.bin$/, min: 1 },
    { name: 'id_index', re: /^id-index\.bin$/, min: 1 },
    { name: 'term_index_manifest', re: /^term_index\/_manifest\.json\.zst$/, min: 1 },
    { name: 'term_index_bucket', re: /^term_index\/[^/]+\/.+\.json\.zst$/, min: 2 },
]);

/** List warm_read members under `dir` (posix relative paths). INCLUDE-filtered (never
 *  .db), reserved sidecars excluded, symlink/traversal rejected. */
export function listWarmReadFiles(dir) {
    const out = [];
    const walk = (absDir, relPrefix) => {
        let entries;
        try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
            const abs = path.join(absDir, e.name);
            if (e.isSymbolicLink()) throw new HandoffManifestError('UNSAFE_MEMBER', `symlink member: ${rel}`);
            if (e.isDirectory()) { walk(abs, rel); continue; }
            if (!e.isFile()) continue;
            if (RESERVED.has(e.name)) continue;
            if (rel.split('/').some((s) => s === '..')) throw new HandoffManifestError('UNSAFE_MEMBER', `traversal member: ${rel}`);
            if (!WARM_READ_INCLUDE_RE.test(rel)) continue;
            out.push(rel);
        }
    };
    walk(dir, '');
    return out.sort();
}

/** Build the warm_read sibling manifest over `dir` (output/data/). Enforces the
 *  warm_read class floors at generate. Provenance from `ctx` (NOT disk-derived). */
export function generateWarmReadManifest(dir, ctx = {}) {
    if (ctx.carrierType && ctx.carrierType !== 'vfs-pack-authority') throw new HandoffManifestError('CARRIER_UNKNOWN', `warm_read requires carrier vfs-pack-authority, got ${ctx.carrierType}`);
    const names = listWarmReadFiles(dir);
    const files = [];
    let totalBytes = 0;
    for (const rel of names) {
        const abs = path.join(dir, rel);
        // PR-B (D-2026-0706-285): AUTH-W warm-read. Every INCLUDED member must be upload-eligible
        // under the SAME predicate the uploader applies (isUploadEligible, DEFAULT opts -- the two
        // producer backup-dir steps pass NO --required-json) so generate == guard by construction.
        // The 3 bins face the 256B non-.zst floor (vector/hot/id producers early-return with NO file
        // on an empty corpus -> the class floor, not eligibility, catches emptiness; a present bin is
        // corpus-large at 550K steady state); term_index/** .json.zst face the 16B+zstd-magic floor
        // (the builder NEVER emits an empty-{} frame -- every bucket carries >=1 term, every high-freq
        // chunk carries real postings, the manifest always has content -- so there is NO empty-
        // placeholder class). A member the guard would refuse (a degenerate sub-256B bin OR a sub-16B/
        // no-magic term_index frame -- both CORRUPTION, never producer-legit) fails LOUD
        // MEMBER_UPLOAD_INELIGIBLE here, never a late read-back FILE_MISSING.
        const buf = fs.readFileSync(abs);
        const { eligible, reason } = isUploadEligible(rel, buf);
        if (!eligible) throw new HandoffManifestError('MEMBER_UPLOAD_INELIGIBLE', `warm_read member ${rel} upload-ineligible: ${reason}`);
        const size = buf.length;
        files.push({ relative_path: rel, size_bytes: size, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
        totalBytes += size;
    }
    const requiredClasses = countClasses(files, WARM_READ_CLASSES);
    for (const rc of requiredClasses) {
        if (rc.count < rc.min) throw new HandoffManifestError('REQUIRED_CLASS_BELOW_FLOOR', `warm_read class ${rc.name}: ${rc.count} < min ${rc.min}`);
    }
    return {
        schema_version: SCHEMA_VERSION,
        carrier_type: 'vfs-pack-authority',
        member_class: WARM_READ_MEMBER_CLASS,
        upstream_3_4_run_id: String(ctx.upstreamRunId ?? ''),
        factory_4_4_run_id: String(ctx.factoryRunId ?? ''),
        factory_4_4_run_attempt: Number(ctx.producerAttempt ?? 0),
        producer_job_identity: 'vfs-pack-db',
        producer_attempt: Number(ctx.producerAttempt ?? 0),
        head_sha: String(ctx.headSha ?? ''),
        vfs_pack_code_version: String(ctx.vfsPackCodeVersion ?? ''),
        exact_staging_prefix: buildStagingPrefix('vfs-pack-authority', ctx.upstreamRunId, ctx.factoryRunId, ctx.producerAttempt),
        created_at_utc: ctx.createdAt || new Date().toISOString(),
        completion_state: COMPLETION_STATE,
        required_file_classes: requiredClasses,
        member_count: files.length,
        total_bytes: totalBytes,
        files,
        set_sha256: computeSetSha256(files),
    };
}

/** Verify a directory against a warm_read manifest. EXACT set equality (via the
 *  warm_read INCLUDE filter — never .db), per-file size + sha256, set_sha256, class
 *  floors + count agreement, member_count. No-double-bind: a .db member is rejected. */
export function verifyWarmReadDir(dir, manifest) {
    if (!manifest || typeof manifest !== 'object') return fail('MANIFEST_MALFORMED', 'manifest missing/not an object');
    if (manifest.carrier_type !== 'vfs-pack-authority' || manifest.member_class !== WARM_READ_MEMBER_CLASS) return fail('WARM_READ_CARRIER_MISMATCH', `not a warm_read manifest (${manifest.carrier_type}/${manifest.member_class})`);
    if (!Array.isArray(manifest.files)) return fail('MANIFEST_MALFORMED', 'manifest.files not an array');
    if (Object.prototype.hasOwnProperty.call(manifest, 'manifest_sha256')) return fail('MANIFEST_SELF_HASH', 'manifest must NOT carry its own hash');
    let actualNames;
    try { actualNames = new Set(listWarmReadFiles(dir)); }
    catch (e) { return fail(e.code || 'UNSAFE_MEMBER', e.message); }
    const manifestNames = new Set(manifest.files.map((f) => f.relative_path));
    for (const n of manifestNames) if (DB_MEMBER_RE.test(n)) return fail('WARM_READ_DB_DOUBLE_BIND', `db member forbidden in warm_read set: ${n}`);
    for (const n of manifestNames) if (!WARM_READ_INCLUDE_RE.test(n)) return fail('WARM_READ_FOREIGN_MEMBER', `non-warm_read member in manifest: ${n}`);
    for (const n of manifestNames) if (!actualNames.has(n)) return fail('FILE_MISSING', `manifest file absent on disk: ${n}`);
    for (const n of actualNames) if (!manifestNames.has(n)) return fail('FILE_EXTRA', `disk warm_read file not in manifest: ${n}`);
    for (const f of manifest.files) {
        if (String(f.relative_path).split('/').some((s) => s === '..')) return fail('UNSAFE_MEMBER', `traversal member: ${f.relative_path}`);
        const abs = path.join(dir, f.relative_path);
        const size = fs.statSync(abs).size;
        if (size !== Number(f.size_bytes)) return fail('SIZE_MISMATCH', `size mismatch ${f.relative_path}: disk ${size} != manifest ${f.size_bytes}`);
        if (!isSha256Hex(f.sha256) || sha256File(abs) !== f.sha256) return fail('HASH_MISMATCH', `sha256 mismatch ${f.relative_path}`);
    }
    const recomputed = countClasses(manifest.files, WARM_READ_CLASSES);
    const declared = Array.isArray(manifest.required_file_classes) ? manifest.required_file_classes : [];
    for (const rc of recomputed) {
        if (rc.count < rc.min) return fail('REQUIRED_CLASS_BELOW_FLOOR', `warm_read class ${rc.name}: ${rc.count} < min ${rc.min}`);
        const d = declared.find((x) => x && x.name === rc.name);
        if (!d || Number(d.count) !== rc.count) return fail('REQUIRED_CLASS_COUNT_MISMATCH', `warm_read class ${rc.name}: manifest ${d && d.count} != disk ${rc.count}`);
    }
    if (Number(manifest.member_count) !== manifest.files.length) return fail('MEMBER_COUNT_MISMATCH', `member_count ${manifest.member_count} != files ${manifest.files.length}`);
    if (computeSetSha256(manifest.files) !== manifest.set_sha256) return fail('SET_HASH_MISMATCH', 'manifest.set_sha256 != recomputed set hash');
    return { ok: true, code: 'OK', reason: 'warm-read-verified', set_sha256: manifest.set_sha256, member_count: manifest.files.length };
}

// ============================================================================
// PUBLICATION-FAMILY CLOSURE GATE (Final Upload, BEFORE R2 publish). Asserts the
// three resolved descriptors (vfs-pack meta+warm_read, mesh-profile, vfs-derived
// secondary) belong to ONE 4/4 cycle-family on ONE code head. Fail-closed: any
// divergence => the caller must NOT run Final Upload. Pure data check (no R2/fs).
// ============================================================================
export function publicationFamilyGate(d) {
    for (const k of ['vfsPack', 'meshProfile', 'vfsDerived']) {
        if (!d || !d[k] || typeof d[k] !== 'object') return fail('FAMILY_DESC_MISSING', `${k} descriptor missing`);
    }
    const vp = d.vfsPack, mp = d.meshProfile, vd = d.vfsDerived;
    const same = (a, b, c) => String(a) === String(b) && String(a) === String(c);
    if (!same(vp.upstream_run_id, mp.upstream_run_id, vd.upstream_run_id)) return fail('FAMILY_UPSTREAM_DIVERGENT', `upstream_run_id divergent: vfsPack=${vp.upstream_run_id} mesh=${mp.upstream_run_id} derived=${vd.upstream_run_id}`);
    if (!same(vp.factory_run_id, mp.factory_run_id, vd.factory_run_id)) return fail('FAMILY_RUN_DIVERGENT', `factory_run_id divergent: vfsPack=${vp.factory_run_id} mesh=${mp.factory_run_id} derived=${vd.factory_run_id}`);
    if (!same(vp.head_sha, mp.head_sha, vd.head_sha)) return fail('FAMILY_HEAD_DIVERGENT', `head_sha divergent: vfsPack=${vp.head_sha} mesh=${mp.head_sha} derived=${vd.head_sha}`);
    if (!isSha256Hex(vp.set_sha256)) return fail('FAMILY_META_SET_ABSENT', 'vfsPack meta set_sha256 absent/invalid');
    if (String(vd.parent_set_sha256) !== String(vp.set_sha256)) return fail('FAMILY_PARENT_CHAIN_BROKEN', `vfs-derived parent_set_sha256 ${vd.parent_set_sha256} != vfs-pack meta set_sha256 ${vp.set_sha256}`);
    if (!isSha256Hex(vp.warm_read_set_sha256)) return fail('FAMILY_WARM_READ_ABSENT', 'warm_read_set_sha256 absent/invalid on the vfs-pack descriptor');
    if (!isSha256Hex(mp.set_sha256)) return fail('FAMILY_MESH_SET_ABSENT', 'mesh-profile set_sha256 absent/invalid');
    if (!isSha256Hex(mp.dict_sha256)) return fail('FAMILY_MESH_DICT_ABSENT', 'mesh-profile dict_sha256 absent/invalid');
    return { ok: true, code: 'OK', reason: 'family-coherent', upstream_run_id: String(vp.upstream_run_id), factory_run_id: String(vp.factory_run_id), head_sha: String(vp.head_sha) };
}

// ============================================================================
// CLI: generate | verify | verify-descriptor. Provenance via env; carrier + ext
// via --carrier=/--ext=. Consumer jobs use all three.
// ============================================================================
function parseFlag(argv, name) { const a = (argv || []).find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ''; }
function envCtx(carrierType) {
    return {
        carrierType,
        upstreamRunId: process.env.HANDOFF_UPSTREAM_RUN_ID,
        factoryRunId: process.env.HANDOFF_FACTORY_RUN_ID,
        producerAttempt: process.env.HANDOFF_PRODUCER_ATTEMPT,
        headSha: process.env.HANDOFF_HEAD_SHA,
        vfsPackCodeVersion: process.env.HANDOFF_VFS_PACK_CODE_VERSION,
        parentSetSha: process.env.HANDOFF_PARENT_SET_SHA,
    };
}
function extsFrom(argv) { const e = parseFlag(argv, 'ext'); return e ? e.split(',') : null; }

function runCli(argv) {
    const [cmd, ...rest] = argv;
    const positional = rest.filter((a) => !a.startsWith('--'));
    const carrierType = parseFlag(rest, 'carrier');
    const extensions = extsFrom(rest);
    const rssBaseDir = parseFlag(rest, 'rss-base') || '.';
    if (cmd === 'generate') {
        const [dir, out] = positional;
        const manifest = generateManifest(dir, envCtx(carrierType), { extensions, rssBaseDir });
        fs.writeFileSync(out, JSON.stringify(manifest));
        process.stdout.write(`${manifest.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'rss-recovery-plan') {
        // Emit ONLY the declared-present inputs as TSV (staged_path\tlocal_path\tsha256).
        // The workflow restore-files each from the exact staging BEFORE rss-generator.
        const manifest = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
        for (const p of rssRecoveryPlan(manifest)) process.stdout.write(`${p.staged_path}\t${p.local_path}\t${p.sha256}\n`);
        return 0;
    }
    if (cmd === 'verify-rss-inputs') {
        const manifest = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
        const res = verifyRssInputs(manifest, positional[1] || '.');
        if (!res.ok) { console.error(`[VFS-HANDOFF-RSS] FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`[VFS-HANDOFF-RSS] OK recovered=[${res.recovered.join(',')}] skipped=[${res.skipped.join(',')}]`);
        return 0;
    }
    if (cmd === 'generate-warm-read') {
        const [dir, out] = positional;
        const manifest = generateWarmReadManifest(dir, envCtx(carrierType || 'vfs-pack-authority'));
        fs.writeFileSync(out, JSON.stringify(manifest));
        process.stdout.write(`${manifest.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify-warm-read') {
        const [dir, manifestPath] = positional;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = verifyWarmReadDir(dir, manifest);
        if (!res.ok) { console.error(`[WARM-READ-VERIFY] FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`[WARM-READ-VERIFY] OK set_sha256=${res.set_sha256} members=${res.member_count}`);
        process.stdout.write(`${res.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'family-gate') {
        // family-gate <vfsPackDesc> <meshProfileDesc> <vfsDerivedDesc>. Emits the
        // coherent family identity on pass; exits 1 fail-closed on any divergence.
        const [vpP, mpP, vdP] = positional;
        let vp; let mp; let vd;
        try { vp = JSON.parse(fs.readFileSync(vpP, 'utf8')); mp = JSON.parse(fs.readFileSync(mpP, 'utf8')); vd = JSON.parse(fs.readFileSync(vdP, 'utf8')); }
        catch (e) { console.error(`[PUBLICATION-FAMILY] FAIL DESC_UNREADABLE: ${e.message}`); return 1; }
        const res = publicationFamilyGate({ vfsPack: vp, meshProfile: mp, vfsDerived: vd });
        if (!res.ok) { console.error(`[PUBLICATION-FAMILY] FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`[PUBLICATION-FAMILY] OK upstream=${res.upstream_run_id} factory=${res.factory_run_id} head=${res.head_sha}`);
        return 0;
    }
    if (cmd === 'verify') {
        const [dir, manifestPath] = positional;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = verifyDirAgainstManifest(dir, manifest, { extensions });
        if (!res.ok) { console.error(`[VFS-HANDOFF-VERIFY] FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`[VFS-HANDOFF-VERIFY] OK set_sha256=${res.set_sha256} files=${res.file_count} meta=${res.meta_db_count}`);
        process.stdout.write(`${res.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify-descriptor') {
        const [descPath] = positional;
        let descriptor;
        try { descriptor = JSON.parse(fs.readFileSync(descPath, 'utf8')); }
        catch (e) { console.error(`[VFS-HANDOFF-DESC] FAIL DESC_UNREADABLE: ${e.message}`); return 1; }
        const res = verifyDescriptor(descriptor, {
            carrierType: carrierType || undefined,
            upstreamRunId: process.env.HANDOFF_UPSTREAM_RUN_ID,
            factoryRunId: process.env.HANDOFF_FACTORY_RUN_ID,
            runAttempt: process.env.HANDOFF_RUN_ATTEMPT,
            headSha: process.env.HANDOFF_HEAD_SHA,
            vfsPackCodeVersion: process.env.HANDOFF_VFS_PACK_CODE_VERSION,
            parentSetSha: process.env.HANDOFF_PARENT_SET_SHA,
        });
        if (!res.ok) { console.error(`[VFS-HANDOFF-DESC] FAIL ${res.code}: ${res.reason}`); return 1; }
        process.stdout.write(`${res.staging_prefix}\t${res.set_sha256}\n`);
        console.error(`[VFS-HANDOFF-DESC] OK staging=${res.staging_prefix} producer_attempt=${res.producer_attempt}`);
        return 0;
    }
    console.error('Usage: vfs-derived-handoff-manifest.mjs generate|verify|verify-descriptor|rss-recovery-plan|verify-rss-inputs|generate-warm-read|verify-warm-read|family-gate <args> --carrier=<vfs-pack-authority|vfs-derived-authority> [--ext=.db] [--rss-base=.]');
    return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', '').replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) { try { process.exit(runCli(process.argv.slice(2))); } catch (e) { console.error(`[VFS-HANDOFF] FATAL ${e.code || ''}: ${e.message}`); process.exit(1); } }
