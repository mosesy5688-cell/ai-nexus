// Behavioural proofs for the D-403 STEP 2 target-isolated completion carrier.
// ZERO real network, ZERO real secrets, ZERO R2: every I/O is a recording fake
// and any key-shaped material is a synthetic sentinel. Static workflow guards
// (unreachability, input contract, secret boundary) live in
// d403-target-guard.test.mjs.
//
// Run: node --test scripts/audit/d403-target.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runTarget, selectTarget, writePackage, mainWithDeps, TARGETS, BUDGET_MINUTES } from './d403-target-complete.mjs';
import { initCrypto } from './d403-registry-decode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR = path.join(HERE, 'd403-target-complete.mjs');
// Synthetic, distinctive, valid 64-char hex. NEVER a real key.
const SENTINEL = 'deadbeef'.repeat(8);

/** Recording fake io. Records EVERY key/prefix touched so isolation is provable. */
function fakeIo(target, over = {}) {
  const keys = [];
  const calls = { initCrypto: 0, listPrefix: 0, getObject: 0, getObjectToFile: 0, decode: 0, extract: 0 };
  const t = TARGETS[target];
  const shards = Array.from({ length: t.expected_shards }, (_, i) => ({ name: `part-${String(i).padStart(3, '0')}.bin`, rows_match: true }));
  const io = {
    now: () => 1_000_000,
    initCrypto: () => { calls.initCrypto += 1; return { key_present: true, key_format_production_compatible: true, encryption_active: true }; },
    // Same segmentation the collector uses: <cycleId>/<runId>/<attempt>/<sha>/
    listPrefix: async (prefix) => {
      calls.listPrefix += 1; keys.push(prefix);
      return { prefix, member_count: 2, inventory: [{ key: `${prefix}manifest.json` }, { key: `${prefix}registry.tar.zst` }], inventory_set_hash: 'x', retrieved_utc: 'z' };
    },
    getObject: async (key) => {
      calls.getObject += 1; keys.push(key);
      const seg = t.prefix.slice('internal-handoff/aggregate-satellite/'.length).split('/');
      const body = Buffer.from(JSON.stringify({ github_run_id: seg[1], github_run_attempt: seg[2], producer_main_sha: seg[3], completion_state: 'complete', inventory: shards.map((s) => s.name) }));
      return { key, present: true, size: t.manifest_bytes, sha256: t.manifest_sha256, body };
    },
    getObjectToFile: async (key) => { calls.getObjectToFile += 1; keys.push(key); return { key, present: true, size: t.archive_bytes, sha256: t.archive_sha256 }; },
    workDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'd403w-')),
    listArchive: () => [{ type: '-', size: 1, name: 'cache/registry/part-000.bin', link: false }],
    extract: () => { calls.extract += 1; return true; },
    decode: () => ({ calls: calls.decode += 1, evidence: { status: 'COMPLETE', shards, total_decoded_rows: t.expected_rows, total_header_rows: t.expected_rows, unique_identity_cardinality: t.expected_rows, repeated_distinct_identity_count: 0, excess_duplicate_row_count: 0, missing_identity_rows: 0 }, ids: new Set(['a', 'b']) }),
    writeMember: () => {},
    ...over,
  };
  return { io, keys, calls };
}

test('target selection accepts ONLY exact uppercase P or F', () => {
  assert.equal(selectTarget('P').label, 'P');
  assert.equal(selectTarget('F').label, 'F');
  for (const bad of ['p', 'f', ' P', 'P ', '', 'PF', 'X', 'p ', '\tF', undefined, null, 0, 1, true, ['P'], { target: 'P' }]) {
    assert.throws(() => selectTarget(bad), /TARGET_INVALID/, `must reject ${JSON.stringify(bad)}`);
  }
});

test('invalid or missing target fails BEFORE any network and BEFORE crypto init', async () => {
  for (const bad of [undefined, '', 'p', ' F', 'BOTH']) {
    const { io, keys, calls } = fakeIo('P');
    const { report, code } = await runTarget(bad, io);
    assert.deepEqual([code, report.target_status, report.usable_as_complete_set], [1, 'FAILED_CLOSED', false]);
    assert.deepEqual(report.failure_reasons, ['TARGET_INVALID_REJECTED_BEFORE_NETWORK_AND_CRYPTO']);
    assert.deepEqual(keys, [], 'zero R2 keys touched');
    assert.equal(calls.initCrypto, 0, 'crypto must not initialise');
    assert.equal(calls.listPrefix + calls.getObject + calls.getObjectToFile, 0);
  }
});

test('a P run touches ONLY P keys and an F run ONLY F keys', async () => {
  for (const [sel, other] of [['P', 'F'], ['F', 'P']]) {
    const { io, keys } = fakeIo(sel);
    const { report, code } = await runTarget(sel, io);
    assert.deepEqual([code, report.target_status], [0, 'COMPLETE']);
    assert.ok(keys.length >= 3);
    for (const k of keys) {
      assert.ok(k.startsWith(TARGETS[sel].prefix), `key outside selected target: ${k}`);
      assert.equal(k.includes(TARGETS[other].prefix), false, `key from the other target leaked: ${k}`);
    }
  }
});

test('the selected target gets a FRESH 44-minute budget from process start', async () => {
  assert.equal(BUDGET_MINUTES, 44);
  const { report } = await runTarget('F', fakeIo('F').io);
  assert.deepEqual([report.budget_minutes, report.shared_pf_deadline, report.deadline_origin], [44, false, 'SELECTED_TARGET_PROCESS_START']);
  assert.equal(Date.parse(report.deadline_utc), 1_000_000 + 44 * 60 * 1000);
});

test('exact immutable constants are pinned for both targets', () => {
  const pinned = {
    P: ['internal-handoff/aggregate-satellite/30801055822/30802427780/1/f915b8ccacd6d3c596d78ff85ce6edb5d1fcd550/',
      52263, '3ce8dfbdd47684f45da9d7a31bfcd67564d67f694b69510d6b66e89f11edb20b',
      1173145727, '8b9538757dfe6eb80c2d3f9aad1935659d093a7d315e658b02d45c13e5d72593', 643, 642695],
    F: ['internal-handoff/aggregate-satellite/30893731560/30895172870/1/f915b8ccacd6d3c596d78ff85ce6edb5d1fcd550/',
      52499, 'e8feb129a890a3f6a05eedd02adae8a9d659b3923842969ed1a6972e7d43b4eb',
      1177150243, '8e8243221f4c14e486dc5024106205135c673130fb996bdd99481eca4534f1b8', 646, 645006],
  };
  for (const [k, want] of Object.entries(pinned)) {
    const t = TARGETS[k];
    assert.deepEqual([t.prefix, t.manifest_bytes, t.manifest_sha256, t.archive_bytes, t.archive_sha256, t.expected_shards, t.expected_rows], want, `${k} constants drifted`);
  }
});

test('prefix object count and archive member count are never conflated', async () => {
  const { report } = await runTarget('F', fakeIo('F').io);
  assert.deepEqual([report.prefix_object_count.observed, report.prefix_object_count.expected], [2, 2]);
  assert.deepEqual([report.archive_registry_member_count.observed, report.archive_registry_member_count.expected], [646, 646]);
  assert.equal(report.manifest_inventory_member_count, 646);
  assert.match(report.layer_comparison_policy, /NEVER compared/);
  // The defective POST field name must not reappear anywhere.
  assert.equal(/member_count_matches_manifest/.test(fs.readFileSync(COLLECTOR, 'utf8')), false);
});

test('a prefix holding anything other than the two exact objects fails closed', async () => {
  const over = { listPrefix: async (prefix) => ({ prefix, member_count: 3, inventory: [{ key: `${prefix}manifest.json` }, { key: `${prefix}registry.tar.zst` }, { key: `${prefix}stray.bin` }] }) };
  const { io } = fakeIo('P', over);
  const { report, code } = await runTarget('P', io);
  assert.equal(code, 1);
  assert.equal(report.target_status, 'FAILED_CLOSED');
  assert.ok(report.failure_reasons.some((r) => r.startsWith('PREFIX_OBJECT_SET_INCOHERENT')));
});

test('retrieval success + partial decode is NOT OK and exits non-zero', async () => {
  const t = TARGETS.P;
  const partial = Array.from({ length: 12 }, (_, i) => ({ name: `part-${i}.bin`, rows_match: true }));
  const over = { decode: () => ({ evidence: { status: 'PARTIAL_TIME_BUDGET', shards: partial, total_decoded_rows: 12000, total_header_rows: 12000, unique_identity_cardinality: 12000, repeated_distinct_identity_count: 0, excess_duplicate_row_count: 0, missing_identity_rows: 0 }, ids: new Set(['a']) }) };
  const { report, code } = await runTarget('P', fakeIo('P', over).io);
  assert.equal(code, 1, 'partial decode must exit non-zero');
  assert.deepEqual([report.target_status, report.usable_as_complete_set, report.derived_conclusions_suppressed], ['FAILED_CLOSED', false, true]);
  assert.ok(report.archive_object.present, 'retrieval itself succeeded');
  assert.ok(report.failure_reasons.some((r) => r.includes('PARTIAL_TIME_BUDGET')));
  assert.equal(report.canonical_id_set.is_complete_set, false);
  assert.match(report.canonical_id_set.member, /NOT-COMPLETE/);
  assert.equal(t.expected_rows, 642695);
});

test('each completeness gate fails closed on its own', async () => {
  const t = TARGETS.F;
  const manifest = (body) => ({ getObject: async (key) => ({ key, present: true, size: t.manifest_bytes, sha256: t.manifest_sha256, body: Buffer.from(body) }) });
  const cases = [
    ['MANIFEST_ABSENT', { getObject: async (key) => ({ key, present: false }) }],
    ['MANIFEST_UNPARSEABLE', manifest('this is not json')],
    ['MANIFEST_IDENTITY_MISMATCH', manifest(JSON.stringify({ github_run_id: '999', github_run_attempt: '9', producer_main_sha: 'deadbeef', inventory: [] }))],
    ['MANIFEST_INTEGRITY_MISMATCH', { getObject: async (key) => ({ key, present: true, size: 1, sha256: 'bad', body: Buffer.from('{}') }) }],
    ['ARCHIVE_INTEGRITY_MISMATCH', { getObjectToFile: async (key) => ({ key, present: true, size: 1, sha256: 'bad' }) }],
    ['UNSAFE_OR_UNREADABLE_ARCHIVE', { listArchive: () => [{ type: '-', size: 1, name: '../escape.bin', link: false }] }],
    ['EXTRACT_FAILED', { extract: () => false }],
    ['ARCHIVE_ABSENT', { getObjectToFile: async (key) => ({ key, present: false }) }],
  ];
  for (const [reason, over] of cases) {
    const { io } = fakeIo('F', over);
    const { report, code } = await runTarget('F', io);
    assert.equal(code, 1, `${reason} must exit non-zero`);
    assert.ok(report.failure_reasons.includes(reason), `expected ${reason}, got ${report.failure_reasons}`);
    assert.equal(report.usable_as_complete_set, false);
  }
});

test('row-level incoherence fails closed and never emits a complete set', async () => {
  const t = TARGETS.F;
  const base = {
    status: 'COMPLETE', total_decoded_rows: t.expected_rows, total_header_rows: t.expected_rows,
    unique_identity_cardinality: 1, repeated_distinct_identity_count: 0, excess_duplicate_row_count: 0, missing_identity_rows: 0,
    shards: Array.from({ length: t.expected_shards }, (_, i) => ({ name: `p${i}`, rows_match: true })),
  };
  const mk = (ev) => ({ decode: () => ({ evidence: { ...base, ...ev }, ids: new Set(['a']) }) });
  const cases = [
    ['TOTAL_DECODED_ROWS_MISMATCH', mk({ total_decoded_rows: t.expected_rows - 1 })],
    ['ROWS_WITHOUT_IDENTITY_FIELD', mk({ missing_identity_rows: 3 })],
    ['ARCHIVE_REGISTRY_MEMBER_COUNT_MISMATCH', mk({ shards: [{ name: 'p0', rows_match: true }] })],
    ['PER_SHARD_ROW_MISMATCH', mk({ shards: Array.from({ length: t.expected_shards }, (_, i) => ({ name: `p${i}`, rows_match: i !== 5 })) })],
  ];
  for (const [reason, over] of cases) {
    const { io } = fakeIo('F', over);
    const { report, code } = await runTarget('F', io);
    assert.equal(code, 1);
    assert.ok(report.failure_reasons.includes(reason), `expected ${reason}, got ${report.failure_reasons}`);
    assert.equal(report.canonical_id_set.is_complete_set, false);
  }
});





test('DEPLOYED entry path builds the R2 client only AFTER target validation', async () => {
  // This exercises mainWithDeps, the real entry ordering. It goes RED if client
  // construction is moved back ahead of validation, because buildIo would then
  // run for an invalid target. Testing runTarget alone could not catch that.
  let built = 0;
  const buildIo = () => { built += 1; return fakeIo('P').io; };
  for (const bad of [undefined, '', 'p', ' P', 'X']) {
    built = 0;
    const { report, code } = await mainWithDeps(bad, buildIo);
    assert.equal(built, 0, 'the R2 client must NOT be constructed for an invalid target');
    assert.equal(code, 1);
    assert.deepEqual(report.failure_reasons, ['TARGET_INVALID_REJECTED_BEFORE_NETWORK_AND_CRYPTO']);
  }
  built = 0;
  const ok = await mainWithDeps('P', buildIo);
  assert.equal(built, 1, 'a valid target builds the client exactly once');
  assert.equal(ok.code, 0);
});

test('the leak detector really fires, and the real crypto probe discloses nothing', async () => {
  // (a) NON-VACUITY: the detector must catch a sentinel that DOES reach the
  //     package, otherwise the absence assertion below would be worthless.
  const leakDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd403leak-'));
  const leaky = fakeIo('P', { initCrypto: () => ({ key_present: true, key_format_production_compatible: true, encryption_active: true, key_material: SENTINEL }) });
  const leakedRun = await runTarget('P', leaky.io);
  writePackage(leakDir, leakedRun.report);
  assert.equal(fs.readFileSync(path.join(leakDir, 'report.json'), 'utf8').includes(SENTINEL), true, 'detector MUST fire when a leak exists');
  fs.rmSync(leakDir, { recursive: true, force: true });

  // (b) THE REAL PROPERTY, using the PRODUCTION initCrypto with a synthetic key
  //     in the environment: it returns only booleans, and nothing key-shaped
  //     survives into the report or the package.
  const prev = process.env.AES_CRYPTO_KEY;
  process.env.AES_CRYPTO_KEY = SENTINEL;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd403p-'));
  try {
    const probe = initCrypto();
    assert.deepEqual(Object.keys(probe).sort(), ['encryption_active', 'key_format_production_compatible', 'key_present']);
    assert.equal(probe.key_present, true);
    assert.equal(probe.key_format_production_compatible, true);
    const { report } = await runTarget('P', fakeIo('P', { initCrypto }).io);
    fs.writeFileSync(path.join(dir, 'canonical-id-set.json.gz'), zlib.gzipSync(Buffer.from('["a"]')));
    const digest = writePackage(dir, report);
    const blob = fs.readFileSync(path.join(dir, 'report.json'), 'utf8') + fs.readFileSync(path.join(dir, 'package-manifest.json'), 'utf8');
    assert.equal(blob.includes(SENTINEL), false, 'no key material in the package');
    for (let i = 0; i + 8 <= SENTINEL.length; i += 8) {
      assert.equal(blob.includes(SENTINEL.slice(i, i + 8)), false, 'no 8-character key fragment may appear');
    }
    // Package manifest enumerates every member and the digest is reproducible.
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package-manifest.json'), 'utf8'));
    assert.deepEqual(pkg.files.map((f) => f.name).sort(), ['canonical-id-set.json.gz', 'report.json']);
    assert.ok(pkg.files.every((f) => typeof f.size === 'number' && /^[0-9a-f]{64}$/.test(f.sha256)));
    assert.equal(writePackage(dir, report), digest, 'package sha256 is reproducible');
  } finally {
    if (prev === undefined) delete process.env.AES_CRYPTO_KEY; else process.env.AES_CRYPTO_KEY = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

