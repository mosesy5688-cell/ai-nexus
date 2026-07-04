// scripts/factory/shards-handoff-manifest.test.mjs
//
// Hermetic node:test suite for the Factory 2/4 -> 3/4 shards R2-authoritative
// handoff verifier of record (PRIMARY "shards-authority") + the intra-2/4
// prepared-entity-data predecessor (GAP-5 "prepared-entity-data-authority"),
// Founder D-2026-0704-262 (FIX-3 / C10 + GAP-5). NO network, NO R2, NO @aws-sdk:
// the pure generate/verify/verify-descriptor module is driven over REAL temp
// dirs (node built-ins only). Covers the E1-E6 + exact-20 + GAP-5 families.
//
// ANTI-VACUITY MAP (removing/weakening a guard reds >=1 named test):
//   * set_sha256 verify            -> (C5) MUTATION: drop the SET_HASH_MISMATCH check => (C5) green-when-tampered.
//   * EXACT-20 membership          -> (C7)/(C8) 21/19 shard sets; weaken to a >=20 floor => (C8) 21-set passes.
//   * per-file sha256              -> (C4) same-length tamper => HASH_MISMATCH; drop => (C4) red.
//   * FILE_EXTRA (foreign in set)  -> (C3) a foreign cache file must red; drop the extra check => (C3) green.
//   * descriptor process-run bind  -> (E2) foreign process_run_id => DESC_PROCESS_RUN_MISMATCH; drop => (E2) green.
//   * descriptor prefix derivation -> (E5)/(E7) fixed/latest/predecessor prefix => DESC_PREFIX_MISMATCH.
//   * descriptor attempt bind      -> (E3) producer_attempt>run_attempt (intra) => DESC_ATTEMPT_FUTURE.
//   * head_sha well-formedness     -> (E8) non-git-sha head => DESC_HEAD_SHA_INVALID.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
    SCHEMA_VERSION, COMPLETION_STATE, SHARD_TOTAL, CARRIERS, HandoffManifestError,
    isSha256Hex, isGitSha, computeSetSha256, listCarrierFiles, carrierConfig,
    buildStagingPrefix, generateManifest, verifyDirAgainstManifest, verifyDescriptor,
} from './shards-handoff-manifest.mjs';

const SHA = 'a'.repeat(40);
let TMP_SEQ = 0;
function mkTmp() { const d = path.join(os.tmpdir(), `shards-handoff-${process.pid}-${Date.now()}-${TMP_SEQ++}`); fs.mkdirSync(d, { recursive: true }); return d; }
function writeFiles(dir, files) {
    for (const [rel, body] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
    }
    return dir;
}
// 20 processing shards (shard-0.json.zst .. shard-19.json.zst) = the exact set.
function shardsDir(over = {}) {
    const f = {};
    for (let i = 0; i < SHARD_TOTAL; i += 1) f[`shard-${i}.json.zst`] = `SHARD-${i}`;
    return writeFiles(mkTmp(), { ...f, ...over });
}
// prepared-entity-data workspace: data/ (manifest + merged shards) + cache/ (unfiltered).
function prepDir(over = {}) {
    return writeFiles(mkTmp(), {
        'data/manifest.json': '{"total_entities":90000}',
        'data/merged_shard_000.json.zst': 'MS0',
        'data/merged_shard_001.json.zst': 'MS1',
        'cache/entity-checksums.json.zst': 'CK',
        'cache/daily-accum.json.zst': 'DA',
        ...over,
    });
}
const SHARDS_CTX = { carrierType: 'shards-authority', processRunId: 'P1', upstreamRunId: 'H1', producerAttempt: '2', headSha: SHA, createdAt: '1970-01-01T00:00:00.000Z' };
const PREP_CTX = { carrierType: 'prepared-entity-data-authority', processRunId: 'P1', upstreamRunId: 'H1', producerAttempt: '2', headSha: SHA, createdAt: '1970-01-01T00:00:00.000Z' };
function genShards(dir, over = {}) { return generateManifest(dir, { ...SHARDS_CTX, ...over }, {}); }
function genPrep(dir, over = {}) { return generateManifest(dir, { ...PREP_CTX, ...over }, {}); }
// The run-scoped descriptor the workflow writes (manifest_sha256 = sha of the manifest file).
function descFor(manifest) {
    return {
        schema_version: SCHEMA_VERSION, carrier_type: manifest.carrier_type,
        process_run_id: manifest.process_run_id, producer_attempt: manifest.producer_attempt,
        exact_staging_prefix: manifest.exact_staging_prefix,
        manifest_sha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
        set_sha256: manifest.set_sha256, head_sha: manifest.head_sha, created_at: manifest.created_at_utc,
    };
}
// INTER-workflow consumer (shards, 3/4): NO runAttempt / NO headSha binding.
function curInter(over = {}) { return { carrierType: 'shards-authority', processRunId: 'P1', ...over }; }
// INTRA-workflow consumer (prepared-entity-data, matrix in same 2/4 run): runAttempt bound.
function curIntra(over = {}) { return { carrierType: 'prepared-entity-data-authority', processRunId: 'P1', runAttempt: '2', ...over }; }

// ==========================================================================
// A. Config / constants / hashing
// ==========================================================================
test('(A1) carrier registry: two DISTINCT prefix roots + producer jobs; exact-20 only on shards', () => {
    assert.deepEqual(Object.keys(CARRIERS).sort(), ['prepared-entity-data-authority', 'shards-authority']);
    assert.equal(carrierConfig('shards-authority').prefixRoot, 'state/_handoff/shards');
    assert.equal(carrierConfig('prepared-entity-data-authority').prefixRoot, 'state/_handoff/prepared-entity-data');
    assert.equal(carrierConfig('shards-authority').exactMembers.length, 20);
    assert.equal(carrierConfig('prepared-entity-data-authority').exactMembers, undefined);
    assert.throws(() => carrierConfig('bogus'), (e) => e instanceof HandoffManifestError && e.code === 'CARRIER_UNKNOWN');
});
test('(A2) buildStagingPrefix binds process-run + attempt; NEVER a latest/fixed/two-level token', () => {
    assert.equal(buildStagingPrefix('shards-authority', 'P1', '2'), 'state/_handoff/shards/P1/attempt-2/');
    assert.equal(buildStagingPrefix('prepared-entity-data-authority', 'P1', '3'), 'state/_handoff/prepared-entity-data/P1/attempt-3/');
    assert.ok(!buildStagingPrefix('shards-authority', 'P1', '2').includes('latest'));
    assert.ok(!buildStagingPrefix('shards-authority', 'P1', '2').includes('state/shards/'));
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
// B. generateManifest — field set + exact-20 + floors + reserved exclusion
// ==========================================================================
test('(B1) shards manifest emits the full field set + member_count 20; no self-hash', () => {
    const m = genShards(shardsDir());
    assert.equal(m.schema_version, SCHEMA_VERSION);
    assert.equal(m.carrier_type, 'shards-authority');
    assert.equal(m.process_run_id, 'P1');
    assert.equal(m.upstream_run_id, 'H1');
    assert.equal(m.producer_job_identity, 'save-shards-cache');
    assert.equal(m.producer_attempt, 2);
    assert.equal(m.head_sha, SHA);
    assert.equal(m.exact_staging_prefix, 'state/_handoff/shards/P1/attempt-2/');
    assert.equal(m.completion_state, COMPLETION_STATE);
    assert.equal(m.member_count, 20);
    assert.equal(m.file_count, 20);
    assert.deepEqual(m.required_file_classes, [{ name: 'shard', min: 20, count: 20 }]);
    assert.ok(isSha256Hex(m.set_sha256));
    assert.ok(!('manifest_sha256' in m));
    assert.ok(m.files.every((f) => isSha256Hex(f.sha256) && Number.isInteger(f.size_bytes)));
});
test('(B2) reserved sidecars (manifest.json/handoff.json/_manifest.json) are NEVER shard members', () => {
    const dir = shardsDir({ 'manifest.json': '{}', 'handoff.json': '{}', '_manifest.json': '{}' });
    const m = genShards(dir);
    for (const f of m.files) assert.ok(!['manifest.json', 'handoff.json', '_manifest.json'].includes(f.relative_path));
    assert.equal(m.file_count, 20);
});
test('(B3) shards ext filter includes ONLY *.json.zst (a stray non-zst is excluded, not archived)', () => {
    const m = genShards(shardsDir({ 'notes.txt': 'x', 'index.json': '{}' }));
    assert.equal(m.file_count, 20);
    assert.ok(!m.files.some((f) => f.relative_path === 'notes.txt' || f.relative_path === 'index.json'));
});
test('(B4) prepared-entity-data manifest: multi-root data/+cache/, class floors, EXACT-set (no fixed count)', () => {
    const m = genPrep(prepDir());
    assert.equal(m.carrier_type, 'prepared-entity-data-authority');
    assert.equal(m.producer_job_identity, 'prepare-data');
    assert.equal(m.member_count, m.file_count); // no exactMembers => member_count == file_count
    const byName = Object.fromEntries(m.required_file_classes.map((c) => [c.name, c]));
    assert.equal(byName.data_manifest.count, 1);
    assert.equal(byName.merged_shard.count, 2);
    assert.ok(m.files.some((f) => f.relative_path === 'data/manifest.json'));
    assert.ok(m.files.some((f) => f.relative_path === 'cache/entity-checksums.json.zst'));
});

// ==========================================================================
// C. verifyDirAgainstManifest — exact set + per-file + set hash + floors + exact-20
// ==========================================================================
test('(C1 positive) manifest verifies against its own dir; returns set_sha + file count', () => {
    const dir = shardsDir();
    const m = genShards(dir);
    const res = verifyDirAgainstManifest(dir, m);
    assert.equal(res.ok, true);
    assert.equal(res.set_sha256, m.set_sha256);
    assert.equal(res.file_count, 20);
});
test('(C2) FILE_MISSING when a manifest member is absent on disk (manifest without payload)', () => {
    const dir = shardsDir();
    const m = genShards(dir);
    fs.rmSync(path.join(dir, 'shard-5.json.zst'));
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_MISSING');
});
test('(C3 anti-vacuity: FILE_EXTRA) a foreign/predecessor shard on disk NOT in the manifest reds verify', () => {
    const dir = shardsDir();
    const m = genShards(dir);
    fs.writeFileSync(path.join(dir, 'shard-99.json.zst'), 'FOREIGN'); // predecessor/foreign name
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_EXTRA');
});
test('(C4 anti-vacuity: per-file sha) SIZE_MISMATCH + HASH_MISMATCH on tampered bytes', () => {
    const dir = shardsDir();
    const m = genShards(dir);
    fs.writeFileSync(path.join(dir, 'shard-0.json.zst'), 'SHARD-0-LONGER');
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'SIZE_MISMATCH');
    const dir2 = shardsDir();
    const m2 = genShards(dir2);
    fs.writeFileSync(path.join(dir2, 'shard-0.json.zst'), 'XXXXXXX'); // same length (7) diff content
    assert.equal(verifyDirAgainstManifest(dir2, m2).code, 'HASH_MISMATCH');
});
test('(C5 anti-vacuity: set-hash verify) mutating set_sha256 in the manifest reds verify', () => {
    const dir = shardsDir();
    const m = genShards(dir);
    assert.equal(verifyDirAgainstManifest(dir, { ...m, set_sha256: 'f'.repeat(64) }).code, 'SET_HASH_MISMATCH');
});
test('(C6) manifest carrying its own manifest_sha256 => MANIFEST_SELF_HASH; malformed/unknown carrier rejected', () => {
    const dir = shardsDir();
    const m = genShards(dir);
    assert.equal(verifyDirAgainstManifest(dir, { ...m, manifest_sha256: 'd'.repeat(64) }).code, 'MANIFEST_SELF_HASH');
    assert.equal(verifyDirAgainstManifest(mkTmp(), null).code, 'MANIFEST_MALFORMED');
    assert.equal(verifyDirAgainstManifest(mkTmp(), { carrier_type: 'nope', files: [] }).code, 'CARRIER_UNKNOWN');
});
test('(C7) EXACT-20: a 19-shard set fails closed at generate (floor) and verify (below-floor)', () => {
    const dir = shardsDir();
    fs.rmSync(path.join(dir, 'shard-19.json.zst'));
    assert.throws(() => genShards(dir), (e) => e instanceof HandoffManifestError && e.code === 'REQUIRED_CLASS_BELOW_FLOOR');
    // A manifest declaring 20 but disk holding 19 => FILE_MISSING (never count-lenient).
    const full = genShards(shardsDir());
    assert.equal(verifyDirAgainstManifest(dir, full).code, 'FILE_MISSING');
});
test('(C8 anti-vacuity: EXACT-20 not a >=20 floor) a 21-shard set is REJECTED (MEMBER_SET_NOT_EXACT), never accepted', () => {
    const dir = shardsDir({ 'shard-20.json.zst': 'EXTRA' }); // 21 shards: passes a >=20 floor, must FAIL exact-20
    assert.throws(() => genShards(dir), (e) => e instanceof HandoffManifestError && e.code === 'MEMBER_SET_NOT_EXACT');
    // And at verify: a 20-member manifest against a 21-member disk => FILE_EXTRA (exact set).
    const m20 = genShards(shardsDir());
    assert.equal(verifyDirAgainstManifest(dir, m20).code, 'FILE_EXTRA');
});
test('(C9) member_count tamper (declared != exact-20) => MEMBER_COUNT_MISMATCH', () => {
    const dir = shardsDir();
    const m = genShards(dir);
    assert.equal(verifyDirAgainstManifest(dir, { ...m, member_count: 19 }).code, 'MEMBER_COUNT_MISMATCH');
});
test('(C10) path-traversal member in the manifest => never verified (FILE_MISSING/UNSAFE_MEMBER)', () => {
    const dir = shardsDir();
    const m = genShards(dir);
    const evil = { ...m, files: m.files.map((f, i) => (i === 0 ? { relative_path: '../../etc/x', size_bytes: f.size_bytes, sha256: f.sha256 } : f)) };
    assert.ok(['FILE_MISSING', 'UNSAFE_MEMBER'].includes(verifyDirAgainstManifest(dir, evil).code));
});
test('(C11 GAP-5) prepared-entity-data verifies; recursive data/+cache/ members; floors enforced', () => {
    const dir = prepDir();
    const m = genPrep(dir);
    assert.equal(verifyDirAgainstManifest(dir, m).ok, true);
    // remove the sole manifest => data_manifest floor (min 1) violated at generate.
    const noManifest = prepDir();
    fs.rmSync(path.join(noManifest, 'data/manifest.json'));
    assert.throws(() => genPrep(noManifest), (e) => e instanceof HandoffManifestError && e.code === 'REQUIRED_CLASS_BELOW_FLOOR');
});
test('(C12 GAP-5 anti-vacuity: partial/mixed set) a mixed-cycle prepared set (extra cache file) reds verify', () => {
    const dir = prepDir();
    const m = genPrep(dir);
    fs.writeFileSync(path.join(dir, 'cache/foreign-cycle.json.zst'), 'MIXED');
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_EXTRA'); // never proceeds on a mixed set
});
test('(C13 anti-vacuity: VERIFY-SIDE exact-20 pin) a self-consistent NON-canonical 20-member manifest reds verify', () => {
    // {shard-0..18, shard-99}: 20 shard-shaped members => the class floor (min-20 SHARD_RE)
    // is SATISFIED, member_count 20 MATCHES, set_sha256 is self-consistent, and the disk
    // files MATCH the manifest exactly (no FILE_MISSING/FILE_EXTRA). So the VERIFY-SIDE
    // assertExactMembersOrThrow is the SOLE guard that can catch it -- proving that check is
    // executable, not merely implied by the generate-side guard or the descriptor set_sha bind.
    const names = [];
    for (let i = 0; i < 19; i += 1) names.push(`shard-${i}.json.zst`);
    names.push('shard-99.json.zst'); // shard-shaped (matches SHARD_RE) but NON-canonical index
    const over = {};
    for (const n of names) over[n] = `NC-${n}`;
    const dir = writeFiles(mkTmp(), over); // exactly the 20 non-canonical members on disk
    const files = names.slice().sort().map((n) => {
        const buf = fs.readFileSync(path.join(dir, n));
        return { relative_path: n, size_bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    });
    const manifest = {
        schema_version: SCHEMA_VERSION, carrier_type: 'shards-authority', process_run_id: 'P1',
        producer_attempt: 2, head_sha: SHA, exact_staging_prefix: 'state/_handoff/shards/P1/attempt-2/',
        completion_state: COMPLETION_STATE, member_count: 20,
        required_file_classes: [{ name: 'shard', min: 20, count: 20 }],
        file_count: 20, total_bytes: files.reduce((s, f) => s + f.size_bytes, 0),
        files, set_sha256: computeSetSha256(files), // self-consistent set hash over the actual members
    };
    // Class floor (20>=20) + member_count (20) + set_sha256 all AGREE; the EXACT-20 membership
    // assertion is the sole discriminator. Removing assertExactMembersOrThrow in the verify body
    // of shards-handoff-manifest.mjs (~L230-232) turns this GREEN => genuine red-on-removal pin.
    assert.equal(verifyDirAgainstManifest(dir, manifest).code, 'MEMBER_SET_NOT_EXACT');
});

// ==========================================================================
// D. listCarrierFiles — safety (symlink / traversal) + reserved exclusion
// ==========================================================================
test('(D1) listCarrierFiles rejects a symlink member (UNSAFE_MEMBER)', () => {
    const dir = shardsDir();
    let made = false;
    try { fs.symlinkSync(path.join(dir, 'shard-0.json.zst'), path.join(dir, 'shard-link.json.zst')); made = true; }
    catch { /* Windows without privilege — skip */ }
    if (!made) return;
    assert.throws(() => listCarrierFiles(dir, carrierConfig('shards-authority')), (e) => e instanceof HandoffManifestError && e.code === 'UNSAFE_MEMBER');
});
test('(D2) reserved exclusion is depth-aware: data/manifest.json kept; */_manifest.json dropped', () => {
    const dir = prepDir({ 'data/_manifest.json': 'BACKUP-SIDECAR', 'cache/_manifest.json': 'BACKUP-SIDECAR', 'manifest.json': 'ROOT-SIDECAR' });
    const names = listCarrierFiles(dir, carrierConfig('prepared-entity-data-authority'));
    assert.ok(names.includes('data/manifest.json'));       // real member kept
    assert.ok(!names.includes('data/_manifest.json'));     // r2-handoff internal sidecar dropped
    assert.ok(!names.includes('cache/_manifest.json'));    // ...at any depth
    assert.ok(!names.includes('manifest.json'));           // root handoff sidecar dropped
});

// ==========================================================================
// E. verifyDescriptor — provenance (process-run + attempt + head + prefix)
// ==========================================================================
test('(E1 positive) INTER-workflow descriptor verifies (no runAttempt bind); emits derived staging + set hash', () => {
    const m = genShards(shardsDir());
    const res = verifyDescriptor(descFor(m), curInter());
    assert.equal(res.ok, true);
    assert.equal(res.staging_prefix, 'state/_handoff/shards/P1/attempt-2/');
    assert.equal(res.set_sha256, m.set_sha256);
    assert.equal(res.producer_attempt, 2);
});
test('(E2 anti-vacuity: process-run bind) foreign/predecessor process_run_id rejected', () => {
    const m = genShards(shardsDir());
    assert.equal(verifyDescriptor(descFor(m), curInter({ processRunId: 'P-OTHER' })).code, 'DESC_PROCESS_RUN_MISMATCH');
});
test('(E3 anti-vacuity: attempt bind, INTRA) producer_attempt > current run_attempt rejected; 0 invalid', () => {
    const m = genPrep(prepDir(), { producerAttempt: '5' });
    assert.equal(verifyDescriptor(descFor(m), curIntra({ runAttempt: '2' })).code, 'DESC_ATTEMPT_FUTURE');
    assert.equal(verifyDescriptor({ ...descFor(m), producer_attempt: 0 }, curIntra({ runAttempt: '2' })).code, 'DESC_ATTEMPT_INVALID');
});
test('(E3b) INTRA: a prior COMPLETE attempt (producer 1 <= run 3) is accepted via its OWN derived prefix', () => {
    const m = genPrep(prepDir(), { producerAttempt: '1' });
    const res = verifyDescriptor(descFor(m), curIntra({ runAttempt: '3' }));
    assert.equal(res.ok, true);
    assert.equal(res.staging_prefix, 'state/_handoff/prepared-entity-data/P1/attempt-1/');
});
test('(E4) optional head_sha equality: enforced only when the consumer supplies an expected value', () => {
    const m = genShards(shardsDir());
    assert.equal(verifyDescriptor(descFor(m), curInter()).ok, true); // no headSha supplied (3/4 cannot know 2/4 sha)
    assert.equal(verifyDescriptor(descFor(m), curInter({ headSha: 'c'.repeat(40) })).code, 'DESC_HEAD_SHA_MISMATCH');
});
test('(E5 anti-vacuity: prefix derivation) fixed / branch / latest / two-level staging prefix rejected', () => {
    const m = genShards(shardsDir());
    for (const bad of ['state/shards/', 'state/_handoff/shards/P1/attempt-latest/', 'state/_handoff/shards/P1/', 'state/_handoff/shards/P1/H1/attempt-2/']) {
        assert.equal(verifyDescriptor({ ...descFor(m), exact_staging_prefix: bad }, curInter()).code, 'DESC_PREFIX_MISMATCH');
    }
});
test('(E6) missing required field + carrier mismatch + bad set/manifest sha rejected', () => {
    const m = genShards(shardsDir());
    assert.equal(verifyDescriptor({ ...descFor(m), set_sha256: undefined }, curInter()).code, 'DESC_FIELD_MISSING');
    assert.equal(verifyDescriptor(descFor(m), curInter({ carrierType: 'prepared-entity-data-authority' })).code, 'DESC_CARRIER_MISMATCH');
    assert.equal(verifyDescriptor({ ...descFor(m), set_sha256: 'abc-50' }, curInter()).code, 'DESC_SET_SHA_INVALID');
    assert.equal(verifyDescriptor({ ...descFor(m), manifest_sha256: 'abc-50' }, curInter()).code, 'DESC_MANIFEST_SHA_INVALID');
});
test('(E7 anti-vacuity: head-sha well-formedness) a non-git-sha head_sha is rejected', () => {
    const m = genShards(shardsDir());
    assert.equal(verifyDescriptor({ ...descFor(m), head_sha: 'not-a-sha' }, curInter()).code, 'DESC_HEAD_SHA_INVALID');
});
test('(E8 GAP-5) prepared-entity-data descriptor verifies INTRA + rejects a foreign process-run', () => {
    const m = genPrep(prepDir());
    assert.equal(verifyDescriptor(descFor(m), curIntra()).ok, true);
    assert.equal(verifyDescriptor(descFor(m), curIntra({ processRunId: 'P-OTHER' })).code, 'DESC_PROCESS_RUN_MISMATCH');
    // the shards derived prefix root can never masquerade as prepared-entity-data.
    assert.equal(verifyDescriptor({ ...descFor(m), exact_staging_prefix: 'state/_handoff/shards/P1/attempt-2/' }, curIntra()).code, 'DESC_PREFIX_MISMATCH');
});
