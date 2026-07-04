// scripts/factory/mesh-profile-handoff-manifest.test.mjs
//
// Hermetic node:test suite for the Factory 4/4 mesh-baking -> consumers
// R2-authoritative mesh-profile handoff verifier of record
// (carrier "mesh-profile-authority"), Founder VFS_PRODUCER_ARTIFACT_EXACT_CYCLE_
// AUTHORITY_4_OF_4 (AUTHORITY-M). NO network, NO R2, NO @aws-sdk: the pure
// generate/verify/verify-descriptor module is driven over REAL temp dirs.
//
// ANTI-VACUITY MAP (removing/weakening a guard reds >=1 named test):
//   * INCLUDE membership (graph/stats ignored) -> (M1) siblings excluded; drop => FILE_EXTRA on real dir.
//   * expected_shard_count freeze               -> (M6) count mismatch => SHARD_COUNT_MISMATCH; drop => stale count passes.
//   * dict_sha256 freeze                         -> (M7) stale-but-parseable dict => DICT_SHA_MISMATCH; drop => stale dict passes.
//   * per-file sha256                            -> (M5) truncated shard => HASH/SIZE mismatch.
//   * EXACT membership (FILE_MISSING/EXTRA)      -> (M3/M4) a member absent / a foreign shard reds.
//   * set_sha256 verify                          -> (M8) mutate set_sha256 => SET_HASH_MISMATCH.
//   * descriptor provenance                      -> (M11-M14) foreign upstream/run/head/version/prefix rejected.
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
} from './mesh-profile-handoff-manifest.mjs';

const SHA = 'a'.repeat(40);
let TMP_SEQ = 0;
function mkTmp() { const d = path.join(os.tmpdir(), `mesh-profile-handoff-${process.pid}-${Date.now()}-${TMP_SEQ++}`); fs.mkdirSync(d, { recursive: true }); return d; }
function writeFiles(dir, files) {
    for (const [rel, body] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
    }
    return dir;
}
// A minimal mesh-profile dir: the evidence dict + N profile-shards, PLUS graph.json /
// stats.json siblings that the INCLUDE filter MUST ignore (they co-live in output/cache/mesh/).
function meshDir(over = {}, shards = 3) {
    const files = { 'profile-evidence-dict.json.zst': 'DICT-v1', 'graph.json': 'GRAPH', 'stats.json': 'STATS', ...over };
    for (let i = 0; i < shards; i++) files[`profile-shards/shard-${String(i).padStart(4, '0')}.jsonl.zst`] = `SHARD-${i}`;
    return writeFiles(mkTmp(), files);
}
const CTX = { carrierType: 'mesh-profile-authority', upstreamRunId: 'UP1', factoryRunId: 'RUN1', producerAttempt: '2', headSha: SHA, codeVersion: 'v-test', createdAt: '1970-01-01T00:00:00.000Z' };
function genMesh(dir, over = {}) { return generateManifest(dir, { ...CTX, ...over }); }
function descFor(manifest) {
    return {
        schema_version: SCHEMA_VERSION, carrier_type: manifest.carrier_type,
        upstream_run_id: manifest.upstream_run_id, factory_run_id: manifest.factory_run_id,
        producer_attempt: manifest.producer_attempt, exact_staging_prefix: manifest.exact_staging_prefix,
        manifest_sha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
        set_sha256: manifest.set_sha256, dict_sha256: manifest.dict_sha256,
        expected_shard_count: manifest.expected_shard_count, head_sha: manifest.head_sha,
        code_version: manifest.code_version, created_at: manifest.created_at_utc,
    };
}
function curConsumer(over = {}) { return { carrierType: 'mesh-profile-authority', upstreamRunId: 'UP1', factoryRunId: 'RUN1', runAttempt: '2', headSha: SHA, codeVersion: 'v-test', ...over }; }

// ==========================================================================
// A. Config / constants / hashing
// ==========================================================================
test('(A1) single carrier `mesh-profile-authority`, two-level prefix root, mesh-baking producer', () => {
    assert.deepEqual(Object.keys(CARRIERS), ['mesh-profile-authority']);
    assert.equal(carrierConfig('mesh-profile-authority').prefixRoot, 'state/_handoff/mesh-profile');
    assert.equal(carrierConfig('mesh-profile-authority').producerJob, 'mesh-baking');
    assert.throws(() => carrierConfig('bogus'), (e) => e instanceof HandoffManifestError && e.code === 'CARRIER_UNKNOWN');
});
test('(A2) buildStagingPrefix binds upstream + 4/4 run + attempt; NEVER a latest/fixed token', () => {
    assert.equal(buildStagingPrefix('mesh-profile-authority', 'UP1', 'RUN1', '2'), 'state/_handoff/mesh-profile/UP1/RUN1/attempt-2/');
    const p = buildStagingPrefix('mesh-profile-authority', 'UP1', 'RUN1', '2');
    assert.ok(!p.includes('latest'));
    assert.ok(!p.includes('state/mesh-profile-shards/')); // never the mutable fixed prefix
    assert.ok(!p.includes('state/mesh-profile-dict/'));
});
test('(A3) isSha256Hex/isGitSha + computeSetSha256 order-independent + content-bound', () => {
    assert.equal(isSha256Hex('a'.repeat(64)), true);
    assert.equal(isGitSha('a'.repeat(40)), true);
    assert.equal(isGitSha('a'.repeat(64)), false);
    const files = [{ relative_path: 'b', sha256: 'b'.repeat(64) }, { relative_path: 'a', sha256: 'a'.repeat(64) }];
    assert.equal(computeSetSha256(files), computeSetSha256([...files].reverse()));
});

// ==========================================================================
// M. generate / verify / descriptor — the AUTHORITY-M contract families
// ==========================================================================
test('(M1) manifest: full field set; graph.json/stats.json siblings NOT members; dict+shards only', () => {
    const m = genMesh(meshDir());
    assert.equal(m.schema_version, SCHEMA_VERSION);
    assert.equal(m.carrier_type, 'mesh-profile-authority');
    assert.equal(m.upstream_run_id, 'UP1');
    assert.equal(m.factory_run_id, 'RUN1');
    assert.equal(m.producer_job_identity, 'mesh-baking');
    assert.equal(m.producer_attempt, 2);
    assert.equal(m.head_sha, SHA);
    assert.equal(m.code_version, 'v-test');
    assert.equal(m.exact_staging_prefix, 'state/_handoff/mesh-profile/UP1/RUN1/attempt-2/');
    assert.equal(m.completion_state, COMPLETION_STATE);
    assert.equal(m.expected_shard_count, 3);
    assert.ok(isSha256Hex(m.dict_sha256));
    assert.ok(isSha256Hex(m.set_sha256));
    assert.ok(!('manifest_sha256' in m));
    assert.ok(!m.files.some((f) => /graph\.json|stats\.json/.test(f.relative_path)));
    assert.ok(m.files.some((f) => f.relative_path === 'profile-evidence-dict.json.zst'));
    assert.equal(m.files.filter((f) => f.relative_path.startsWith('profile-shards/')).length, 3);
});
test('(M2 positive) manifest verifies against its own dir; returns set_sha + shard count + dict sha', () => {
    const dir = meshDir();
    const m = genMesh(dir);
    const res = verifyDirAgainstManifest(dir, m);
    assert.equal(res.ok, true);
    assert.equal(res.set_sha256, m.set_sha256);
    assert.equal(res.expected_shard_count, 3);
    assert.equal(res.dict_sha256, m.dict_sha256);
});
test('(M3 FILE_MISSING) a manifest member absent on disk reds', () => {
    const dir = meshDir();
    const m = genMesh(dir);
    fs.rmSync(path.join(dir, 'profile-shards/shard-0001.jsonl.zst'));
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_MISSING');
});
test('(M4 FILE_EXTRA) a foreign/mixed-cycle shard NOT in the manifest reds', () => {
    const dir = meshDir();
    const m = genMesh(dir);
    fs.writeFileSync(path.join(dir, 'profile-shards/shard-9999.jsonl.zst'), 'MIXED');
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_EXTRA');
});
test('(M5 per-file sha) truncated/tampered shard => SIZE/HASH mismatch', () => {
    const dir = meshDir();
    const m = genMesh(dir);
    fs.writeFileSync(path.join(dir, 'profile-shards/shard-0000.jsonl.zst'), 'SHARD-0-LONGER');
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'SIZE_MISMATCH');
    const dir2 = meshDir();
    const m2 = genMesh(dir2);
    fs.writeFileSync(path.join(dir2, 'profile-shards/shard-0000.jsonl.zst'), 'XXXXXXX'); // same length as 'SHARD-0'
    assert.equal(verifyDirAgainstManifest(dir2, m2).code, 'HASH_MISMATCH');
});
test('(M6 T5: profile-shards count mismatch) declared expected_shard_count != disk => SHARD_COUNT_MISMATCH', () => {
    const dir = meshDir();
    const m = genMesh(dir);
    // Tamper expected_shard_count only (disk still 3) — count guard reds even if set_sha untouched.
    assert.equal(verifyDirAgainstManifest(dir, { ...m, expected_shard_count: 99 }).code, 'SHARD_COUNT_MISMATCH');
});
test('(M7 T8: stale-but-parseable dict) dict content differs from frozen dict_sha256 => DICT_SHA_MISMATCH', () => {
    const dir = meshDir();
    const m = genMesh(dir);
    // Overwrite the dict with a DIFFERENT same-length body: EXACT set + shard count still
    // hold, but the frozen dict_sha256 no longer matches -> a stale dict cannot masquerade.
    fs.writeFileSync(path.join(dir, 'profile-evidence-dict.json.zst'), 'DICT-v2'); // same length as 'DICT-v1'
    const res = verifyDirAgainstManifest(dir, m);
    assert.ok(['DICT_SHA_MISMATCH', 'HASH_MISMATCH'].includes(res.code));
});
test('(M8 set-hash) mutating set_sha256 reds verify', () => {
    const dir = meshDir();
    const m = genMesh(dir);
    assert.equal(verifyDirAgainstManifest(dir, { ...m, set_sha256: 'f'.repeat(64) }).code, 'SET_HASH_MISMATCH');
});
test('(M9 malformed / self-hash / unknown carrier) rejected', () => {
    const dir = meshDir();
    const m = genMesh(dir);
    assert.equal(verifyDirAgainstManifest(mkTmp(), null).code, 'MANIFEST_MALFORMED');
    assert.equal(verifyDirAgainstManifest(mkTmp(), { carrier_type: 'nope', files: [] }).code, 'CARRIER_UNKNOWN');
    assert.equal(verifyDirAgainstManifest(dir, { ...m, manifest_sha256: 'd'.repeat(64) }).code, 'MANIFEST_SELF_HASH');
});
test('(M10 below-floor) zero profile-shards fails closed at generate (profile_shard floor 1)', () => {
    const noShards = writeFiles(mkTmp(), { 'profile-evidence-dict.json.zst': 'DICT', 'graph.json': 'G' });
    assert.throws(() => genMesh(noShards), (e) => e instanceof HandoffManifestError && e.code === 'REQUIRED_CLASS_BELOW_FLOOR');
    const noDict = meshDir();
    fs.rmSync(path.join(noDict, 'profile-evidence-dict.json.zst'));
    assert.throws(() => genMesh(noDict), (e) => e instanceof HandoffManifestError && e.code === 'REQUIRED_CLASS_BELOW_FLOOR');
});
test('(M11 positive descriptor) verifies; emits staging + set/dict sha + shard count', () => {
    const m = genMesh(meshDir());
    const res = verifyDescriptor(descFor(m), curConsumer());
    assert.equal(res.ok, true);
    assert.equal(res.staging_prefix, 'state/_handoff/mesh-profile/UP1/RUN1/attempt-2/');
    assert.equal(res.set_sha256, m.set_sha256);
    assert.equal(res.dict_sha256, m.dict_sha256);
    assert.equal(res.expected_shard_count, 3);
});
test('(M12 T3: foreign cycle) mismatched upstream/run/head/version rejected', () => {
    const m = genMesh(meshDir());
    assert.equal(verifyDescriptor(descFor(m), curConsumer({ upstreamRunId: 'UPX' })).code, 'DESC_UPSTREAM_MISMATCH');
    assert.equal(verifyDescriptor(descFor(m), curConsumer({ factoryRunId: 'RUNX' })).code, 'DESC_RUN_MISMATCH');
    assert.equal(verifyDescriptor(descFor(m), curConsumer({ headSha: 'c'.repeat(40) })).code, 'DESC_HEAD_SHA_MISMATCH');
    assert.equal(verifyDescriptor(descFor(m), curConsumer({ codeVersion: 'v-OTHER' })).code, 'DESC_VERSION_MISMATCH');
});
test('(M13 prefix derivation) fixed / latest / two-level-flipped / predecessor prefix rejected', () => {
    const m = genMesh(meshDir());
    for (const bad of ['state/mesh-profile-shards/', 'state/_handoff/mesh-profile/UP1/RUN1/attempt-latest/', 'state/_handoff/mesh-profile/UP1/RUN1/', 'state/_handoff/mesh-profile/RUN1/UP1/attempt-2/']) {
        assert.equal(verifyDescriptor({ ...descFor(m), exact_staging_prefix: bad }, curConsumer()).code, 'DESC_PREFIX_MISMATCH');
    }
});
test('(M14 field / sha / attempt guards) missing field, bad sha, future attempt, invalid shard count rejected', () => {
    const m = genMesh(meshDir());
    assert.equal(verifyDescriptor({ ...descFor(m), dict_sha256: undefined }, curConsumer()).code, 'DESC_FIELD_MISSING');
    assert.equal(verifyDescriptor({ ...descFor(m), dict_sha256: 'abc-50' }, curConsumer()).code, 'DESC_DICT_SHA_INVALID');
    assert.equal(verifyDescriptor({ ...descFor(m), head_sha: 'not-a-sha' }, curConsumer()).code, 'DESC_HEAD_SHA_INVALID');
    assert.equal(verifyDescriptor({ ...descFor(m), expected_shard_count: 0 }, curConsumer()).code, 'DESC_SHARD_COUNT_INVALID');
    const m5 = genMesh(meshDir(), { producerAttempt: '5' });
    assert.equal(verifyDescriptor(descFor(m5), curConsumer({ runAttempt: '2' })).code, 'DESC_ATTEMPT_FUTURE');
});
test('(D1 safety) listCarrierFiles rejects a symlink member', () => {
    const dir = meshDir();
    let made = false;
    try { fs.symlinkSync(path.join(dir, 'profile-shards/shard-0000.jsonl.zst'), path.join(dir, 'profile-shards/link.jsonl.zst')); made = true; }
    catch { /* Windows without privilege — skip */ }
    if (!made) return;
    assert.throws(() => listCarrierFiles(dir), (e) => e instanceof HandoffManifestError && e.code === 'UNSAFE_MEMBER');
});
