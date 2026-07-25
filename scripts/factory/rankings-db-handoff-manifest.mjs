#!/usr/bin/env node
/**
 * Rankings-DB Handoff Manifest -- durable, R2-authoritative, attempt-scoped,
 * manifest-last verifier of record for BOTH rankings cross-stage seams:
 *
 *   SEAM_A  carrier "rankings-satellite"  3/4 `aggregate-rankings` -> 3/4 `finalize`
 *   SEAM_B  carrier "rankings-db"         3/4 `finalize`           -> 4/4 `vfs-pack-db`
 *
 * WHY TWO CARRIERS / TWO DESCRIPTORS: a single descriptor cannot bind both seams --
 * the producer JOBS differ, and the 4/4 consumer resolves the 3/4 run id separately
 * (via check-upstream upstream-run-id) while the finalize consumer is in the SAME run
 * as its producer. One descriptor per seam keeps each binding exact.
 *
 * ROOT CAUSE THIS CLOSES: the 10 `rankings-<group>.db` never reached the 4/4 packer
 * unless the GHA cache carried them (`cycle-<run>-output`), and the GHA cache is
 * 100% WRITE-DENIED on this repo ("cache write denied: token has no writable scopes"),
 * so 4/4 saw ZERO rankings DBs and `manifest.partitions.rankings_dbs` was never set
 * -> `POST /api/v1/select` 503. The old 3/4 recovery read a MUTABLE FIXED prefix
 * (`state/satellite-rankings/*`) with every restore `|| true` and a count-only echo:
 * cross-cycle overwritable, unversioned, identity-free, fail-silent. R2 exact staging
 * is now the ONLY correctness path; the GHA cache and the fixed prefix are
 * NON-AUTHORITATIVE accelerators/diagnostics that must pass the SAME identity+hash
 * verification against this descriptor's manifest or be discarded.
 *
 * PURE module -- filesystem + crypto ONLY (no R2, no network, no @aws-sdk, no SQLite).
 * All R2 I/O is done by the workflow via the GENERIC BYTE-FROZEN r2-workflow-cli.js
 * subcommands (backup-dir / upload-file / restore-dir / restore-file). The SQLite
 * integrity/identity check set lives in ./lib/rankings-db-verifier.js and is reached
 * ONLY from the CLI (`verify-dbs` / `verify-publication`) via a lazy import, so the
 * manifest/descriptor core stays dependency-free for hermetic tests.
 *
 * `.mjs` is CES Art 5.1 line-limit EXEMPT (scripts/check_compliance.py SCAN_EXTENSIONS
 * excludes .mjs), like cycle-output-handoff-manifest.mjs / vfs-derived-handoff-manifest.mjs.
 *
 * Structurally modelled on cycle-output-handoff-manifest.mjs (BYTE-FROZEN: its
 * INVARIANT_REGISTRY row pins "output/data/ is NEVER a member (4/4-owned)" and its
 * memberRoots is [{dir:'cache'}] by design, so it can NEVER carry rankings DBs) --
 * same field names, same machine codes, same commit-last ordering, so operators see
 * ONE consistent handoff contract across carriers.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isUploadEligible } from './lib/upload-eligibility.js';
import { RANKINGS_DB_COUNT, RANKINGS_DB_NAMES } from '../../src/constants/rankings-groups.js';

export const SCHEMA_VERSION = 1;
export const COMPLETION_STATE = 'complete';

// EXPLICIT MEMBERSHIP CLASSES (mirrors the cycle-output A5 hybrid):
//   * 'rankings_db'   (INCLUDE) -- data/rankings-<group>.db, the publication payload.
//   * 'optional'      (EXCLUDE) -- smart-writer `<payload>.meta.json` MD5 checksum
//                      sidecars. Regenerable, zero serve/4-4 readers, produce-time only.
//   * 'authoritative' (INCLUDE) -- any other JSON-family cache member (the ranking
//                      page JSONs + category_stats).
//   * anything else -> UNCLASSIFIED_MEMBER, fail LOUD (never silently included).
const DB_MEMBER_RE = /^data\/rankings-[a-z0-9-]+\.db$/;
const META_SIDECAR_RE = /\.meta\.json$/;
const CACHE_SHAPE_RE = /^cache\/.+\.(zst|gz|json|jsonl|ndjson)$/;
const EXCLUDED_CLASSES = new Set(['optional']);

/** Resolve a walked member (relative posix path) to exactly ONE class, or throw. */
export function classifyRankingsMember(rel) {
    if (DB_MEMBER_RE.test(rel)) return 'rankings_db';
    if (META_SIDECAR_RE.test(rel)) return 'optional';
    if (CACHE_SHAPE_RE.test(rel)) return 'authoritative';
    throw new HandoffManifestError('UNCLASSIFIED_MEMBER', `member in no explicit class: ${rel}`);
}

// Carrier registry: distinct R2 prefix root + producer job + membership contract.
// `exactDbSet` demands EXACT equality with RANKINGS_DB_NAMES (no missing, no extra) --
// never a count-only check, never `.some()`.
export const CARRIERS = Object.freeze({
    'rankings-satellite': Object.freeze({
        prefixRoot: 'state/_handoff/rankings-satellite',
        producerJob: 'aggregate-rankings',
        // data/ = the 10 DBs; cache/ = the ranking page JSONs + category_stats, so a
        // complete DB set can NEVER mask missing ranking JSON pages on this seam.
        memberRoots: Object.freeze([
            Object.freeze({ dir: 'data' }),
            Object.freeze({ dir: 'cache' }),
        ]),
        classes: Object.freeze([
            { name: 'rankings_db', re: DB_MEMBER_RE, min: RANKINGS_DB_COUNT },
            { name: 'ranking_pages', re: /^cache\/rankings\/[^/]+\/[^/]+\.json(\.zst|\.gz)?$/, min: RANKINGS_DB_COUNT },
            { name: 'category_stats', re: /^cache\/category_stats\.json(\.zst|\.gz)?$/, min: 1 },
        ]),
        // EXCLUSIVE SCOPES (destination re-verify, see verifyProjection): subtrees the
        // promotion OWNS end-to-end -- wiped, then repopulated from the authority -- so an
        // ORPHAN from a previous attempt (a stale `p40.json.zst` after totalPages shrank)
        // is a FAILURE instead of riding unverified into the cycle-output carrier.
        exclusiveScopes: Object.freeze([
            Object.freeze({ dir: 'data', re: DB_MEMBER_RE }),
            Object.freeze({ dir: 'cache/rankings', re: /^cache\/rankings\/.+$/ }),
        ]),
        exactDbSet: true,
        assertMemberEligibility: true,
    }),
    'rankings-db': Object.freeze({
        prefixRoot: 'state/_handoff/rankings-db',
        producerJob: 'finalize',
        // The publication payload ONLY: the EXACT 10 DBs 4/4 promotes into output/data/.
        memberRoots: Object.freeze([Object.freeze({ dir: 'data' })]),
        classes: Object.freeze([{ name: 'rankings_db', re: DB_MEMBER_RE, min: RANKINGS_DB_COUNT }]),
        exclusiveScopes: Object.freeze([Object.freeze({ dir: 'data', re: DB_MEMBER_RE })]),
        exactDbSet: true,
        assertMemberEligibility: true,
    }),
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const GITSHA_RE = /^[0-9a-f]{40}$/;
export function isSha256Hex(v) { return typeof v === 'string' && SHA256_RE.test(v); }
export function isGitSha(v) { return typeof v === 'string' && GITSHA_RE.test(v); }

export class HandoffManifestError extends Error {
    constructor(code, message) { super(`${code}: ${message}`); this.name = 'HandoffManifestError'; this.code = code; }
}
export function carrierConfig(carrierType) {
    const c = CARRIERS[carrierType];
    if (!c) throw new HandoffManifestError('CARRIER_UNKNOWN', `unknown carrier_type "${carrierType}"`);
    return c;
}
function fail(code, reason) { return { ok: false, code, reason }; }
function sha256File(absPath) { return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex'); }

/** STABLE-SORTED list of (relative_path, sha256) tuples -> single set hash. */
export function computeSetSha256(files) {
    const tuples = files.map((f) => [f.relative_path, f.sha256])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return crypto.createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
}

// Reserved sidecars NEVER part of a carrier set. handoff.json / manifest.json live at
// the staging ROOT (outside every member root) so they can never be walked; the
// r2-handoff internal `_manifest.json` restore sidecar is excluded at ANY depth.
function isReserved(rel) {
    return rel === '_manifest.json' || rel.endsWith('/_manifest.json');
}

function walkInto(absDir, relBase, out) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; } // absent root => no members (a below-floor class fails downstream)
    for (const e of entries) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        const abs = path.join(absDir, e.name);
        if (e.isSymbolicLink()) throw new HandoffManifestError('UNSAFE_MEMBER', `symlink member: ${rel}`);
        if (e.isDirectory()) { walkInto(abs, rel, out); continue; }
        if (!e.isFile()) continue;
        if (isReserved(rel)) continue;
        if (rel.split('/').some((s) => s === '..')) throw new HandoffManifestError('UNSAFE_MEMBER', `traversal member: ${rel}`);
        out.push(rel);
    }
}

/** The SINGLE membership function used by BOTH generate and verify (consistent by
 *  construction): walk each member root, CLASSIFY every file, drop EXCLUDED classes. */
export function listCarrierFiles(baseDir, carrier) {
    const raw = [];
    for (const r of carrier.memberRoots) walkInto(path.join(baseDir, r.dir), r.dir, raw);
    const out = [];
    for (const rel of raw) if (!EXCLUDED_CLASSES.has(classifyRankingsMember(rel))) out.push(rel);
    return out.sort();
}

/** EXACT `data/rankings-*.db` set equality vs RANKINGS_DB_NAMES. */
export function checkExactDbSet(relPaths) {
    const present = relPaths.filter((r) => r.startsWith('data/') && r.endsWith('.db')).map((r) => r.slice('data/'.length)).sort();
    const expect = [...RANKINGS_DB_NAMES].sort();
    const missing = expect.filter((n) => !present.includes(n));
    if (missing.length) return fail('RANKINGS_DB_SET_MISSING', `${present.length}/${RANKINGS_DB_COUNT} present; missing: ${missing.join(',')}`);
    const extra = present.filter((n) => !expect.includes(n));
    if (extra.length) return fail('RANKINGS_DB_SET_EXTRA', `unexpected rankings DB(s): ${extra.join(',')}`);
    return { ok: true, code: 'OK', reason: 'exact-db-set' };
}

function countClasses(files, classes) {
    return classes.map((c) => ({ name: c.name, min: c.min, count: files.filter((f) => c.re.test(f.relative_path)).length }));
}

export function buildStagingPrefix(carrierType, producerRunId, attempt) {
    const root = carrierConfig(carrierType).prefixRoot;
    return `${root}/${producerRunId}/attempt-${attempt}/`;
}

/** Build the manifest for a carrier staging directory. Enforces the EXACT DB set +
 *  required-class floors + uploader eligibility AT GENERATE (never a late FILE_MISSING). */
export function generateManifest(baseDir, ctx = {}) {
    const carrier = carrierConfig(ctx.carrierType);
    const names = listCarrierFiles(baseDir, carrier);
    if (carrier.exactDbSet) {
        const setRes = checkExactDbSet(names);
        if (!setRes.ok) throw new HandoffManifestError(setRes.code, setRes.reason);
    }
    const files = [];
    let totalBytes = 0;
    for (const rel of names) {
        const abs = path.join(baseDir, rel);
        const buf = fs.readFileSync(abs);
        if (carrier.assertMemberEligibility) {
            const { eligible, reason } = isUploadEligible(rel, buf, {});
            if (!eligible) throw new HandoffManifestError('MEMBER_UPLOAD_INELIGIBLE', `included member ${rel} upload-ineligible: ${reason}`);
        }
        files.push({ relative_path: rel, size_bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
        totalBytes += buf.length;
    }
    const requiredClasses = countClasses(files, carrier.classes);
    for (const rc of requiredClasses) {
        if (rc.count < rc.min) throw new HandoffManifestError('REQUIRED_CLASS_BELOW_FLOOR', `class ${rc.name}: ${rc.count} < min ${rc.min}`);
    }
    return {
        schema_version: SCHEMA_VERSION,
        carrier_type: ctx.carrierType,
        producer_run_id: String(ctx.producerRunId ?? ''),
        producer_job_identity: carrier.producerJob,
        producer_attempt: Number(ctx.producerAttempt ?? 0),
        head_sha: String(ctx.headSha ?? ''),
        exact_staging_prefix: buildStagingPrefix(ctx.carrierType, ctx.producerRunId, ctx.producerAttempt),
        created_at_utc: ctx.createdAt || new Date().toISOString(),
        completion_state: COMPLETION_STATE,
        member_count: files.length,
        rankings_db_count: RANKINGS_DB_COUNT,
        required_file_classes: requiredClasses,
        file_count: files.length,
        total_bytes: totalBytes,
        files,
        set_sha256: computeSetSha256(files),
    };
}

/** Verify a directory against a manifest. EXACT set equality (extra/missing => fail),
 *  per-file size + sha256, set_sha256, EXACT DB set, required-class floors + counts. */
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
    if (carrier.exactDbSet) {
        const setRes = checkExactDbSet([...manifestNames]);
        if (!setRes.ok) return setRes;
        const diskSet = checkExactDbSet([...actualNames]);
        if (!diskSet.ok) return diskSet;
    }
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
    if (Number(manifest.member_count) !== manifest.files.length) return fail('MEMBER_COUNT_MISMATCH', `member_count ${manifest.member_count} != files ${manifest.files.length}`);
    if (computeSetSha256(manifest.files) !== manifest.set_sha256) return fail('SET_HASH_MISMATCH', 'manifest.set_sha256 != recomputed set hash');
    return { ok: true, code: 'OK', reason: 'verified', set_sha256: manifest.set_sha256, file_count: manifest.files.length };
}

/**
 * PROJECTION verification -- the D8 DESTINATION re-verify after promotion into the live
 * workspace. This is deliberately NOT verifyDirAgainstManifest: the workspace holds MORE
 * than the carrier set (at 3/4 finalize `output/data/` also carries meta.db / search.db /
 * bundles/, and `output/cache/` carries the whole cycle-output tree), so an EXACT-set walk
 * would drown in FILE_EXTRA. Instead:
 *   (1) EVERY manifest member must exist at baseDir with matching size + sha256, and
 *   (2) inside each EXCLUSIVE SCOPE the on-disk set must EXACTLY equal the manifest members
 *       in that scope -- so an ORPHAN from a previous attempt FAILS rather than silently
 *       riding into the published cycle output.
 * Anything outside a declared scope is ignored (it belongs to another owner).
 */
export function verifyProjection(baseDir, manifest) {
    if (!manifest || typeof manifest !== 'object') return fail('MANIFEST_MALFORMED', 'manifest missing/not an object');
    if (!CARRIERS[manifest.carrier_type]) return fail('CARRIER_UNKNOWN', `carrier_type "${manifest.carrier_type}"`);
    if (!Array.isArray(manifest.files)) return fail('MANIFEST_MALFORMED', 'manifest.files not an array');
    const carrier = carrierConfig(manifest.carrier_type);
    // (1) every declared member is present + byte-identical at the destination.
    for (const f of manifest.files) {
        const rel = String(f.relative_path);
        if (rel.split('/').some((s) => s === '..')) return fail('UNSAFE_MEMBER', `traversal member: ${rel}`);
        const abs = path.join(baseDir, rel);
        let size;
        try { size = fs.statSync(abs).size; } catch { return fail('PROJECTION_MEMBER_MISSING', `promoted member absent: ${rel}`); }
        if (size !== Number(f.size_bytes)) return fail('SIZE_MISMATCH', `size mismatch ${rel}: disk ${size} != manifest ${f.size_bytes}`);
        if (!isSha256Hex(f.sha256) || sha256File(abs) !== f.sha256) return fail('HASH_MISMATCH', `sha256 mismatch ${rel}`);
    }
    // (2) no ORPHAN inside a scope the promotion owns end-to-end.
    const scopes = carrier.exclusiveScopes || [];
    for (const scope of scopes) {
        const raw = [];
        let onDisk;
        // classifyRankingsMember THROWS UNCLASSIFIED_MEMBER on an unknown member, so it must
        // be inside the guard too -- a fail-closed STRUCTURED code, never an uncaught throw.
        try {
            walkInto(path.join(baseDir, scope.dir), scope.dir, raw);
            onDisk = raw.filter((rel) => scope.re.test(rel) && !EXCLUDED_CLASSES.has(classifyRankingsMember(rel))).sort();
        } catch (e) { return fail(e.code || 'UNSAFE_MEMBER', e.message); }
        const declared = new Set(manifest.files.map((f) => String(f.relative_path)).filter((rel) => scope.re.test(rel)));
        // EXACT scope equality needs only the orphan direction: the OTHER direction
        // (a declared member absent from disk) is already fully covered by step (1)'s
        // PROJECTION_MEMBER_MISSING, and no `.meta.json`-style EXCLUDED class can ever be a
        // declared member (listCarrierFiles drops those at generate), so a count comparison
        // here would be structurally unreachable dead code. Deliberately omitted.
        for (const rel of onDisk) {
            if (!declared.has(rel)) return fail('PROJECTION_ORPHAN_MEMBER', `orphan in exclusive scope ${scope.dir}: ${rel} (not in the authority manifest)`);
        }
    }
    return { ok: true, code: 'OK', reason: 'projection-verified', member_count: manifest.files.length, scope_count: scopes.length, set_sha256: manifest.set_sha256 };
}

/** Verify a run-scoped handoff descriptor's PROVENANCE (no R2). Binds the producing
 *  3/4 run id + producer_attempt (positive int) + head_sha + the EXACT staging-prefix
 *  derivation (no list-latest / prefix-guess / mutable-latest / fixed / foreign cycle).
 *  The cross-workflow 4/4 consumer supplies NO runAttempt and NO headSha (it cannot
 *  know the 3/4 head sha); the same-run finalize consumer supplies BOTH. */
export function verifyDescriptor(descriptor, cur) {
    if (!descriptor || typeof descriptor !== 'object') return fail('DESC_MALFORMED', 'descriptor missing/not an object');
    const req = ['carrier_type', 'producer_run_id', 'producer_attempt', 'exact_staging_prefix', 'manifest_sha256', 'set_sha256', 'head_sha', 'created_at'];
    for (const k of req) if (descriptor[k] === undefined || descriptor[k] === null || descriptor[k] === '') return fail('DESC_FIELD_MISSING', `descriptor.${k} missing`);
    if (!CARRIERS[descriptor.carrier_type]) return fail('CARRIER_UNKNOWN', `carrier_type "${descriptor.carrier_type}"`);
    if (cur.carrierType && descriptor.carrier_type !== cur.carrierType) return fail('DESC_CARRIER_MISMATCH', `descriptor carrier ${descriptor.carrier_type} != expected ${cur.carrierType}`);
    if (!isSha256Hex(descriptor.set_sha256)) return fail('DESC_SET_SHA_INVALID', 'set_sha256 not a sha256');
    if (!isSha256Hex(descriptor.manifest_sha256)) return fail('DESC_MANIFEST_SHA_INVALID', 'manifest_sha256 not a sha256');
    if (!isGitSha(descriptor.head_sha)) return fail('DESC_HEAD_SHA_INVALID', 'head_sha not a 40-hex git sha');
    const pa = Number(descriptor.producer_attempt);
    if (!Number.isInteger(pa) || pa < 1) return fail('DESC_ATTEMPT_INVALID', `producer_attempt ${descriptor.producer_attempt} not a positive int`);
    if (cur.runAttempt != null && cur.runAttempt !== '') {
        const curAtt = Number(cur.runAttempt);
        if (!Number.isInteger(curAtt) || curAtt < 1) return fail('DESC_CURATTEMPT_INVALID', `current run_attempt ${cur.runAttempt} invalid`);
        if (pa > curAtt) return fail('DESC_ATTEMPT_FUTURE', `producer_attempt ${pa} > current run_attempt ${curAtt}`);
    }
    if (String(descriptor.producer_run_id) !== String(cur.producerRunId)) return fail('DESC_PRODUCER_RUN_MISMATCH', `descriptor producer_run_id ${descriptor.producer_run_id} != current ${cur.producerRunId}`);
    if (cur.headSha != null && cur.headSha !== '' && String(descriptor.head_sha) !== String(cur.headSha)) return fail('DESC_HEAD_SHA_MISMATCH', `descriptor head_sha ${descriptor.head_sha} != current ${cur.headSha}`);
    const expectPrefix = buildStagingPrefix(descriptor.carrier_type, cur.producerRunId, pa);
    if (String(descriptor.exact_staging_prefix) !== expectPrefix) return fail('DESC_PREFIX_MISMATCH', `exact_staging_prefix ${descriptor.exact_staging_prefix} != derived ${expectPrefix}`);
    return { ok: true, code: 'OK', reason: 'descriptor-verified', staging_prefix: expectPrefix, producer_attempt: pa, set_sha256: descriptor.set_sha256, head_sha: String(descriptor.head_sha) };
}

/** CROSS-CARRIER FAMILY BIND: the rankings-db descriptor and the cycle-output
 *  descriptor are BOTH written by the SAME 3/4 `finalize` job execution, so they MUST
 *  agree on run id + producer attempt + head sha. This is how the 4/4 consumer -- which
 *  cannot know the 3/4 head sha on its own -- gets an EXACT head-SHA bind for SEAM_B. */
export function verifySiblingDescriptors(rankingsDesc, siblingDesc) {
    for (const [label, d] of [['rankings', rankingsDesc], ['sibling', siblingDesc]]) {
        if (!d || typeof d !== 'object') return fail('SIBLING_MALFORMED', `${label} descriptor missing/not an object`);
    }
    if (rankingsDesc.carrier_type !== 'rankings-db') return fail('SIBLING_CARRIER_MISMATCH', `expected rankings-db, got ${rankingsDesc.carrier_type}`);
    const sibRun = String(siblingDesc.producer_run_id ?? siblingDesc.finalize_run_id ?? '');
    if (!sibRun) return fail('SIBLING_FIELD_MISSING', 'sibling descriptor carries no producer/finalize run id');
    if (String(rankingsDesc.producer_run_id) !== sibRun) return fail('SIBLING_RUN_MISMATCH', `rankings ${rankingsDesc.producer_run_id} != sibling ${sibRun}`);
    if (Number(rankingsDesc.producer_attempt) !== Number(siblingDesc.producer_attempt)) return fail('SIBLING_ATTEMPT_MISMATCH', `rankings attempt ${rankingsDesc.producer_attempt} != sibling ${siblingDesc.producer_attempt}`);
    if (!isGitSha(String(siblingDesc.head_sha))) return fail('SIBLING_HEAD_SHA_INVALID', `sibling head_sha ${siblingDesc.head_sha} not a 40-hex git sha`);
    if (String(rankingsDesc.head_sha) !== String(siblingDesc.head_sha)) return fail('SIBLING_HEAD_SHA_MISMATCH', `rankings head_sha ${rankingsDesc.head_sha} != sibling ${siblingDesc.head_sha}`);
    return { ok: true, code: 'OK', reason: 'sibling-verified', producer_run_id: sibRun, head_sha: String(siblingDesc.head_sha), producer_attempt: Number(siblingDesc.producer_attempt) };
}

/** The published manifest flag must be EXPLICITLY boolean `true`. An ABSENT key (the
 *  live production shape today) and `false` are BOTH refused: an absent key can never
 *  be read as a verified negative. */
export function verifyPublishedFlag(shardsManifest) {
    if (!shardsManifest || typeof shardsManifest !== 'object') return fail('SHARDS_MANIFEST_MALFORMED', 'shards manifest missing/not an object');
    const parts = shardsManifest.partitions;
    if (!parts || typeof parts !== 'object') return fail('SHARDS_MANIFEST_NO_PARTITIONS', 'shards manifest carries no partitions object');
    if (!Object.prototype.hasOwnProperty.call(parts, 'rankings_dbs')) return fail('RANKINGS_FLAG_ABSENT', 'partitions.rankings_dbs key ABSENT (never a verified negative)');
    if (parts.rankings_dbs !== true) return fail('RANKINGS_FLAG_NOT_TRUE', `partitions.rankings_dbs=${JSON.stringify(parts.rankings_dbs)} (must be boolean true)`);
    return { ok: true, code: 'OK', reason: 'flag-verified' };
}

/**
 * SHARDS-MANIFEST SIBLING (RANKINGS-PUBLICATION-SIBLING, Founder D-395). `output/data/shards_manifest.json` is
 * written ONLY by pack-finalizer, so on the skip-compute path (an old pack cache hit) and
 * on the FIX-4 recovery path (`rm -rf output/data/` then restore of `.db` / warm `.bin` /
 * `term_index` ONLY) it is absent -- and the D9b gate legitimately requires it. It is
 * therefore carried as an ADDITIVE SIBLING of the D-245 attempt-scoped vfs-pack authority
 * at `${STAGING}publication/shards_manifest.json`, bound by
 * `descriptor.shards_manifest_sha256` + `descriptor.shards_manifest_size`.
 *
 * DELIBERATELY NOT mixed into the existing `.db` set hash: the meta set_sha256 and the
 * warm_read sibling stay BYTE-IDENTICAL, so this adds a member without perturbing any
 * existing classification or hashing. Validation is SEMANTIC, not just byte-level: the
 * file must exist, be non-empty, parse as JSON, and declare
 * `partitions.rankings_dbs === true` (the SAME contract D9b enforces, through the SAME
 * verifyPublishedFlag) -- so a syntactically fine but semantically wrong manifest can
 * never become an authority.
 */
export function inspectShardsManifest(absPath) {
    let buf;
    try { buf = fs.readFileSync(absPath); } catch { return fail('SHARDS_MANIFEST_ABSENT', `absent: ${absPath}`); }
    if (buf.length === 0) return fail('SHARDS_MANIFEST_EMPTY', `zero-byte: ${absPath}`);
    let parsed;
    try { parsed = JSON.parse(buf.toString('utf8')); }
    catch (e) { return fail('SHARDS_MANIFEST_UNPARSEABLE', `${absPath}: ${e.message}`); }
    const flag = verifyPublishedFlag(parsed);
    if (!flag.ok) return flag;
    return {
        ok: true, code: 'OK', reason: 'shards-manifest-valid',
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        size_bytes: buf.length,
    };
}

/** Verify the sibling against the descriptor-declared hash + size (and the SAME semantics). */
export function verifyShardsManifestSibling(absPath, expect = {}) {
    const r = inspectShardsManifest(absPath);
    if (!r.ok) return r;
    if (expect.sha256 && r.sha256 !== String(expect.sha256).toLowerCase()) {
        return fail('SHARDS_MANIFEST_HASH_MISMATCH', `sha256 ${r.sha256} != declared ${expect.sha256}`);
    }
    if (expect.size !== undefined && expect.size !== null && expect.size !== '' && Number(expect.size) !== r.size_bytes) {
        return fail('SHARDS_MANIFEST_SIZE_MISMATCH', `size ${r.size_bytes} != declared ${expect.size}`);
    }
    return { ...r, reason: 'shards-manifest-sibling-verified' };
}

/**
 * Descriptor-side sibling identity: presence, well-formedness, AND (when the caller supplies
 * expectations) EXACT AGREEMENT with the locally-computed values.
 *
 * WHY THE EXPECTATION MATTERS (Founder finding on the first amend): presence + syntax alone
 * makes the binding DECORATIVE. A descriptor carrying a different-but-well-formed 64-hex SHA
 * and a different-but-positive size passed every check, because the sibling was then verified
 * against the PRODUCER-LOCAL shell values and those same local values were exported as the job
 * outputs -- so the durable descriptor could declare a false identity with no consequence.
 * The enforced identity must ORIGINATE in the durable descriptor read-back, so this function
 * both (a) diverges LOUDLY from the local values and (b) RETURNS the descriptor-parsed values
 * for the caller to use downstream. Divergence gets its OWN codes: it is the
 * "descriptor lied or the upload raced" signal, distinct from a malformed field.
 */
export function verifyShardsManifestDescriptorFields(descriptor, expect = {}) {
    if (!descriptor || typeof descriptor !== 'object') return fail('DESC_MALFORMED', 'descriptor missing/not an object');
    const sha = descriptor.shards_manifest_sha256;
    const size = descriptor.shards_manifest_size;
    if (sha === undefined || sha === null || sha === '') return fail('DESC_FIELD_MISSING', 'descriptor.shards_manifest_sha256 missing');
    if (size === undefined || size === null || size === '') return fail('DESC_FIELD_MISSING', 'descriptor.shards_manifest_size missing');
    if (!isSha256Hex(String(sha))) return fail('DESC_SHARDS_MANIFEST_SHA_INVALID', `shards_manifest_sha256 "${sha}" not a sha256`);
    const n = Number(size);
    if (!Number.isInteger(n) || n <= 0) return fail('DESC_SHARDS_MANIFEST_SIZE_INVALID', `shards_manifest_size ${size} not a positive int`);
    if (expect.sha256 !== undefined && expect.sha256 !== null && expect.sha256 !== '') {
        if (String(sha).toLowerCase() !== String(expect.sha256).toLowerCase()) {
            return fail('DESC_SHARDS_MANIFEST_SHA_DIVERGED', `descriptor shards_manifest_sha256 ${sha} != locally computed ${expect.sha256} (descriptor declares a FALSE identity, or the upload raced)`);
        }
    }
    if (expect.size !== undefined && expect.size !== null && expect.size !== '') {
        if (n !== Number(expect.size)) {
            return fail('DESC_SHARDS_MANIFEST_SIZE_DIVERGED', `descriptor shards_manifest_size ${n} != locally computed ${expect.size} (descriptor declares a FALSE identity, or the upload raced)`);
        }
    }
    return { ok: true, code: 'OK', reason: 'shards-manifest-fields-verified', sha256: String(sha).toLowerCase(), size_bytes: n };
}

// ============================================================================
// CLI: generate | verify | verify-projection | verify-descriptor | verify-sibling |
// verify-dbs | verify-publication | shards-manifest-emit | shards-manifest-verify |
// shards-manifest-fields. Provenance via env; carrier via --carrier=.
// ============================================================================
function parseFlag(argv, name) { const a = (argv || []).find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ''; }
const LOG = '[RANKINGS-DB-HANDOFF]';

async function runCli(argv) {
    const [cmd, ...rest] = argv;
    const positional = rest.filter((a) => !a.startsWith('--'));
    const carrierType = parseFlag(rest, 'carrier');
    if (cmd === 'generate') {
        const [dir, out] = positional;
        const manifest = generateManifest(dir, {
            carrierType,
            producerRunId: process.env.HANDOFF_PRODUCER_RUN_ID,
            producerAttempt: process.env.HANDOFF_PRODUCER_ATTEMPT,
            headSha: process.env.HANDOFF_HEAD_SHA,
        });
        fs.writeFileSync(out, JSON.stringify(manifest));
        process.stdout.write(`${manifest.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify') {
        const [dir, manifestPath] = positional;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = verifyDirAgainstManifest(dir, manifest);
        if (!res.ok) { console.error(`${LOG} VERIFY FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`${LOG} VERIFY OK set_sha256=${res.set_sha256} files=${res.file_count}`);
        process.stdout.write(`${res.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'shards-manifest-emit') {
        const [smPath] = positional;
        const r = inspectShardsManifest(smPath);
        if (!r.ok) { console.error(`${LOG} SHARDS-MANIFEST FAIL ${r.code}: ${r.reason}`); return 1; }
        console.error(`${LOG} SHARDS-MANIFEST OK sha256=${r.sha256} size=${r.size_bytes} (partitions.rankings_dbs === true)`);
        process.stdout.write(`${r.sha256}\t${r.size_bytes}\n`);
        return 0;
    }
    if (cmd === 'shards-manifest-verify') {
        const [smPath] = positional;
        const r = verifyShardsManifestSibling(smPath, { sha256: parseFlag(rest, 'sha'), size: parseFlag(rest, 'size') });
        if (!r.ok) { console.error(`${LOG} SHARDS-MANIFEST FAIL ${r.code}: ${r.reason}`); return 1; }
        console.error(`${LOG} SHARDS-MANIFEST VERIFIED sha256=${r.sha256} size=${r.size_bytes}`);
        process.stdout.write(`${r.sha256}\t${r.size_bytes}\n`);
        return 0;
    }
    if (cmd === 'shards-manifest-fields') {
        const [descPath] = positional;
        let descriptor;
        try { descriptor = JSON.parse(fs.readFileSync(descPath, 'utf8')); }
        catch (e) { console.error(`${LOG} SHARDS-MANIFEST FIELDS FAIL DESC_UNREADABLE: ${e.message}`); return 1; }
        // --expect-sha / --expect-size make the binding LOAD-BEARING: the durable descriptor
        // must AGREE with the locally computed identity, and the values printed on stdout are
        // the DESCRIPTOR-PARSED ones -- the caller uses THOSE downstream, never its own locals.
        const r = verifyShardsManifestDescriptorFields(descriptor, {
            sha256: parseFlag(rest, 'expect-sha'), size: parseFlag(rest, 'expect-size'),
        });
        if (!r.ok) { console.error(`${LOG} SHARDS-MANIFEST FIELDS FAIL ${r.code}: ${r.reason}`); return 1; }
        console.error(`${LOG} SHARDS-MANIFEST FIELDS OK (descriptor-parsed) sha256=${r.sha256} size=${r.size_bytes}`);
        process.stdout.write(`${r.sha256}\t${r.size_bytes}\n`);
        return 0;
    }
    if (cmd === 'verify-projection') {
        const [dir, manifestPath] = positional;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = verifyProjection(dir, manifest);
        if (!res.ok) { console.error(`${LOG} PROJECTION FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`${LOG} PROJECTION OK members=${res.member_count} exclusive-scopes=${res.scope_count}`);
        process.stdout.write(`${res.set_sha256}\n`);
        return 0;
    }
    if (cmd === 'verify-descriptor') {
        const [descPath] = positional;
        let descriptor;
        try { descriptor = JSON.parse(fs.readFileSync(descPath, 'utf8')); }
        catch (e) { console.error(`${LOG} DESC FAIL DESC_UNREADABLE: ${e.message}`); return 1; }
        const res = verifyDescriptor(descriptor, {
            carrierType: carrierType || undefined,
            producerRunId: process.env.HANDOFF_PRODUCER_RUN_ID,
            runAttempt: process.env.HANDOFF_RUN_ATTEMPT,
            headSha: process.env.HANDOFF_HEAD_SHA,
        });
        if (!res.ok) { console.error(`${LOG} DESC FAIL ${res.code}: ${res.reason}`); return 1; }
        process.stdout.write(`${res.staging_prefix}\t${res.set_sha256}\t${res.head_sha}\t${res.producer_attempt}\n`);
        console.error(`${LOG} DESC OK staging=${res.staging_prefix} producer_attempt=${res.producer_attempt}`);
        return 0;
    }
    if (cmd === 'verify-sibling') {
        const [rankPath, sibPath] = positional;
        let a; let b;
        try { a = JSON.parse(fs.readFileSync(rankPath, 'utf8')); b = JSON.parse(fs.readFileSync(sibPath, 'utf8')); }
        catch (e) { console.error(`${LOG} SIBLING FAIL DESC_UNREADABLE: ${e.message}`); return 1; }
        const res = verifySiblingDescriptors(a, b);
        if (!res.ok) { console.error(`${LOG} SIBLING FAIL ${res.code}: ${res.reason}`); return 1; }
        process.stdout.write(`${res.producer_run_id}\t${res.head_sha}\t${res.producer_attempt}\n`);
        console.error(`${LOG} SIBLING OK run=${res.producer_run_id} head=${res.head_sha} attempt=${res.producer_attempt}`);
        return 0;
    }
    if (cmd === 'verify-dbs' || cmd === 'verify-publication') {
        const { verifyRankingsDbSet, verifyOptsFromEnv } = await import('./lib/rankings-db-verifier.js');
        const [dir, shardsManifestPath] = positional;
        const res = verifyRankingsDbSet(dir, verifyOptsFromEnv(process.env));
        if (!res.ok) { console.error(`${LOG} DB-SET FAIL ${res.code}: ${res.reason}`); return 1; }
        console.error(`${LOG} DB-SET OK ${res.count}/${RANKINGS_DB_COUNT} run=${res.identity.runId} attempt=${res.identity.attempt} head=${res.identity.headSha}`);
        if (cmd === 'verify-publication') {
            let sm;
            const smPath = shardsManifestPath || path.join(dir, 'shards_manifest.json');
            try { sm = JSON.parse(fs.readFileSync(smPath, 'utf8')); }
            catch (e) { console.error(`${LOG} FLAG FAIL SHARDS_MANIFEST_UNREADABLE: ${smPath}: ${e.message}`); return 1; }
            const flag = verifyPublishedFlag(sm);
            if (!flag.ok) { console.error(`${LOG} FLAG FAIL ${flag.code}: ${flag.reason}`); return 1; }
            console.error(`${LOG} FLAG OK partitions.rankings_dbs === true (${smPath})`);
        }
        return 0;
    }
    console.error('Usage: rankings-db-handoff-manifest.mjs generate|verify|verify-projection|verify-descriptor|verify-sibling|verify-dbs|verify-publication|shards-manifest-emit|shards-manifest-verify|shards-manifest-fields <args> --carrier=rankings-satellite|rankings-db');
    return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', '').replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
    runCli(process.argv.slice(2))
        .then((code) => process.exit(code))
        .catch((e) => { console.error(`${LOG} FATAL ${e.code || ''}: ${e.message}`); process.exit(1); });
}
