// scripts/factory/cycle-output-handoff-manifest.test.mjs
//
// Hermetic node:test suite for the Factory 3/4 finalize -> 4/4 consumers
// R2-authoritative cycle-output handoff verifier of record
// (carrier "cycle-output-authority"), Founder D-2026-0704-264 (FIX-2 / GAP-2 / C12)
// + the A5 HYBRID manifest/guard consistency repair (D-2026-0706-285, PR-A).
// NO network, NO R2, NO @aws-sdk: the pure generate/verify/verify-descriptor module
// is driven over REAL temp dirs (node built-ins only).
//
// ANTI-VACUITY MAP (removing/weakening a guard reds >=1 named test):
//   * manifest-last framing         -> (H1) manifest carries no self-hash; add one => MANIFEST_SELF_HASH red flips.
//   * descriptor-last (provenance)  -> (H8) foreign finalize_run_id => DESC_FINALIZE_RUN_MISMATCH; drop bind => green.
//   * set_sha256 verify             -> (H3) mutate set_sha256 => SET_HASH_MISMATCH; drop check => green-when-tampered.
//   * EXACT membership (FILE_EXTRA) -> (H4) a foreign/mixed-cycle cache file reds; drop extra check => green.
//   * EXACT membership (FILE_MISSING)-> (H5) a manifest member absent on disk reds; drop => green.
//   * per-file sha256               -> (H6) same-length tamper => HASH_MISMATCH; drop => red flips.
//   * malformed manifest            -> (H2) null / non-array files / unknown carrier => rejected.
//   * missing descriptor field      -> (H9) a stripped required field => DESC_FIELD_MISSING.
//   * partial upload (below-floor)  -> (H7) a metadata-missing set => REQUIRED_CLASS_BELOW_FLOOR (generate + verify).
//   * producer read-back fail-closed-> (H10) a manifest over set A vs a disk holding set B => verify reds.
//   * no-registry-double-bind       -> (H11) a cache/registry/ or global-registry* member is EXCLUDED + rejected.
//   * prefix derivation             -> (H13) fixed/latest/two-level prefix => DESC_PREFIX_MISMATCH.
//   * head_sha well-formedness      -> (H14) non-git-sha head => DESC_HEAD_SHA_INVALID.
//   * A5 required-JSON transport     -> (F-A1) drop the transport class OR requiredJson mode => a 78B search-manifest.json
//                                       either fails MEMBER_UPLOAD_INELIGIBLE at generate or is refused at upload.
//   * A5 optional-sidecar EXCLUDE    -> (F-A2) restore the sidecar to the set => an included .meta.json the guard refuses
//                                       reds read-back FILE_MISSING (or fails generate); set_sha changes.
//   * A5 empty-placeholder EXCLUDE   -> (F-A4) drop the placeholder class => the 11B alt frame is an included member the
//                                       uploader refuses => read-back FILE_MISSING.
//   * A5 UNCLASSIFIED fail-loud      -> (F-A5) a non-JSON-family cache member => UNCLASSIFIED_MEMBER (generate AND verify).
//   * A5 included-eligibility assert -> (F-A3)/(F-A6) drop assertMemberEligibility => an 11B included member no longer
//                                       fails loud (silently-unsatisfiable manifest -> late FILE_MISSING).
//   * A5 whole-seam consistency      -> (F-SRC) r2-handoff threads requiredJson + the CLI parses --required-json + the
//                                       producer step passes it (so generate == upload eligibility by construction).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
    SCHEMA_VERSION, COMPLETION_STATE, CARRIERS, HandoffManifestError,
    isSha256Hex, isGitSha, computeSetSha256, listCarrierFiles, carrierConfig,
    buildStagingPrefix, generateManifest, verifyDirAgainstManifest, verifyDescriptor,
} from './cycle-output-handoff-manifest.mjs';
import { isUploadEligible, isNonEmptyJson, ZSTD_MIN_BYTES, DEFAULT_MIN_BYTES } from './lib/upload-eligibility.js';

// Read a repo SOURCE file relative to THIS test (hermetic; no network).
function readSrc(relToTest) { return fs.readFileSync(new URL(relToTest, import.meta.url), 'utf8'); }
// Guard-ELIGIBLE .zst fixture: valid zstd magic (28 B5 2F FD) + padding to `nBytes`.
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
function zst(nBytes = 20, seed = 'x') {
    const pad = Buffer.alloc(Math.max(0, nBytes - 4));
    for (let i = 0; i < pad.length; i += 1) pad[i] = (seed.charCodeAt(i % seed.length) + i) & 0xff;
    return Buffer.concat([ZSTD_MAGIC, pad]);
}
// Guard-INELIGIBLE .zst fixture: valid magic but < 16B (the stale 11B empty-frame class).
function zstStub(nBytes = 11) { return zst(nBytes, 's'); }
// A small (< 256B) VALID JSON payload -- the consumer-required transport class.
function smallJson(obj) { return JSON.stringify(obj); }

const SHA = 'a'.repeat(40);
let TMP_SEQ = 0;
function mkTmp() { const d = path.join(os.tmpdir(), `cycle-output-handoff-${process.pid}-${Date.now()}-${TMP_SEQ++}`); fs.mkdirSync(d, { recursive: true }); return d; }
function writeFiles(dir, files) {
    for (const [rel, body] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
    }
    return dir;
}
// A minimal-but-complete cycle-output workspace: the finalize output/ tree with a cache/
// subtree satisfying every required-class floor, every member guard-ELIGIBLE under its A5
// class. Includes: 3 consumer-required transport JSONs (< 256B), an optional MD5 sidecar
// (EXCLUDED), an empty-placeholder alt frame (EXCLUDED) + a real alt frame (INCLUDED), and an
// output/data/ sibling that MUST be ignored.
function cycleDir(over = {}, dataOver = {}) {
    const base = writeFiles(mkTmp(), {
        'cache/mesh/graph.json.zst': zst(20, 'g'),
        'cache/mesh/stats.json.zst': zst(20, 's'),
        'cache/search-core.json.zst': zst(20, 'c'),
        'cache/category_stats.json.zst': zst(20, 't'),
        'cache/knowledge/index.json.zst': zst(20, 'k'),
        'cache/knowledge/articles/a-1.json.zst': zst(20, '1'),
        'cache/knowledge/articles/a-2.json.zst': zst(20, '2'),
        'cache/trending.json.zst': zst(20, 'r'),
        'cache/rankings/all.json.zst': zst(20, 'a'),
        'cache/rankings/model.json.zst': zst(20, 'm'),
        // A5 TRANSPORT (INCLUDED via class-scoped required-JSON eligibility): < 256B floor.
        'cache/search-manifest.json': smallJson({ totalShards: 3 }),                 // ~18B
        'cache/fni-thresholds.json': smallJson({ scorePercentiles: { p50: 1 } }),     // ~34B
        'cache/assertions/_summary.json': smallJson({ assertions_empty_evidence: 0 }),// ~34B
        // A5 OPTIONAL accelerator (EXCLUDED by explicit class): a small MD5 checksum sidecar.
        'cache/rankings/all.json.zst.meta.json': '{"checksum":"deadbeef"}',
        // A5 EMPTY_PLACEHOLDER (EXCLUDED): 11B empty-{} alt frame; + a real (>=16B) alt frame.
        'cache/relations/alt-by-category/sparse.json.zst': zstStub(11),
        'cache/relations/alt-by-category/dense.json.zst': zst(20, 'd'),
        'cache/relations/alt-meta.json.zst': zst(20, 'M'),
        ...over,
    });
    writeFiles(base, { 'data/meta-00.db': 'METADB', 'data/rankings-all.db': 'RANKDB', ...dataOver });
    return base;
}
const CTX = { carrierType: 'cycle-output-authority', finalizeRunId: 'F1', upstreamRunId: 'U1', producerAttempt: '2', headSha: SHA, createdAt: '1970-01-01T00:00:00.000Z' };
function genCycle(dir, over = {}) { return generateManifest(dir, { ...CTX, ...over }); }
function descFor(manifest) {
    return {
        schema_version: SCHEMA_VERSION, carrier_type: manifest.carrier_type,
        finalize_run_id: manifest.finalize_run_id, producer_attempt: manifest.producer_attempt,
        exact_staging_prefix: manifest.exact_staging_prefix,
        manifest_sha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
        set_sha256: manifest.set_sha256, head_sha: manifest.head_sha, created_at: manifest.created_at_utc,
    };
}
// CROSS-workflow consumer (4/4): NO runAttempt / NO headSha binding.
function curConsumer(over = {}) { return { carrierType: 'cycle-output-authority', finalizeRunId: 'F1', ...over }; }

// ==========================================================================
// A. Config / constants / hashing
// ==========================================================================
test('(A1) single carrier `cycle-output-authority`, single-level prefix root, finalize producer job', () => {
    assert.deepEqual(Object.keys(CARRIERS), ['cycle-output-authority']);
    assert.equal(carrierConfig('cycle-output-authority').prefixRoot, 'state/_handoff/cycle-output');
    assert.equal(carrierConfig('cycle-output-authority').producerJob, 'finalize');
    assert.equal(carrierConfig('cycle-output-authority').assertMemberEligibility, true);
    assert.throws(() => carrierConfig('bogus'), (e) => e instanceof HandoffManifestError && e.code === 'CARRIER_UNKNOWN');
});
test('(A2) buildStagingPrefix binds finalize-run + attempt; NEVER a latest/fixed/two-level token', () => {
    assert.equal(buildStagingPrefix('cycle-output-authority', 'F1', '2'), 'state/_handoff/cycle-output/F1/attempt-2/');
    const p = buildStagingPrefix('cycle-output-authority', 'F1', '2');
    assert.ok(!p.includes('latest'));
    assert.ok(!p.includes('state/cycle-output/')); // never the mutable fixed prefix
    assert.ok(!/F1\/U1\//.test(p)); // single-level: no two-level upstream token in the path
});
test('(A3) isSha256Hex/isGitSha reject a multipart ETag; computeSetSha256 order-independent + content-bound', () => {
    assert.equal(isSha256Hex('a'.repeat(64)), true);
    assert.equal(isSha256Hex('abc123-50'), false);
    assert.equal(isGitSha('a'.repeat(40)), true);
    assert.equal(isGitSha('a'.repeat(64)), false);
    const files = [{ relative_path: 'b', sha256: 'b'.repeat(64) }, { relative_path: 'a', sha256: 'a'.repeat(64) }];
    assert.equal(computeSetSha256(files), computeSetSha256([...files].reverse()));
    const tampered = [{ relative_path: 'b', sha256: 'b'.repeat(64) }, { relative_path: 'a', sha256: 'c'.repeat(64) }];
    assert.notEqual(computeSetSha256(files), computeSetSha256(tampered));
});

// ==========================================================================
// H. generate / verify / descriptor -- the FIX-2 contract families
// ==========================================================================
test('(H1) manifest-last: emits the full field set, member_count == file_count, no self-hash', () => {
    const m = genCycle(cycleDir());
    assert.equal(m.schema_version, SCHEMA_VERSION);
    assert.equal(m.carrier_type, 'cycle-output-authority');
    assert.equal(m.finalize_run_id, 'F1');
    assert.equal(m.upstream_run_id, 'U1');
    assert.equal(m.producer_job_identity, 'finalize');
    assert.equal(m.producer_attempt, 2);
    assert.equal(m.head_sha, SHA);
    assert.equal(m.exact_staging_prefix, 'state/_handoff/cycle-output/F1/attempt-2/');
    assert.equal(m.completion_state, COMPLETION_STATE);
    assert.equal(m.member_count, m.file_count);
    assert.ok(isSha256Hex(m.set_sha256));
    assert.ok(!('manifest_sha256' in m));
    assert.ok(m.files.every((f) => isSha256Hex(f.sha256) && Number.isInteger(f.size_bytes)));
    // output/data/ is NOT a member (4/4-owned); only cache/** members present.
    assert.ok(m.files.every((f) => f.relative_path.startsWith('cache/')));
    assert.ok(!m.files.some((f) => f.relative_path.startsWith('data/')));
    assert.ok(m.files.some((f) => f.relative_path === 'cache/mesh/graph.json.zst'));
    assert.ok(m.files.some((f) => f.relative_path === 'cache/knowledge/index.json.zst'));
});
test('(H1b) required_file_classes covers the metadata floors + non-empty knowledge/rankings', () => {
    const m = genCycle(cycleDir());
    const byName = Object.fromEntries(m.required_file_classes.map((c) => [c.name, c]));
    assert.equal(byName.mesh_graph.count, 1);
    assert.equal(byName.search_core.count, 1);
    assert.equal(byName.category_stats.count, 1);
    assert.equal(byName.knowledge_index.count, 1);
    assert.equal(byName.trending.count, 1);
    assert.ok(byName.rankings.count >= 1);
});
test('(H2 malformed manifest) null / non-array files / unknown carrier / self-hash rejected', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    assert.equal(verifyDirAgainstManifest(mkTmp(), null).code, 'MANIFEST_MALFORMED');
    assert.equal(verifyDirAgainstManifest(mkTmp(), { carrier_type: 'cycle-output-authority', files: 'x' }).code, 'MANIFEST_MALFORMED');
    assert.equal(verifyDirAgainstManifest(mkTmp(), { carrier_type: 'nope', files: [] }).code, 'CARRIER_UNKNOWN');
    assert.equal(verifyDirAgainstManifest(dir, { ...m, manifest_sha256: 'd'.repeat(64) }).code, 'MANIFEST_SELF_HASH');
});
test('(H2b positive) manifest verifies against its own dir; returns set_sha + file count', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    const res = verifyDirAgainstManifest(dir, m);
    assert.equal(res.ok, true);
    assert.equal(res.set_sha256, m.set_sha256);
    assert.equal(res.file_count, m.file_count);
});
test('(H3 anti-vacuity: set-hash verify) mutating set_sha256 in the manifest reds verify', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    assert.equal(verifyDirAgainstManifest(dir, { ...m, set_sha256: 'f'.repeat(64) }).code, 'SET_HASH_MISMATCH');
});
test('(H4 anti-vacuity: FILE_EXTRA) a foreign/mixed-cycle cache file NOT in the manifest reds verify', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    fs.writeFileSync(path.join(dir, 'cache/foreign-cycle.json.zst'), zst(20, 'F')); // mixed-cycle leftover
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_EXTRA'); // never proceeds on a mixed set
});
test('(H5 anti-vacuity: FILE_MISSING) a manifest member absent on disk (manifest without payload) reds', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    fs.rmSync(path.join(dir, 'cache/knowledge/articles/a-1.json.zst'));
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_MISSING');
});
test('(H6 anti-vacuity: per-file sha) SIZE_MISMATCH + HASH_MISMATCH on tampered bytes', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    fs.writeFileSync(path.join(dir, 'cache/mesh/graph.json.zst'), zst(40, 'g')); // longer
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'SIZE_MISMATCH');
    const dir2 = cycleDir();
    const m2 = genCycle(dir2);
    fs.writeFileSync(path.join(dir2, 'cache/mesh/graph.json.zst'), zst(20, 'Z')); // same length diff content
    assert.equal(verifyDirAgainstManifest(dir2, m2).code, 'HASH_MISMATCH');
});
test('(H7 anti-vacuity: partial/below-floor) a metadata-missing set fails closed at generate AND verify', () => {
    const noMesh = cycleDir();
    fs.rmSync(path.join(noMesh, 'cache/mesh/graph.json.zst'));
    assert.throws(() => genCycle(noMesh), (e) => e instanceof HandoffManifestError && e.code === 'REQUIRED_CLASS_BELOW_FLOOR');
    const full = genCycle(cycleDir());
    assert.equal(verifyDirAgainstManifest(noMesh, full).code, 'FILE_MISSING');
});
test('(H7b) required-class count tamper (declared != disk) => REQUIRED_CLASS_COUNT_MISMATCH', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    const bad = { ...m, required_file_classes: m.required_file_classes.map((c) => (c.name === 'rankings' ? { ...c, count: c.count + 5 } : c)) };
    assert.equal(verifyDirAgainstManifest(dir, bad).code, 'REQUIRED_CLASS_COUNT_MISMATCH');
});
test('(H7c) member_count tamper (declared != files.length) => MEMBER_COUNT_MISMATCH', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    assert.equal(verifyDirAgainstManifest(dir, { ...m, member_count: m.file_count - 1 }).code, 'MEMBER_COUNT_MISMATCH');
});
test('(H10 producer read-back fail-closed) a manifest over set A vs a disk holding a different set B reds', () => {
    const dirA = cycleDir();
    const mA = genCycle(dirA);
    const dirB = cycleDir({ 'cache/rankings/extra.json.zst': zst(20, 'x') }); // a superset upload
    assert.equal(verifyDirAgainstManifest(dirB, mA).code, 'FILE_EXTRA');
    const dirC = cycleDir();
    fs.rmSync(path.join(dirC, 'cache/trending.json.zst')); // a subset upload (partial)
    assert.equal(verifyDirAgainstManifest(dirC, mA).code, 'FILE_MISSING');
});
test('(H11 no-registry-double-bind) a cache/registry/ or global-registry* member is EXCLUDED at generate + REJECTED at verify', () => {
    const dir = cycleDir({
        'cache/registry/part-0.bin': 'REGBIN',
        'cache/registry/part-1.bin': 'REGBIN2',
        'cache/global-registry.json.zst': zst(20, 'R'),
    });
    const m = genCycle(dir);
    assert.ok(!m.files.some((f) => f.relative_path.startsWith('cache/registry/')));
    assert.ok(!m.files.some((f) => f.relative_path === 'cache/global-registry.json.zst'));
    const names = listCarrierFiles(dir, carrierConfig('cycle-output-authority'));
    assert.ok(!names.some((n) => n.includes('/registry/') || /(^|\/)global-registry/.test(n)));
    assert.equal(verifyDirAgainstManifest(dir, m).ok, true);
    const smuggled = { ...m, files: [...m.files, { relative_path: 'cache/registry/part-0.bin', size_bytes: 6, sha256: 'e'.repeat(64) }] };
    smuggled.set_sha256 = computeSetSha256(smuggled.files);
    assert.equal(verifyDirAgainstManifest(dir, smuggled).code, 'REGISTRY_DOUBLE_BIND');
});
test('(H11b) a non-registry file whose name merely contains "registry" is NOT excluded', () => {
    const dir = cycleDir({ 'cache/knowledge/registry-notes.json.zst': zst(20, 'n') });
    const m = genCycle(dir);
    assert.ok(m.files.some((f) => f.relative_path === 'cache/knowledge/registry-notes.json.zst'));
});

// ==========================================================================
// D. listCarrierFiles -- safety (symlink / traversal) + reserved exclusion
// ==========================================================================
test('(D1) listCarrierFiles rejects a symlink member (UNSAFE_MEMBER)', () => {
    const dir = cycleDir();
    let made = false;
    try { fs.symlinkSync(path.join(dir, 'cache/mesh/graph.json.zst'), path.join(dir, 'cache/mesh/graph-link.json.zst')); made = true; }
    catch { /* Windows without privilege -- skip */ }
    if (!made) return;
    assert.throws(() => listCarrierFiles(dir, carrierConfig('cycle-output-authority')), (e) => e instanceof HandoffManifestError && e.code === 'UNSAFE_MEMBER');
});
test('(D2) reserved exclusion: staging sidecars never members; */_manifest.json dropped at any depth', () => {
    const dir = cycleDir({ 'cache/_manifest.json': 'BACKUP-SIDECAR', 'cache/mesh/_manifest.json': 'BACKUP-SIDECAR' });
    writeFiles(dir, { 'manifest.json': 'ROOT', 'handoff.json': 'ROOT' });
    const names = listCarrierFiles(dir, carrierConfig('cycle-output-authority'));
    assert.ok(!names.includes('cache/_manifest.json'));      // r2-handoff internal sidecar dropped
    assert.ok(!names.includes('cache/mesh/_manifest.json')); // ...at any depth
    assert.ok(!names.includes('manifest.json'));             // outside cache/ (not a member)
    assert.ok(names.includes('cache/mesh/graph.json.zst'));  // real member kept
});
test('(D3) path-traversal member in the manifest => never verified (FILE_MISSING/UNSAFE_MEMBER)', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    const evil = { ...m, files: m.files.map((f, i) => (i === 0 ? { relative_path: '../../etc/x', size_bytes: f.size_bytes, sha256: f.sha256 } : f)) };
    assert.ok(['FILE_MISSING', 'UNSAFE_MEMBER'].includes(verifyDirAgainstManifest(dir, evil).code));
});

// ==========================================================================
// E. verifyDescriptor -- provenance (finalize-run + attempt + head + prefix)
// ==========================================================================
test('(H8 positive) CROSS-workflow descriptor verifies (no runAttempt/headSha bind); emits derived staging + set hash', () => {
    const m = genCycle(cycleDir());
    const res = verifyDescriptor(descFor(m), curConsumer());
    assert.equal(res.ok, true);
    assert.equal(res.staging_prefix, 'state/_handoff/cycle-output/F1/attempt-2/');
    assert.equal(res.set_sha256, m.set_sha256);
    assert.equal(res.producer_attempt, 2);
});
test('(H8b anti-vacuity: finalize-run bind) foreign/predecessor finalize_run_id rejected', () => {
    const m = genCycle(cycleDir());
    assert.equal(verifyDescriptor(descFor(m), curConsumer({ finalizeRunId: 'F-OTHER' })).code, 'DESC_FINALIZE_RUN_MISMATCH');
});
test('(H9 missing field / carrier mismatch / bad set-or-manifest sha) rejected', () => {
    const m = genCycle(cycleDir());
    assert.equal(verifyDescriptor({ ...descFor(m), set_sha256: undefined }, curConsumer()).code, 'DESC_FIELD_MISSING');
    assert.equal(verifyDescriptor({ ...descFor(m), finalize_run_id: '' }, curConsumer()).code, 'DESC_FIELD_MISSING');
    assert.equal(verifyDescriptor(descFor(m), curConsumer({ carrierType: 'bogus-authority' })).code, 'DESC_CARRIER_MISMATCH');
    assert.equal(verifyDescriptor({ ...descFor(m), set_sha256: 'abc-50' }, curConsumer()).code, 'DESC_SET_SHA_INVALID');
    assert.equal(verifyDescriptor({ ...descFor(m), manifest_sha256: 'abc-50' }, curConsumer()).code, 'DESC_MANIFEST_SHA_INVALID');
});
test('(H12) attempt bind: producer_attempt 0/negative invalid; a supplied runAttempt bound rejects a future attempt', () => {
    const m = genCycle(cycleDir());
    assert.equal(verifyDescriptor({ ...descFor(m), producer_attempt: 0 }, curConsumer()).code, 'DESC_ATTEMPT_INVALID');
    const m5 = genCycle(cycleDir(), { producerAttempt: '5' });
    assert.equal(verifyDescriptor(descFor(m5), curConsumer({ runAttempt: '2' })).code, 'DESC_ATTEMPT_FUTURE');
});
test('(H13 anti-vacuity: prefix derivation) fixed / latest / two-level / predecessor staging prefix rejected', () => {
    const m = genCycle(cycleDir());
    for (const bad of ['state/cycle-output/', 'state/_handoff/cycle-output/F1/attempt-latest/', 'state/_handoff/cycle-output/F1/', 'state/_handoff/cycle-output/F1/U1/attempt-2/']) {
        assert.equal(verifyDescriptor({ ...descFor(m), exact_staging_prefix: bad }, curConsumer()).code, 'DESC_PREFIX_MISMATCH');
    }
});
test('(H14 anti-vacuity: head-sha well-formedness + optional equality)', () => {
    const m = genCycle(cycleDir());
    assert.equal(verifyDescriptor({ ...descFor(m), head_sha: 'not-a-sha' }, curConsumer()).code, 'DESC_HEAD_SHA_INVALID');
    assert.equal(verifyDescriptor(descFor(m), curConsumer()).ok, true); // 4/4 supplies no headSha
    assert.equal(verifyDescriptor(descFor(m), curConsumer({ headSha: 'c'.repeat(40) })).code, 'DESC_HEAD_SHA_MISMATCH');
});

// ==========================================================================
// F. A5 HYBRID -- manifest/guard membership consistency (D-2026-0706-285, PR-A).
//    The 12 acceptance cases: class-scoped required-JSON transport + explicit
//    optional/empty-placeholder EXCLUDE + UNCLASSIFIED_MEMBER fail-loud +
//    generate-time INCLUDED-member eligibility (MEMBER_UPLOAD_INELIGIBLE) while
//    the zstd guard / 16B floor / EXACT-set read-back / prefix derivation are PRESERVED.
// ==========================================================================

// The ORIGINAL inline r2-handoff predicate, replicated as an ORACLE (proves the DEFAULT path of
// the extracted isUploadEligible is behavior-identical -- not merely self-consistent).
function r2Oracle(name, data, opts = {}) {
    const minBytes = opts.minSize ?? 256;
    const isZst = name.endsWith('.zst');
    const hasZstdMagic = isZst && data.length >= 4 && data.readUInt32LE(0) === 0xFD2FB528;
    const passes = isZst ? (hasZstdMagic && data.length >= 16) : (data.length >= minBytes);
    const reason = passes ? null : (isZst ? `invalid zstd (${data.length}B)` : `${data.length}B < min ${minBytes}B`);
    return { passes, reason };
}

test('(F-A1 case 1) a required small non-.zst JSON < 256B is ELIGIBLE + INCLUDED (transported)', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    for (const t of ['cache/search-manifest.json', 'cache/fni-thresholds.json', 'cache/assertions/_summary.json']) {
        const f = m.files.find((x) => x.relative_path === t);
        assert.ok(f, `${t} must be an INCLUDED member`);
        assert.ok(f.size_bytes < DEFAULT_MIN_BYTES, `${t} must be below the 256B floor (proves class-scoped eligibility)`);
    }
    // the class-scoped mode is what admits them: default guard would REFUSE the 78B JSON.
    const searchBuf = fs.readFileSync(path.join(dir, 'cache/search-manifest.json'));
    assert.equal(isUploadEligible('cache/search-manifest.json', searchBuf).eligible, false); // default -> refuse
    assert.equal(isUploadEligible('cache/search-manifest.json', searchBuf, { requiredJson: true }).eligible, true);
    assert.equal(verifyDirAgainstManifest(dir, m).ok, true);
});

test('(F-A2 case 2) the optional MD5 sidecar is EXCLUDED ONLY by explicit class; set_sha invariant to it', () => {
    const withSidecar = cycleDir();
    const mWith = genCycle(withSidecar);
    assert.ok(!mWith.files.some((f) => f.relative_path === 'cache/rankings/all.json.zst.meta.json'));
    assert.ok(!mWith.files.some((f) => f.relative_path.endsWith('.meta.json')));
    // anti-vacuity: a manifest that SMUGGLES the excluded sidecar back into the required set reds
    // read-back FILE_MISSING (the uploader refuses it => it is never on disk in the read-back).
    const rbDir = cycleDir();
    fs.rmSync(path.join(rbDir, 'cache/rankings/all.json.zst.meta.json')); // uploader refused it (not staged)
    const smuggled = { ...mWith };
    const extra = { relative_path: 'cache/rankings/all.json.zst.meta.json', size_bytes: 18, sha256: 'a'.repeat(64) };
    smuggled.files = [...mWith.files, extra];
    smuggled.member_count = smuggled.files.length;
    smuggled.set_sha256 = computeSetSha256(smuggled.files);
    smuggled.required_file_classes = mWith.required_file_classes; // rankings re does not match a .meta.json name
    assert.equal(verifyDirAgainstManifest(rbDir, smuggled).code, 'FILE_MISSING');
    // set_sha256 is IDENTICAL with vs without the sidecar on disk (accelerator out of scope).
    const withoutSidecar = cycleDir();
    fs.rmSync(path.join(withoutSidecar, 'cache/rankings/all.json.zst.meta.json'));
    assert.equal(genCycle(withoutSidecar).set_sha256, mWith.set_sha256);
});

test('(F-A3 case 3) an invalid 11B .zst REQUIRED (authoritative) member fails LOUD MEMBER_UPLOAD_INELIGIBLE', () => {
    const dir = cycleDir({ 'cache/trending.json.zst': zstStub(11) }); // required-class .zst, sub-floor
    assert.throws(() => genCycle(dir), (e) => e instanceof HandoffManifestError && e.code === 'MEMBER_UPLOAD_INELIGIBLE');
});

test('(F-A4 case 4) the 11B OPTIONAL empty-placeholder alt frame is handled by explicit class ONLY (EXCLUDED, data-safe)', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    // the 11B sparse-category frame is NOT a member; the >=16B real alt frame IS.
    assert.ok(!m.files.some((f) => f.relative_path === 'cache/relations/alt-by-category/sparse.json.zst'));
    assert.ok(m.files.some((f) => f.relative_path === 'cache/relations/alt-by-category/dense.json.zst'));
    assert.equal(verifyDirAgainstManifest(dir, m).ok, true); // the 11B frame never blocks read-back
    // it is EXCLUDED as a PLACEHOLDER (by size), not skipped as a generic bad file: a corrupt
    // >=16B (no-magic) alt frame is INCLUDED authoritative => fails LOUD MEMBER_UPLOAD_INELIGIBLE.
    assert.throws(() => genCycle(cycleDir({ 'cache/relations/alt-by-category/corrupt.json.zst': Buffer.alloc(20, 65) })),
        (e) => e instanceof HandoffManifestError && e.code === 'MEMBER_UPLOAD_INELIGIBLE');
});

test('(F-A5 case 5) an UNKNOWN (non-JSON-family) cache member fails LOUD UNCLASSIFIED_MEMBER (generate AND verify)', () => {
    assert.throws(() => genCycle(cycleDir({ 'cache/mystery.bin': 'WHO-DIS' })),
        (e) => e instanceof HandoffManifestError && e.code === 'UNCLASSIFIED_MEMBER');
    // consistent-by-construction: the SAME classification governs verify enumeration.
    const clean = cycleDir();
    const m = genCycle(clean);
    fs.writeFileSync(path.join(clean, 'cache/mystery.bin'), 'WHO-DIS');
    assert.equal(verifyDirAgainstManifest(clean, m).code, 'UNCLASSIFIED_MEMBER');
});

test('(F-A6 case 6) generate == upload-eligibility consistent-by-construction: an included member the guard would refuse => MEMBER_UPLOAD_INELIGIBLE', () => {
    // an authoritative (non-transport) small .json is included by shape but the DEFAULT guard
    // refuses it => generate fails loud (never a silently-unsatisfiable manifest -> FILE_MISSING).
    const smallAuth = cycleDir({ 'cache/knowledge/tiny.json': smallJson({ a: 1 }) }); // 7B, not a transport name
    assert.throws(() => genCycle(smallAuth), (e) => e instanceof HandoffManifestError && e.code === 'MEMBER_UPLOAD_INELIGIBLE');
    // a truncated/garbage TRANSPORT JSON also fails loud (corrupt required member; case 11).
    const badTransport = cycleDir({ 'cache/search-manifest.json': Buffer.from('{not json') });
    assert.throws(() => genCycle(badTransport), (e) => e instanceof HandoffManifestError && e.code === 'MEMBER_UPLOAD_INELIGIBLE');
    const emptyTransport = cycleDir({ 'cache/fni-thresholds.json': '{}' }); // empty object => not non-empty
    assert.throws(() => genCycle(emptyTransport), (e) => e instanceof HandoffManifestError && e.code === 'MEMBER_UPLOAD_INELIGIBLE');
});

test('(F-A7 case 7) read-back exact-set PASSES for the accepted (classified) set', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    const res = verifyDirAgainstManifest(dir, m); // the accepted set = INCLUDED members only
    assert.equal(res.ok, true);
    assert.equal(res.set_sha256, m.set_sha256);
});

test('(F-A8 case 8) read-back FAILS on a missing required member (fail-closed unchanged)', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    fs.rmSync(path.join(dir, 'cache/search-manifest.json')); // a required transport member vanished
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_MISSING');
});

test('(F-A9 case 9) read-back FAILS on an extra unexpected member', () => {
    const dir = cycleDir();
    const m = genCycle(dir);
    fs.writeFileSync(path.join(dir, 'cache/unexpected.json.zst'), zst(20, 'u')); // extra authoritative member
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_EXTRA');
});

test('(F-A10 case 10) the accepted set is DETERMINISTic (same dir bytes => same member set + set_sha)', () => {
    const a = genCycle(cycleDir());
    const b = genCycle(cycleDir());
    assert.equal(a.set_sha256, b.set_sha256);
    assert.deepEqual(a.files.map((f) => f.relative_path).sort(), b.files.map((f) => f.relative_path).sort());
    // membership is class/size-driven, NOT etag/content-skip: mutating an EXCLUDED accelerator's
    // bytes does not change the set_sha256 (still the same accepted set).
    const d = cycleDir({ 'cache/rankings/all.json.zst.meta.json': '{"checksum":"OTHER-BYTES-HERE"}' });
    assert.equal(genCycle(d).set_sha256, a.set_sha256);
});

test('(F-A11 case 11) NO fixed-prefix / latest / predecessor substitution in the authority derivation', () => {
    assert.equal(buildStagingPrefix('cycle-output-authority', 'F1', '2'), 'state/_handoff/cycle-output/F1/attempt-2/');
    const m = genCycle(cycleDir());
    for (const bad of [
        'state/cycle-output/',                                       // fixed compat prefix
        'state/_handoff/cycle-output/F1/attempt-latest/',            // mutable latest
        'state/_handoff/cycle-output/F1/',                           // one-level (no attempt)
        'state/_handoff/cycle-output/latest/attempt-2/',            // latest run
        'state/_handoff/cycle-output/F1/U1/attempt-2/',            // two-level upstream token
    ]) {
        assert.equal(verifyDescriptor({ ...descFor(m), exact_staging_prefix: bad }, curConsumer()).code, 'DESC_PREFIX_MISMATCH');
    }
    // the prefix is DERIVED (buildStagingPrefix), never obtained by listing R2 to guess latest.
    assert.ok(!readSrc('./cycle-output-handoff-manifest.mjs').includes('ListObjectsV2'));
    for (const bad of ['etag', 'ETag', 'If-None-Match', 'md5']) assert.ok(!readSrc('./cycle-output-handoff-manifest.mjs').includes(bad));
});

test('(F-A12 case 12) the guard DEFAULT path is byte-identical for a NON-classified caller (256B floor preserved)', () => {
    const battery = [
        ['x.zst', zst(11, 'q')],            // 11B zstd (magic, < 16) => ineligible
        ['x.zst', zst(15, 'q')],            // 15B zstd => ineligible
        ['x.zst', zst(16, 'q')],            // 16B zstd => ELIGIBLE
        ['x.json', Buffer.alloc(255, 65)],  // 255B json => ineligible (default floor)
        ['x.json', Buffer.alloc(256, 65)],  // 256B json => ELIGIBLE
        ['y.zst', Buffer.alloc(20, 65)],    // 20B .zst NO magic => ineligible
        ['x.json', Buffer.from('{"ok":1}')],// 8B VALID json but NON-classified => ineligible (no floor lowering)
    ];
    for (const [name, buf] of battery) {
        const got = isUploadEligible(name, buf); // NO requiredJson => default path
        const exp = r2Oracle(name, buf);
        assert.equal(got.eligible, exp.passes, `verdict ${name} len=${buf.length}`);
        assert.equal(got.reason, exp.reason, `reason ${name} len=${buf.length}`);
    }
    assert.equal(ZSTD_MIN_BYTES, 16);      // floors are the EXACT guard constants (no relaxation)
    assert.equal(DEFAULT_MIN_BYTES, 256);
    // the class-scoped mode is NON-.zst only + rejects garbage/empty; a .meta.json sidecar is
    // never required-JSON eligible (so the class flag never uploads a checksum sidecar).
    assert.equal(isUploadEligible('a.json.zst', zst(11), { requiredJson: true }).eligible, false); // .zst unaffected
    assert.equal(isUploadEligible('a.json.zst.meta.json', Buffer.from('{"checksum":"x"}'), { requiredJson: true }).eligible, false);
    assert.equal(isNonEmptyJson(Buffer.from('{}')), false);
    assert.equal(isNonEmptyJson(Buffer.from('[]')), false);
    assert.equal(isNonEmptyJson(Buffer.from('null')), false);
    assert.equal(isNonEmptyJson(Buffer.from('{"a":1}')), true);
});

test('(F-SRC) whole-seam consistency SOURCE lock: r2-handoff threads requiredJson + CLI parses --required-json + producer step passes it', () => {
    // the extracted predicate remains the single source (default path == the original oracle).
    for (const [name, buf, opts] of [['x.json', Buffer.alloc(255, 65), {}], ['x.zst', zst(11), {}], ['x.zst', zst(16), {}]]) {
        const got = isUploadEligible(name, buf, opts);
        const exp = r2Oracle(name, buf, {});
        assert.equal(got.eligible, exp.passes);
        assert.equal(got.reason, exp.reason);
    }
    // r2-handoff.js applies isUploadEligible AND threads the opt-in requiredJson (no inline predicate).
    const r2 = readSrc('./lib/r2-handoff.js');
    assert.match(r2, /import\s*\{\s*isUploadEligible\s*\}\s*from\s*'\.\/upload-eligibility\.js'/);
    assert.match(r2, /isUploadEligible\(localPath,\s*data,\s*\{[^}]*requiredJson/);
    assert.match(r2, /backupFileToR2\(localPath,\s*r2Key,\s*\{\s*requiredJson\s*\}\)/);
    assert.ok(!r2.includes('0xFD2FB528'), 'magic literal must live ONLY in upload-eligibility.js');
    // the manifest module imports the SAME predicate (single source of truth).
    const mf = readSrc('./cycle-output-handoff-manifest.mjs');
    assert.match(mf, /import\s*\{\s*isUploadEligible,\s*ZSTD_MIN_BYTES\s*\}\s*from\s*'\.\/lib\/upload-eligibility\.js'/);
    // the CLI parses --required-json for backup-dir and the producer step opts in.
    const cli = readSrc('./r2-workflow-cli.js');
    assert.match(cli, /requiredJson:\s*rest\.includes\('--required-json'\)/);
    const wf = readSrc('../../.github/workflows/factory-aggregate.yml');
    assert.match(wf, /backup-dir output\/cache\/ "\$\{STAGING\}cache\/" --required-json/);
});

test('(F-SRC2) consumer absent == present-empty proves the alt-frame EXCLUDE is data-safe (SOURCE lock)', () => {
    // knowledge-cache-reader.fetchCategoryAlts returns [] for BOTH an absent and an empty alt
    // payload (data?.relations || []), so dropping the empty-{} placeholder loses no served data.
    const kr = readSrc('../../src/utils/knowledge-cache-reader.js');
    assert.match(kr, /return\s+data\?\.relations\s*\|\|\s*\[\]/);
    assert.match(kr, /return\s+\[\]/); // catch/guard path also returns []
});
