// scripts/factory/cycle-output-handoff-manifest.test.mjs
//
// Hermetic node:test suite for the Factory 3/4 finalize -> 4/4 consumers
// R2-authoritative cycle-output handoff verifier of record
// (carrier "cycle-output-authority"), Founder D-2026-0704-264 (FIX-2 / GAP-2 / C12).
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
//   * producer read-back fail-closed-> (H10) a manifest over set A vs a disk holding set B => verify reds (drives the
//                                       workflow read-back that gates "authority established").
//   * no-registry-double-bind       -> (H11) a cache/registry/ or global-registry* member is EXCLUDED at generate AND
//                                       REGISTRY_DOUBLE_BIND-rejected at verify; drop the exclude => the set re-binds registry.
//   * prefix derivation             -> (H13) fixed/latest/two-level prefix => DESC_PREFIX_MISMATCH.
//   * head_sha well-formedness      -> (H14) non-git-sha head => DESC_HEAD_SHA_INVALID.
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
// A minimal-but-complete cycle-output workspace: the finalize output/ tree with a
// cache/ subtree satisfying every required-class floor. baseDir is the output/ root
// (memberRoot `cache`). Includes an output/data/ sibling that MUST be ignored.
function cycleDir(over = {}, dataOver = {}) {
    const base = writeFiles(mkTmp(), {
        'cache/mesh/graph.json': 'GRAPH',
        'cache/mesh/stats.json': 'STATS',
        'cache/search-core.json.zst': 'SEARCHCORE',
        'cache/category_stats.json': 'CATSTATS',
        'cache/knowledge/index.json.zst': 'KIDX',
        'cache/knowledge/articles/a-1.json.zst': 'ART1',
        'cache/knowledge/articles/a-2.json.zst': 'ART2',
        'cache/trending.json.zst': 'TREND',
        'cache/rankings/all.json.zst': 'RALL',
        'cache/rankings/model.json.zst': 'RMODEL',
        ...over,
    });
    // output/data/ sibling (4/4-owned; the carrier must NEVER walk it).
    writeFiles(base, { 'data/meta-00.db': 'METADB', 'data/rankings-all.db': 'RANKDB', ...dataOver });
    return base;
}
const CTX = { carrierType: 'cycle-output-authority', finalizeRunId: 'F1', upstreamRunId: 'U1', producerAttempt: '2', headSha: SHA, createdAt: '1970-01-01T00:00:00.000Z' };
function genCycle(dir, over = {}) { return generateManifest(dir, { ...CTX, ...over }); }
// The run-scoped descriptor the workflow writes (manifest_sha256 = sha of the manifest file).
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
    assert.ok(m.files.some((f) => f.relative_path === 'cache/mesh/graph.json'));
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
    fs.writeFileSync(path.join(dir, 'cache/foreign-cycle.json.zst'), 'MIXED'); // mixed-cycle leftover
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
    fs.writeFileSync(path.join(dir, 'cache/mesh/graph.json'), 'GRAPH-LONGER');
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'SIZE_MISMATCH');
    const dir2 = cycleDir();
    const m2 = genCycle(dir2);
    fs.writeFileSync(path.join(dir2, 'cache/mesh/graph.json'), 'XXXXX'); // same length (5) diff content
    assert.equal(verifyDirAgainstManifest(dir2, m2).code, 'HASH_MISMATCH');
});
test('(H7 anti-vacuity: partial/below-floor) a metadata-missing set fails closed at generate AND verify', () => {
    // Remove the mesh graph => mesh_graph floor (min 1) violated at generate.
    const noMesh = cycleDir();
    fs.rmSync(path.join(noMesh, 'cache/mesh/graph.json'));
    assert.throws(() => genCycle(noMesh), (e) => e instanceof HandoffManifestError && e.code === 'REQUIRED_CLASS_BELOW_FLOOR');
    // A manifest declaring the full set against a disk missing a metadata file => FILE_MISSING (never count-lenient).
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
    // The workflow producer read-back restores the staging to a temp dir + verifies the
    // manifest against it; a partial/corrupt upload (set B != manifest set A) MUST red so
    // the producer never emits "authority established" on a false authority.
    const dirA = cycleDir();
    const mA = genCycle(dirA);
    const dirB = cycleDir({ 'cache/rankings/extra.json.zst': 'EXTRA' }); // a superset upload
    assert.equal(verifyDirAgainstManifest(dirB, mA).code, 'FILE_EXTRA');
    const dirC = cycleDir();
    fs.rmSync(path.join(dirC, 'cache/trending.json.zst')); // a subset upload (partial)
    assert.equal(verifyDirAgainstManifest(dirC, mA).code, 'FILE_MISSING');
});
test('(H11 no-registry-double-bind) a cache/registry/ or global-registry* member is EXCLUDED at generate + REJECTED at verify', () => {
    // (a) A registry subtree + global-registry monolith placed under output/cache/ are NEVER walked into the set.
    const dir = cycleDir({
        'cache/registry/part-0.bin': 'REGBIN',
        'cache/registry/part-1.bin': 'REGBIN2',
        'cache/global-registry.json.zst': 'GLOBALREG',
    });
    const m = genCycle(dir);
    assert.ok(!m.files.some((f) => f.relative_path.startsWith('cache/registry/')));
    assert.ok(!m.files.some((f) => f.relative_path === 'cache/global-registry.json.zst'));
    // listCarrierFiles is the shared enumerator => the same exclusion holds at verify enumeration.
    const names = listCarrierFiles(dir, carrierConfig('cycle-output-authority'));
    assert.ok(!names.some((n) => n.includes('/registry/') || /(^|\/)global-registry/.test(n)));
    // A verified-clean manifest still passes against that dir (registry files ignored on both sides).
    assert.equal(verifyDirAgainstManifest(dir, m).ok, true);
    // (b) A tampered manifest that SMUGGLES a registry member in is rejected REGISTRY_DOUBLE_BIND
    // (the verify-side guard, proving the exclusion is not merely a generate-side convenience).
    const smuggled = { ...m, files: [...m.files, { relative_path: 'cache/registry/part-0.bin', size_bytes: 6, sha256: 'e'.repeat(64) }] };
    smuggled.set_sha256 = computeSetSha256(smuggled.files);
    assert.equal(verifyDirAgainstManifest(dir, smuggled).code, 'REGISTRY_DOUBLE_BIND');
});
test('(H11b) a non-registry file whose name merely contains "registry" is NOT excluded', () => {
    const dir = cycleDir({ 'cache/knowledge/registry-notes.json.zst': 'NOTES' });
    const m = genCycle(dir);
    assert.ok(m.files.some((f) => f.relative_path === 'cache/knowledge/registry-notes.json.zst'));
});

// ==========================================================================
// D. listCarrierFiles -- safety (symlink / traversal) + reserved exclusion
// ==========================================================================
test('(D1) listCarrierFiles rejects a symlink member (UNSAFE_MEMBER)', () => {
    const dir = cycleDir();
    let made = false;
    try { fs.symlinkSync(path.join(dir, 'cache/mesh/graph.json'), path.join(dir, 'cache/mesh/graph-link.json')); made = true; }
    catch { /* Windows without privilege -- skip */ }
    if (!made) return;
    assert.throws(() => listCarrierFiles(dir, carrierConfig('cycle-output-authority')), (e) => e instanceof HandoffManifestError && e.code === 'UNSAFE_MEMBER');
});
test('(D2) reserved exclusion: staging sidecars (manifest.json/handoff.json at root) never members; */_manifest.json dropped at any depth', () => {
    const dir = cycleDir({ 'cache/_manifest.json': 'BACKUP-SIDECAR', 'cache/mesh/_manifest.json': 'BACKUP-SIDECAR' });
    // manifest.json / handoff.json at the STAGING ROOT are outside cache/ => never members anyway.
    writeFiles(dir, { 'manifest.json': 'ROOT', 'handoff.json': 'ROOT' });
    const names = listCarrierFiles(dir, carrierConfig('cycle-output-authority'));
    assert.ok(!names.includes('cache/_manifest.json'));      // r2-handoff internal sidecar dropped
    assert.ok(!names.includes('cache/mesh/_manifest.json')); // ...at any depth
    assert.ok(!names.includes('manifest.json'));             // outside cache/ (not a member)
    assert.ok(names.includes('cache/mesh/graph.json'));      // real member kept
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
    // when a consumer DOES supply runAttempt, producer_attempt > it is rejected (optional same-run bound).
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
    assert.equal(verifyDescriptor(descFor(m), curConsumer()).ok, true); // 4/4 supplies no headSha (cannot know 3/4 sha)
    assert.equal(verifyDescriptor(descFor(m), curConsumer({ headSha: 'c'.repeat(40) })).code, 'DESC_HEAD_SHA_MISMATCH');
});
