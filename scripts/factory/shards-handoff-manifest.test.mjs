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
import { isUploadEligible, ZSTD_MIN_BYTES, DEFAULT_MIN_BYTES } from './lib/upload-eligibility.js';

// Read a repo SOURCE file relative to THIS test (hermetic; no network, no heavy import).
function readSrc(relToTest) { return fs.readFileSync(new URL(relToTest, import.meta.url), 'utf8'); }
// Guard-ELIGIBLE .zst fixture: valid zstd magic (28 B5 2F FD) + padding to `nBytes`
// (the guard predicate is magic + length only). Distinct `seed` => distinct bytes => sha256.
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
function zst(nBytes = 20, seed = 'x') {
    const pad = Buffer.alloc(Math.max(0, nBytes - 4));
    for (let i = 0; i < pad.length; i += 1) pad[i] = (seed.charCodeAt(i % seed.length) + i) & 0xff;
    return Buffer.concat([ZSTD_MAGIC, pad]);
}
// Guard-INELIGIBLE .zst fixture: valid magic but < 16B (the stale 11B empty-frame class).
function zstStub(nBytes = 11) { return zst(nBytes, 's'); }
// Guard-eligible non-.zst JSON payload (>= 256B non-.zst floor).
function bigJson(obj = { total_entities: 90000 }) { return JSON.stringify({ ...obj, _pad: 'x'.repeat(300) }); }

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
// prepared-entity-data workspace: data/ = the AUTHORITATIVE upload-eligible set (manifest
// >=256B + valid-zstd merged shards); cache/ = optional accelerators (excluded by class).
// The default cache/ entity-checksums is the stale 11B (guard-ineligible) empty-frame that
// tripped GAP-5 -- it MUST be excluded from the authority, not enumerated as a member.
function prepDir(over = {}) {
    return writeFiles(mkTmp(), {
        'data/manifest.json': bigJson(),
        'data/merged_shard_000.json.zst': zst(20, 'a'),
        'data/merged_shard_001.json.zst': zst(20, 'b'),
        'cache/entity-checksums.json.zst': zstStub(11), // stale 11B accelerator (EXCLUDED)
        'cache/daily-accum.json.zst': zst(18, 'd'),      // accelerator (EXCLUDED)
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
test('(B4) prepared-entity-data manifest: data/ authoritative set + class floors + EXACT-set; cache/ accelerators EXCLUDED (A3 flip)', () => {
    const m = genPrep(prepDir());
    assert.equal(m.carrier_type, 'prepared-entity-data-authority');
    assert.equal(m.producer_job_identity, 'prepare-data');
    assert.equal(m.member_count, m.file_count); // no exactMembers => member_count == file_count
    const byName = Object.fromEntries(m.required_file_classes.map((c) => [c.name, c]));
    assert.equal(byName.data_manifest.count, 1);
    assert.equal(byName.merged_shard.count, 2);
    assert.ok(m.files.some((f) => f.relative_path === 'data/manifest.json'));
    // A3 FLIP (proposal S7): entity-checksums is a PROVEN optional accelerator, NOT a member.
    // (was: assert entity-checksums IS a member @ old L148 -- the exact assertion that flips.)
    assert.ok(!m.files.some((f) => f.relative_path === 'cache/entity-checksums.json.zst'));
    assert.ok(!m.files.some((f) => f.relative_path.startsWith('cache/'))); // NO cache/ file in the authority
    assert.equal(m.file_count, 3); // data/manifest.json + 2 merged shards ONLY
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
test('(C12 GAP-5 anti-vacuity: FILE_EXTRA) an extra AUTHORITATIVE data/ member after generate reds verify', () => {
    const dir = prepDir();
    const m = genPrep(dir);
    // A NEW eligible authoritative member on disk but not in the manifest => exact-set
    // FILE_EXTRA (a mixed/partial authoritative set never proceeds). An extra CACHE file is
    // caught even earlier as UNCLASSIFIED_MEMBER -- see (F-T5).
    fs.writeFileSync(path.join(dir, 'data/merged_shard_002.json.zst'), zst(20, 'z'));
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_EXTRA');
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

// ==========================================================================
// F. GAP-5b (A3) — prepared-entity-data manifest/guard MEMBERSHIP CONSISTENCY
//    (Founder D-2026-0704-262 A3 HYBRID EXPLICIT MEMBERSHIP REGISTRY). The 10
//    mandatory tests: single-source upload predicate + explicit cache classification
//    (proven optional-accelerator EXCLUDE vs UNCLASSIFIED_MEMBER fail-loud) +
//    generate-time INCLUDED-member eligibility (MEMBER_UPLOAD_INELIGIBLE) while the
//    zstd guard / 16B floor / read-back / no-fallback invariants are PRESERVED.
//   ANTI-VACUITY: restoring the unfiltered cache walk reds F-T1/F-T5/F-T6; dropping the
//    eligibility assertion reds F-T2/F-T6; forking either predicate reds F-T4; relaxing
//    the guard reds F-T4; a prefix/latest/fixed/etag fallback reds F-T8/F-T9/F-T10.
// ==========================================================================

// The ORIGINAL inline r2-handoff predicate, replicated as an ORACLE (proves the extracted
// isUploadEligible is behavior-identical -- not merely self-consistent).
function r2Oracle(name, data, opts = {}) {
    const minBytes = opts.minSize ?? 256;
    const isZst = name.endsWith('.zst');
    const hasZstdMagic = isZst && data.length >= 4 && data.readUInt32LE(0) === 0xFD2FB528;
    const passes = isZst ? (hasZstdMagic && data.length >= 16) : (data.length >= minBytes);
    const reason = passes ? null : (isZst ? `invalid zstd (${data.length}B)` : `${data.length}B < min ${minBytes}B`);
    return { passes, reason };
}

test('(F-T1) stale 11B cache/entity-checksums.json.zst EXCLUDED; NOT a member; set_sha256 unaffected', () => {
    const withStale = prepDir({ 'cache/entity-checksums.json.zst': zstStub(11) });
    const mWith = genPrep(withStale);
    assert.ok(!mWith.files.some((f) => f.relative_path === 'cache/entity-checksums.json.zst'));
    assert.equal(verifyDirAgainstManifest(withStale, mWith).ok, true); // stale 11B never blocks read-back
    // set_sha256 IDENTICAL with vs without the stale 11B present (accelerator is out of scope).
    const withoutStale = prepDir();
    fs.rmSync(path.join(withoutStale, 'cache/entity-checksums.json.zst'));
    assert.equal(genPrep(withoutStale).set_sha256, mWith.set_sha256);
});

test('(F-T2) a REQUIRED sub-floor data/merged_shard_*.json.zst fails LOUD MEMBER_UPLOAD_INELIGIBLE at generate', () => {
    const dir = prepDir({ 'data/merged_shard_002.json.zst': zstStub(11) }); // 11B guard-ineligible REQUIRED member
    assert.throws(() => genPrep(dir), (e) => e instanceof HandoffManifestError && e.code === 'MEMBER_UPLOAD_INELIGIBLE');
});

test('(F-T3) a MISSING required member still fails read-back FILE_MISSING (fail-closed unchanged)', () => {
    const dir = prepDir();
    const m = genPrep(dir);
    fs.rmSync(path.join(dir, 'data/merged_shard_000.json.zst'));
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_MISSING');
});

test('(F-T4) SINGLE-SOURCE predicate: isUploadEligible == r2-handoff oracle over the battery; both consumers import it', () => {
    const battery = [
        ['x.zst', zst(11, 'q')],            // 11B zstd (magic, < 16) => ineligible
        ['x.zst', zst(15, 'q')],            // 15B zstd => ineligible
        ['x.zst', zst(16, 'q')],            // 16B zstd => ELIGIBLE
        ['x.json', Buffer.alloc(255, 65)],  // 255B json => ineligible
        ['x.json', Buffer.alloc(256, 65)],  // 256B json => ELIGIBLE
        ['y.zst', Buffer.alloc(20, 65)],    // 20B .zst NO magic => ineligible
    ];
    for (const [name, buf] of battery) {
        const got = isUploadEligible(name, buf);
        const exp = r2Oracle(name, buf);
        assert.equal(got.eligible, exp.passes, `verdict ${name} len=${buf.length}`);
        assert.equal(got.reason, exp.reason, `reason ${name} len=${buf.length}`);
    }
    // the floors are the EXACT guard constants (no relaxation).
    assert.equal(ZSTD_MIN_BYTES, 16);
    assert.equal(DEFAULT_MIN_BYTES, 256);
    // r2-handoff.js imports the SAME predicate and holds NO duplicated inline predicate.
    const r2 = readSrc('./lib/r2-handoff.js');
    assert.match(r2, /import\s*\{\s*isUploadEligible\s*\}\s*from\s*'\.\/upload-eligibility\.js'/);
    assert.match(r2, /isUploadEligible\(localPath,\s*data/);
    assert.ok(!r2.includes('0xFD2FB528'), 'magic literal must live ONLY in upload-eligibility.js');
    assert.ok(!/data\.length\s*>=\s*16/.test(r2), 'old inline 16B floor must be removed from r2-handoff');
    // the manifest module imports the SAME predicate too (single source of truth).
    const mf = readSrc('./shards-handoff-manifest.mjs');
    assert.match(mf, /import\s*\{\s*isUploadEligible\s*\}\s*from\s*'\.\/lib\/upload-eligibility\.js'/);
});

test('(F-T5) an UNKNOWN cache/ file fails LOUD UNCLASSIFIED_MEMBER (never silently included, generate AND verify)', () => {
    assert.throws(() => genPrep(prepDir({ 'cache/mystery.bin': 'WHO-DIS' })),
        (e) => e instanceof HandoffManifestError && e.code === 'UNCLASSIFIED_MEMBER');
    // consistent-by-construction: the SAME classification governs verify.
    const clean = prepDir();
    const m = genPrep(clean);
    fs.writeFileSync(path.join(clean, 'cache/mystery.bin'), 'WHO-DIS');
    assert.equal(verifyDirAgainstManifest(clean, m).code, 'UNCLASSIFIED_MEMBER');
});

test('(F-T6) exclusion is CLASS-scoped (proven accelerator), NOT generic skip-any-bad-file', () => {
    // (a) a stale 11B accelerator IN the optional class => excluded; generate proceeds.
    const okDir = prepDir({ 'cache/entity-checksums.json.zst': zstStub(11) });
    fs.rmSync(path.join(okDir, 'cache/daily-accum.json.zst')); // accelerator absent => also safe
    assert.equal(genPrep(okDir).files.every((f) => !f.relative_path.startsWith('cache/')), true);
    // (b) the SAME 11B corruption in a NON-optional (authoritative data/) member is NOT
    //     excluded -- it fails LOUD (proves class-scope, not a blanket bad-file skip).
    assert.throws(() => genPrep(prepDir({ 'data/merged_shard_002.json.zst': zstStub(11) })),
        (e) => e.code === 'MEMBER_UPLOAD_INELIGIBLE');
    // (c) an UNKNOWN cache file is likewise NOT skipped -- it fails LOUD.
    assert.throws(() => genPrep(prepDir({ 'cache/random.dat': 'X' })), (e) => e.code === 'UNCLASSIFIED_MEMBER');
});

test('(F-T7) entity-checksums is INDEPENDENTLY hydrated + SAFE-ABSENT (SOURCE lock: workflow + consumer)', () => {
    // (a) matrix-shards hydrates entity-checksums via its OWN dedicated cache + R2 fallback,
    //     SEPARATE from the prepared-entity-data authority => excluding it loses no input.
    const wf = readSrc('../../.github/workflows/factory-process.yml');
    assert.match(wf, /Restore Entity Checksums/);
    assert.match(wf, /entity-checksums-\$\{\{\s*github\.run_id\s*\}\}/);
    assert.match(wf, /R2 Fallback for Entity Checksums/);
    assert.match(wf, /meta\/backup\/entity-checksums\.json\.zst/);
    // (b) loadEntityChecksums DEFAULTS to {} (safe absence) + save SKIPS empty (no 11B regen).
    const cm = readSrc('./lib/cache-manager.js');
    assert.match(cm, /loadWithFallback\('entity-checksums\.json\.zst',\s*\{\}\)/);
    assert.match(cm, /skipping save/);
    // (c) the ONLY consumer use is change-detection feeding _updated -- NOT identity/FNI/
    //     ranking/shard-composition. entityChecksums appears ONLY as the param + the single read.
    const pc = readSrc('./lib/processor-core.js');
    assert.match(pc, /const isChanged = entityChecksums\[id\] !== entityHash;/);
    assert.match(pc, /_updated: isChanged \?/);
    assert.equal((pc.match(/entityChecksums/g) || []).length, 2); // processEntity param + one isChanged read
});

test('(F-T8) NO restore-keys / latest / predecessor fallback introduced in the authority derivation', () => {
    // staging prefix is attempt-scoped ONLY (<root>/<processRunId>/attempt-<attempt>/).
    assert.equal(buildStagingPrefix('prepared-entity-data-authority', 'P1', '2'), 'state/_handoff/prepared-entity-data/P1/attempt-2/');
    const m = genPrep(prepDir(), { producerAttempt: '2' });
    // BEHAVIORAL: any latest / mutable / predecessor-guess / two-level prefix is REJECTED --
    // ONLY the exact process-run+attempt derivation is accepted (no restore-keys/list-latest path).
    for (const bad of [
        'state/_handoff/prepared-entity-data/P1/attempt-latest/',
        'state/_handoff/prepared-entity-data/P1/',
        'state/_handoff/prepared-entity-data/latest/attempt-2/',
        'state/_handoff/prepared-entity-data/P1/H1/attempt-2/',
    ]) {
        assert.equal(verifyDescriptor({ ...descFor(m), exact_staging_prefix: bad }, curIntra()).code, 'DESC_PREFIX_MISMATCH');
    }
    // the prefix is DERIVED (buildStagingPrefix), never obtained by listing R2 to guess latest.
    assert.ok(!readSrc('./shards-handoff-manifest.mjs').includes('ListObjectsV2'));
});

test('(F-T9) NO fixed R2 state/prepared-entity-data substitution (attempt-scoped staging ONLY)', () => {
    const p = buildStagingPrefix('prepared-entity-data-authority', 'P1', '2');
    assert.ok(p.startsWith('state/_handoff/prepared-entity-data/'));
    assert.ok(!/^state\/prepared-entity-data\//.test(p)); // never the DEMOTED fixed compat prefix
    // a descriptor pointed at the fixed compat prefix is REJECTED (must derive attempt-scoped).
    const m = genPrep(prepDir());
    assert.equal(verifyDescriptor({ ...descFor(m), exact_staging_prefix: 'state/prepared-entity-data/cache/' }, curIntra()).code, 'DESC_PREFIX_MISMATCH');
});

test('(F-T10) membership is manifest + EXACT-SET read-back, NOT etag-skip laundering', () => {
    // (a) a member on-R2-but-absent-from-disk still reds FILE_MISSING (no etag-skip acceptance).
    const dir = prepDir();
    const m = genPrep(dir);
    fs.rmSync(path.join(dir, 'data/merged_shard_001.json.zst'));
    assert.equal(verifyDirAgainstManifest(dir, m).code, 'FILE_MISSING');
    // (b) the accelerator is excluded by explicit CLASS (name), NOT by etag/content match:
    //     changing entity-checksums' bytes does not change membership (same set_sha256).
    const d1 = prepDir({ 'cache/entity-checksums.json.zst': zstStub(11) });
    const d2 = prepDir({ 'cache/entity-checksums.json.zst': zst(40, 'other-bytes') });
    assert.equal(genPrep(d1).set_sha256, genPrep(d2).set_sha256);
    // (c) SOURCE: no etag/If-None-Match/md5 skip token in the authority membership module.
    const mf = readSrc('./shards-handoff-manifest.mjs');
    for (const bad of ['etag', 'ETag', 'If-None-Match', 'md5']) assert.ok(!mf.includes(bad));
});
