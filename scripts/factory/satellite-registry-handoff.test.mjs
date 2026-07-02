// scripts/factory/satellite-registry-handoff.test.mjs
//
// Hermetic node:test suite for the authoritative R2 SATELLITE-REGISTRY handoff
// contract (Founder D-228/D-230). NO real network, NO real tar, NO real disk:
// the R2 client, registry scanner, disk probe, archive builder, hasher, archive
// lister and extractor are ALL injected fakes that drive the PRODUCTION code
// paths exported from satellite-registry-handoff.mjs. Node built-ins only.
//
// Covers: the 12 D-230 transport-contract tests (C10) + the C5 full-verify tests
// + the C6 immutability-collision tests + the D-219 non-contamination proof (the
// core aggregate-handoff.mjs ALLOWED_CONSUMERS excludes every satellite role, so
// adding one there reds the core exact-array test — proven by importing the core
// array READ-ONLY, never modifying it).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';

import {
  SCHEMA_VERSION, CARRIER_TYPE, PRODUCER_ROLE, HANDOFF_PREFIX_ROOT, ARCHIVE_BASENAME,
  MANIFEST_BASENAME, REGISTRY_ROOT, REGISTRY_SHARD_FLOOR, COMPLETION_STATE,
  ALLOWED_CONSUMERS, PREFLIGHT_ROLE, FORBIDDEN_MANIFEST_FIELDS, FORBIDDEN_RERUN_PHRASE,
  DETERMINISTIC_TAR_ARGS, SatelliteHandoffError, isSha256Hex,
  assertIdentity, buildHandoffPrefix, archiveKeyFor, manifestKeyFor,
  consumerStagingDir, assertConsumerRoleKnown, inventorySha256, buildSourceSnapshot,
  buildManifest, validateManifest, assertArchiveOutsidePayloadRoots, validateArchiveEntries,
  assertRegistryRootPresent, archiveInventoryFromEntries,
  establishSatelliteHandoff, preflightSatelliteHandoff, consumeSatelliteHandoff,
  satelliteGraphRecoveryGuidance, identityFromEnv,
} from './satellite-registry-handoff.mjs';

// D-219 NON-CONTAMINATION: import the CORE frozen array READ-ONLY (never modify it).
import { ALLOWED_CONSUMERS as CORE_ALLOWED_CONSUMERS, HANDOFF_PREFIX_ROOT as CORE_PREFIX_ROOT } from './aggregate-handoff.mjs';

// --------------------------------------------------------------------------
// Fixtures + fake harness
// --------------------------------------------------------------------------
function ident(over = {}) {
  return { cycleId: 'proc-100', runId: 'run-200', runAttempt: '1', producerMainSha: 'a'.repeat(40), ...over };
}
function hashBuf(buf) {
  if (!buf) throw new Error('hashFile: missing local buffer');
  return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
// n contiguous canonical shards part-000.bin .. part-(n-1).bin, size = 1000 + idx.
function mkFiles(n) {
  const files = [];
  for (let i = 0; i < n; i += 1) files.push({ path: `${REGISTRY_ROOT}/part-${String(i).padStart(3, '0')}.bin`, size: 1000 + i });
  return files;
}
function entriesFromFiles(files) {
  return [
    { name: 'cache/', type: 'dir', size: 0, linkTarget: '' },
    { name: 'cache/registry/', type: 'dir', size: 0, linkTarget: '' },
    ...files.map((f) => ({ name: f.path, type: 'file', size: f.size, linkTarget: '' })),
  ];
}

class FakeR2 {
  constructor(vfs) {
    this.vfs = vfs; this.objects = new Map(); this.opLog = [];
    this.faults = {}; this.corruptUpload = false;
  }
  _notFound() { return new SatelliteHandoffError('R2_OBJECT_NOT_FOUND', 'nf'); }
  async uploadFile(key, filePath) {
    this.opLog.push(['uploadFile', key]);
    if (this.faults.uploadFile) throw this.faults.uploadFile;
    let body = this.vfs.get(path.resolve(filePath));
    if (!body) throw new Error('uploadFile: missing local ' + filePath);
    if (this.corruptUpload) body = body.subarray(0, body.length - 1);
    this.objects.set(key, { body: Buffer.from(body) });
    if (this.faults.uploadFileAfter) throw this.faults.uploadFileAfter;
  }
  async putObject(key, body) {
    this.opLog.push(['putObject', key]);
    if (this.faults.putObject) throw this.faults.putObject;
    this.objects.set(key, { body: Buffer.from(body) });
  }
  async headObject(key) {
    this.opLog.push(['headObject', key]);
    const o = this.objects.get(key); if (!o) throw this._notFound();
    return { size: o.body.length, etag: '"' + crypto.createHash('md5').update(o.body).digest('hex') + '-3"' };
  }
  async getObjectBuffer(key) {
    this.opLog.push(['getObjectBuffer', key]);
    const o = this.objects.get(key); if (!o) throw this._notFound();
    return Buffer.from(o.body);
  }
  async getObjectToFile(key, dest) {
    this.opLog.push(['getObjectToFile', key]);
    const o = this.objects.get(key); if (!o) throw this._notFound();
    this.vfs.set(path.resolve(dest), Buffer.from(o.body));
  }
}

function makeWorld(opts = {}) {
  const vfs = new Map();
  const files = opts.files || mkFiles(opts.shardCount ?? 128);
  const archiveBuf = opts.archiveBuf || Buffer.from('SAT-ARCHIVE-' + Math.random().toString(36));
  const state = { buildCalled: false, extractCalled: false, stagingDirs: [], cleaned: [], scanCount: 0 };
  const r2 = new FakeR2(vfs);
  const clock = { now: () => opts.now ?? 1_700_000_000_000 };
  const producerDeps = {
    scanRegistry: opts.scanRegistry || (() => {
      const i = state.scanCount; state.scanCount += 1;
      if (opts.scanSequence) return opts.scanSequence[Math.min(i, opts.scanSequence.length - 1)];
      return files;
    }),
    ensureDir: opts.ensureDir || (() => { state.ensureDirCalled = true; }),
    realpathDir: opts.realpathDir || ((d) => d),
    freeBytes: opts.freeBytes || (() => opts.free ?? 500 * 2 ** 30),
    buildArchive: opts.buildArchive || ((ap) => { state.buildCalled = true; vfs.set(path.resolve(ap), archiveBuf); }),
    hashFile: (p) => hashBuf(vfs.get(path.resolve(p))),
    listArchiveEntries: opts.producerEntries || (() => entriesFromFiles(opts.archiveEntriesFiles || files)),
  };
  const consumerDeps = {
    prepareCleanStaging: (sd, td) => { state.stagingDirs.push(sd); state.treeDir = td; },
    download: async (r2c, key, dest) => { await r2c.getObjectToFile(key, dest); },
    hashFile: (p) => hashBuf(vfs.get(path.resolve(p))),
    listArchiveEntries: () => entriesFromFiles(opts.archiveEntriesFiles || files),
    extract: () => { state.extractCalled = true; },
    scanExtractedRegistry: () => (opts.extractedFiles || files),
    cleanup: (d) => { state.cleaned.push(d); },
  };
  return { vfs, files, archiveBuf, state, r2, clock, producerDeps, consumerDeps };
}

function seedValidHandoff(world, identity, over = {}) {
  return establishSatelliteHandoff({
    r2: world.r2, identity, workspaceDir: '/ws', archivePath: '/tmp/sat/registry.tar.zst',
    handoffTempRoot: '/tmp', deps: world.producerDeps, clock: world.clock, ...over,
  });
}
function preflight(world, identity, overDeps = {}) {
  return preflightSatelliteHandoff({ r2: world.r2, identity, stagingRoot: '/rt/sat-pre', deps: { ...world.consumerDeps, ...overDeps }, clock: world.clock });
}
function consume(world, identity, role, overDeps = {}) {
  return consumeSatelliteHandoff({ r2: world.r2, identity, consumerRole: role, stagingRoot: '/rt/sat', deps: { ...world.consumerDeps, ...overDeps }, clock: world.clock });
}
async function rejects(fn, code) {
  await assert.rejects(fn, (e) => { assert.ok(e instanceof SatelliteHandoffError, `expected SatelliteHandoffError got ${e}`); assert.equal(e.code, code, 'code'); return true; });
}
function rejectsSync(fn, code) {
  assert.throws(fn, (e) => { assert.ok(e instanceof SatelliteHandoffError, `expected SatelliteHandoffError got ${e}`); assert.equal(e.code, code); return true; });
}

// ==========================================================================
// A. CONSTANTS / IDENTITY / NAMESPACE (§6/§7/§8) + distinct-from-core
// ==========================================================================
test('(A1) allowed_consumers is the exact ordered satellite quad', () => {
  assert.deepEqual([...ALLOWED_CONSUMERS], ['search-index', 'rankings', 'knowledge-mesh', 'trending']);
});
test('(A2) carrier_type + producer_role are frozen literals', () => {
  assert.equal(CARRIER_TYPE, 'satellite-registry');
  assert.equal(PRODUCER_ROLE, 'merge-core-persist');
});
test('(A3) namespace root is distinct from the core handoff root', () => {
  assert.equal(HANDOFF_PREFIX_ROOT, 'internal-handoff/aggregate-satellite');
  assert.notEqual(HANDOFF_PREFIX_ROOT, CORE_PREFIX_ROOT);
  assert.ok(buildHandoffPrefix(ident()).startsWith('internal-handoff/aggregate-satellite/'));
});
test('(A4) prefix embeds cycle/run/attempt/producer-sha; rejects latest + traversal', () => {
  assert.equal(buildHandoffPrefix(ident()), 'internal-handoff/aggregate-satellite/proc-100/run-200/1/' + 'a'.repeat(40) + '/');
  rejectsSync(() => buildHandoffPrefix(ident({ runAttempt: 'latest' })), 'HANDOFF_IDENTITY_INVALID');
  rejectsSync(() => assertIdentity(ident({ runId: 'a/b' })), 'HANDOFF_IDENTITY_INVALID');
});
test('(A5) archive + manifest keys are attempt-scoped siblings', () => {
  assert.equal(archiveKeyFor(ident()), buildHandoffPrefix(ident()) + ARCHIVE_BASENAME);
  assert.equal(manifestKeyFor(ident()), buildHandoffPrefix(ident()) + MANIFEST_BASENAME);
});
test('(A6) identityFromEnv reads CYCLE_ID + GITHUB_* + PRODUCER_MAIN_SHA fallback', () => {
  const id = identityFromEnv({ CYCLE_ID: 'c', GITHUB_RUN_ID: 'r', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'b'.repeat(40) });
  assert.equal(id.producerMainSha, 'b'.repeat(40));
  rejectsSync(() => identityFromEnv({ GITHUB_RUN_ID: 'r', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'x' }), 'HANDOFF_IDENTITY_INVALID');
});

// ==========================================================================
// B. C9(a) SOURCE SNAPSHOT — D-230 transport tests 7,8,9,11,12 + grammar/path
// ==========================================================================
test('(B1) valid source snapshot: count/min/max/aggregate/hash', () => {
  const s = buildSourceSnapshot(mkFiles(128));
  assert.equal(s.shardCount, 128);
  assert.equal(s.minIndex, 0);
  assert.equal(s.maxIndex, 127);
  assert.equal(s.aggregateBytes, mkFiles(128).reduce((a, f) => a + f.size, 0));
  assert.ok(isSha256Hex(s.inventorySha256));
  assert.equal(s.inventory.length, 128);
});
test('(B2 / D230-12) empty source REJECTED', () => rejectsSync(() => buildSourceSnapshot([]), 'SOURCE_REGISTRY_EMPTY'));
test('(B3 / D230-11) source count below floor REJECTED', () => {
  assert.ok(REGISTRY_SHARD_FLOOR > 3);
  rejectsSync(() => buildSourceSnapshot(mkFiles(3)), 'SOURCE_SHARD_COUNT_BELOW_FLOOR');
});
test('(B4 / D230-7) middle-index gap REJECTED', () => {
  const files = mkFiles(128).filter((f) => !f.path.endsWith('part-064.bin')); // 127 files, min0..max127
  rejectsSync(() => buildSourceSnapshot(files), 'SOURCE_SHARD_INDEX_GAP');
});
test('(B5 / D230-8) duplicate shard index REJECTED', () => {
  const files = [...mkFiles(128), { path: `${REGISTRY_ROOT}/part-005.bin`, size: 9 }];
  rejectsSync(() => buildSourceSnapshot(files), 'SOURCE_DUPLICATE_SHARD_INDEX');
});
test('(B6 / D230-9) unexpected filename REJECTED', () => {
  rejectsSync(() => buildSourceSnapshot([...mkFiles(120), { path: `${REGISTRY_ROOT}/README.md`, size: 5 }]), 'SOURCE_UNEXPECTED_FILE');
});
test('(B7) non-canonical zero-pad (part-5.bin) REJECTED', () => {
  rejectsSync(() => buildSourceSnapshot([...mkFiles(120), { path: `${REGISTRY_ROOT}/part-5.bin`, size: 5 }]), 'SOURCE_UNEXPECTED_FILE');
});
test('(B8) absolute + traversal + nested + outside-root paths REJECTED', () => {
  rejectsSync(() => buildSourceSnapshot([{ path: '/etc/passwd', size: 1 }]), 'SOURCE_ABSOLUTE_PATH');
  rejectsSync(() => buildSourceSnapshot([{ path: `${REGISTRY_ROOT}/../evil`, size: 1 }]), 'SOURCE_TRAVERSAL_PATH');
  rejectsSync(() => buildSourceSnapshot([{ path: `${REGISTRY_ROOT}/sub/part-000.bin`, size: 1 }]), 'SOURCE_UNEXPECTED_FILE');
  rejectsSync(() => buildSourceSnapshot([{ path: 'output/part-000.bin', size: 1 }]), 'SOURCE_UNEXPECTED_FILE');
});
test('(B9) inventory_sha256 is order-independent + not a self/archive hash', () => {
  const a = inventorySha256(mkFiles(4));
  const b = inventorySha256([...mkFiles(4)].reverse());
  assert.equal(a, b);
  assert.ok(isSha256Hex(a));
});

// ==========================================================================
// C. MANIFEST SCHEMA + VALIDATION (§6 + C9(d) inventory array)
// ==========================================================================
function validManifest(identity = ident(), over = {}) {
  const snap = buildSourceSnapshot(mkFiles(128));
  const m = buildManifest({ identity, snapshot: snap, archiveBytes: 100, archiveSha256: 'd'.repeat(64), createdAtUtc: '1970-01-01T00:00:00.000Z' });
  return { ...m, ...over };
}
test('(C1) buildManifest emits 15 fields + inventory array; carrier/role/consumers frozen', () => {
  const m = validManifest();
  assert.equal(m.schema_version, SCHEMA_VERSION);
  assert.equal(m.carrier_type, CARRIER_TYPE);
  assert.equal(m.producer_role, PRODUCER_ROLE);
  assert.equal(m.completion_state, COMPLETION_STATE);
  assert.deepEqual(m.allowed_consumers, ['search-index', 'rankings', 'knowledge-mesh', 'trending']);
  assert.equal(m.registry_shard_count, 128);
  assert.equal(m.inventory.length, 128);
  assert.ok(!('expected_consumer' in m));
  assert.deepEqual([...FORBIDDEN_MANIFEST_FIELDS], ['expected_consumer']);
  for (const k of Object.keys(m)) assert.ok(!/access|secret|token|password|cred/i.test(k), `leak key ${k}`);
});
test('(C2) valid manifest passes validateManifest', () => { assert.ok(validateManifest(validManifest(), ident())); });
test('(C3) reject wrong carrier_type / producer_role', () => {
  rejectsSync(() => validateManifest(validManifest(ident(), { carrier_type: 'core' }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
  rejectsSync(() => validateManifest(validManifest(ident(), { producer_role: 'finalize' }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(C4) reject completion != complete', () => rejectsSync(() => validateManifest(validManifest(ident(), { completion_state: 'partial' }), ident()), 'HANDOFF_MANIFEST_INCOMPLETE'));
test('(C5) reject wildcard / 5th / reordered / duplicate consumers', () => {
  for (const c of [['*'], ['search-index', 'rankings', 'knowledge-mesh', 'trending', 'x'], ['rankings', 'search-index', 'knowledge-mesh', 'trending'], ['search-index', 'search-index', 'knowledge-mesh', 'trending']]) {
    rejectsSync(() => validateManifest(validManifest(ident(), { allowed_consumers: c }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
  }
});
test('(C6) reject shard_count below floor + multipart-ETag-as-sha', () => {
  rejectsSync(() => validateManifest(validManifest(ident(), { registry_shard_count: 3 }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
  assert.equal(isSha256Hex('abc123-50'), false);
  rejectsSync(() => validateManifest(validManifest(ident(), { archive_sha256: 'abc123-50' }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(C7) reject inventory length != shard_count', () => {
  rejectsSync(() => validateManifest(validManifest(ident(), { inventory: mkFiles(127) }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(C8) reject inventory whose hash != inventory_sha256 (tamper)', () => {
  const m = validManifest();
  m.inventory[0] = { path: m.inventory[0].path, size: m.inventory[0].size + 1 };
  rejectsSync(() => validateManifest(m, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(C9) identity mismatches (run/attempt/cycle/sha + archive_key)', () => {
  rejectsSync(() => validateManifest(validManifest(), ident({ runId: 'run-999' })), 'HANDOFF_IDENTITY_MISMATCH');
  rejectsSync(() => validateManifest(validManifest(ident({ runAttempt: '1' })), ident({ runAttempt: '2' })), 'HANDOFF_IDENTITY_MISMATCH');
  rejectsSync(() => validateManifest(validManifest(ident({ cycleId: 'proc-OLD' })), ident()), 'HANDOFF_IDENTITY_MISMATCH');
  rejectsSync(() => validateManifest(validManifest(), ident({ producerMainSha: 'f'.repeat(40) })), 'HANDOFF_IDENTITY_MISMATCH');
  rejectsSync(() => validateManifest(validManifest(ident(), { archive_key: 'internal-handoff/aggregate-satellite/x/y/z/w/registry.tar.zst' }), ident()), 'HANDOFF_IDENTITY_MISMATCH');
});
test('(C10) reject re-introduced superseded expected_consumer field', () => {
  rejectsSync(() => validateManifest(validManifest(ident(), { expected_consumer: 'trending' }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
});

// ==========================================================================
// D. ARCHIVE SAFETY (§5 / §10) + member-set helper
// ==========================================================================
test('(D1) archive inside cache/registry rejected; outside accepted', () => {
  rejectsSync(() => assertArchiveOutsidePayloadRoots('/ws/cache/registry/x.tar.zst', '/ws'), 'ARCHIVE_INSIDE_PAYLOAD_ROOT');
  assert.doesNotThrow(() => assertArchiveOutsidePayloadRoots('/rt/sat/registry.tar.zst', '/ws'));
});
test('(D2) unsafe archive entries (absolute/traversal/symlink/hardlink) rejected', () => {
  rejectsSync(() => validateArchiveEntries([{ name: '/etc/passwd', type: 'file' }]), 'HANDOFF_UNSAFE_ARCHIVE');
  rejectsSync(() => validateArchiveEntries([{ name: 'cache/registry/../../evil', type: 'file' }]), 'HANDOFF_UNSAFE_ARCHIVE');
  rejectsSync(() => validateArchiveEntries([{ name: 'cache/registry/l', type: 'symlink', linkTarget: '/etc/shadow' }]), 'HANDOFF_UNSAFE_ARCHIVE');
  rejectsSync(() => validateArchiveEntries([{ name: 'cache/registry/h', type: 'hardlink', linkTarget: '../../../secret' }]), 'HANDOFF_UNSAFE_ARCHIVE');
});
test('(D3) required registry root present / absent', () => {
  assert.ok(assertRegistryRootPresent(entriesFromFiles(mkFiles(100))));
  rejectsSync(() => assertRegistryRootPresent([{ name: 'cache/', type: 'dir' }, { name: 'output/x', type: 'file' }]), 'HANDOFF_MISSING_ROOT');
});
test('(D4) archiveInventoryFromEntries drops dirs + sorts files', () => {
  const inv = archiveInventoryFromEntries(entriesFromFiles(mkFiles(4)));
  assert.equal(inv.length, 4);
  assert.deepEqual(inv.map((e) => e.path), inv.map((e) => e.path).slice().sort());
});
test('(D5) DETERMINISTIC_TAR_ARGS matches the §5 command exactly', () => {
  assert.deepEqual([...DETERMINISTIC_TAR_ARGS], ['--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0', '--numeric-owner', '--pax-option=delete=atime,delete=ctime', '--use-compress-program=zstd -T0 -3']);
});

// ==========================================================================
// E. PRODUCER establish (C5 / C9) — success, member-set, stability, disk, faults
// ==========================================================================
test('(E1 / D230-1) success: source snapshot == archive member set; establishes archive+manifest LAST', async () => {
  const w = makeWorld();
  const res = await seedValidHandoff(w, ident());
  assert.equal(res.ok, true);
  assert.equal(res.registryShardCount, 128);
  assert.ok(w.r2.objects.has(archiveKeyFor(ident())));
  assert.ok(w.r2.objects.has(manifestKeyFor(ident())));
  const upIdx = w.r2.opLog.findIndex(([o]) => o === 'uploadFile');
  const mIdx = w.r2.opLog.findIndex(([o, k]) => o === 'putObject' && k.endsWith(MANIFEST_BASENAME));
  assert.ok(upIdx >= 0 && mIdx >= 0 && upIdx < mIdx, 'upload precedes manifest (manifest LAST)');
  const m = JSON.parse(w.r2.objects.get(manifestKeyFor(ident())).body.toString());
  assert.ok(isSha256Hex(m.archive_sha256)); // sha, never the multipart etag
  assert.equal(m.inventory.length, 128);
});
test('(E2) HeadObject byte verify + manifest re-fetch/validate before green', async () => {
  const w = makeWorld();
  await seedValidHandoff(w, ident());
  assert.ok(w.r2.opLog.some(([o]) => o === 'headObject'));
  assert.ok(w.r2.opLog.filter(([o, k]) => o === 'getObjectBuffer' && k.endsWith(MANIFEST_BASENAME)).length >= 1);
});
test('(E3) determinism: identical source + archive bytes => identical archive_sha256 + inventory_sha256', async () => {
  const buf = Buffer.from('FIXED-ARCHIVE-BYTES');
  const w1 = makeWorld({ archiveBuf: buf }); const r1 = await seedValidHandoff(w1, ident());
  const w2 = makeWorld({ archiveBuf: buf }); const r2b = await seedValidHandoff(w2, ident());
  assert.equal(r1.archiveSha256, r2b.archiveSha256);
  assert.equal(r1.inventorySha256, r2b.inventorySha256);
});
test('(E4 / D230-2) archive MISSING a source member REJECTED, no upload, no manifest', async () => {
  const w = makeWorld({ archiveEntriesFiles: mkFiles(128).slice(0, 127) });
  await rejects(() => seedValidHandoff(w, ident()), 'ARCHIVE_MEMBER_SET_MISMATCH');
  assert.equal(w.r2.objects.size, 0);
});
test('(E5 / D230-3) archive EXTRA member REJECTED, no upload, no manifest', async () => {
  const w = makeWorld({ archiveEntriesFiles: [...mkFiles(128), { path: `${REGISTRY_ROOT}/part-500.bin`, size: 7 }] });
  await rejects(() => seedValidHandoff(w, ident()), 'ARCHIVE_MEMBER_SET_MISMATCH');
  assert.equal(w.r2.objects.size, 0);
});
test('(E6 / D230-10) SOURCE changed between pre-scan and post-package scan REJECTED, no upload', async () => {
  const changed = mkFiles(128).map((f, i) => (i === 5 ? { ...f, size: f.size + 999 } : f));
  const w = makeWorld({ scanSequence: [mkFiles(128), changed] });
  await rejects(() => seedValidHandoff(w, ident()), 'SOURCE_CHANGED_DURING_AUTHORITY_ESTABLISHMENT');
  assert.equal(w.state.buildCalled, true, 'archive was built');
  assert.ok(!w.r2.objects.has(manifestKeyFor(ident())));
  assert.ok(!w.r2.objects.has(archiveKeyFor(ident())));
});
test('(E7) disk preflight failure => RED, no build, no R2 op', async () => {
  const w = makeWorld({ free: 10, files: mkFiles(128) });
  await rejects(() => seedValidHandoff(w, ident()), 'INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_ARCHIVE');
  assert.equal(w.state.buildCalled, false);
  assert.equal(w.r2.objects.size, 0);
  assert.equal(w.r2.opLog.length, 0);
});
test('(E8) missing payload root => fatal, no upload', async () => {
  const w = makeWorld({ scanRegistry: () => { throw new SatelliteHandoffError('MISSING_PAYLOAD_ROOT', 'cache/registry/'); } });
  await rejects(() => seedValidHandoff(w, ident()), 'MISSING_PAYLOAD_ROOT');
  assert.equal(w.r2.objects.size, 0);
});
test('(E9) source below floor at establish => RED, no upload', async () => {
  const w = makeWorld({ files: mkFiles(3) });
  await rejects(() => seedValidHandoff(w, ident()), 'SOURCE_SHARD_COUNT_BELOW_FLOOR');
  assert.equal(w.r2.objects.size, 0);
});
test('(E10) archive built inside cache/registry rejected before build', async () => {
  const w = makeWorld();
  await rejects(() => establishSatelliteHandoff({ r2: w.r2, identity: ident(), workspaceDir: '/ws', archivePath: '/ws/cache/registry/x.tar.zst', handoffTempRoot: '/ws', deps: w.producerDeps, clock: w.clock }), 'ARCHIVE_INSIDE_PAYLOAD_ROOT');
  assert.equal(w.state.buildCalled, false);
});
test('(E11) upload denied / interrupted / corrupt => no manifest', async () => {
  const w1 = makeWorld(); w1.r2.faults.uploadFile = new SatelliteHandoffError('HANDOFF_UPLOAD_FAILED', 'denied');
  await rejects(() => seedValidHandoff(w1, ident()), 'HANDOFF_UPLOAD_FAILED');
  assert.ok(!w1.r2.objects.has(manifestKeyFor(ident())));
  const w2 = makeWorld(); w2.r2.corruptUpload = true;
  await rejects(() => seedValidHandoff(w2, ident()), 'HANDOFF_UPLOAD_VERIFY_FAILED');
  assert.ok(!w2.r2.objects.has(manifestKeyFor(ident())));
});
test('(E12) manifest write denied / reverify drift => RED', async () => {
  const w1 = makeWorld(); w1.r2.faults.putObject = new SatelliteHandoffError('HANDOFF_MANIFEST_WRITE_FAILED', 'denied');
  await rejects(() => seedValidHandoff(w1, ident()), 'HANDOFF_MANIFEST_WRITE_FAILED');
  const w2 = makeWorld();
  const origGet = w2.r2.getObjectBuffer.bind(w2.r2);
  w2.r2.getObjectBuffer = async (key) => { const b = await origGet(key); if (key.endsWith(MANIFEST_BASENAME)) { const m = JSON.parse(b.toString()); m.archive_bytes += 7; return Buffer.from(JSON.stringify(m)); } return b; };
  await rejects(() => seedValidHandoff(w2, ident()), 'MANIFEST_REVERIFY_FAILED');
});

// ==========================================================================
// F. C6 IMMUTABILITY — fail-closed collision (no overwrite of the exact tuple)
// ==========================================================================
test('(F1) existing MANIFEST => AUTHORITY_COLLISION, no build, no overwrite', async () => {
  const w = makeWorld();
  w.r2.objects.set(manifestKeyFor(ident()), { body: Buffer.from('{"pre":true}') });
  await rejects(() => seedValidHandoff(w, ident()), 'AUTHORITY_COLLISION');
  assert.equal(w.state.buildCalled, false);
  assert.equal(w.r2.objects.get(manifestKeyFor(ident())).body.toString(), '{"pre":true}');
});
test('(F2) existing ARCHIVE without manifest => ORPHANED_PARTIAL_AUTHORITY_COLLISION', async () => {
  const w = makeWorld();
  w.r2.objects.set(archiveKeyFor(ident()), { body: Buffer.from('partial') });
  await rejects(() => seedValidHandoff(w, ident()), 'ORPHANED_PARTIAL_AUTHORITY_COLLISION');
  assert.equal(w.state.buildCalled, false);
});
test('(F3) attempted re-establish of the SAME tuple is rejected (no overwrite)', async () => {
  const w = makeWorld();
  await seedValidHandoff(w, ident());
  assert.equal(w.r2.objects.size, 2);
  await rejects(() => seedValidHandoff(w, ident()), 'AUTHORITY_COLLISION');
  assert.equal(w.r2.objects.size, 2, 'no third/overwritten object');
});
test('(F4) a NEW attempt (fresh prefix) is NOT a collision', async () => {
  const w = makeWorld(); // same bucket + same source; a fresh attempt tuple = new prefix
  await seedValidHandoff(w, ident());
  const res = await seedValidHandoff(w, ident({ runAttempt: '2' }));
  assert.equal(res.ok, true);
  assert.ok(w.r2.objects.has(manifestKeyFor(ident({ runAttempt: '2' }))));
  assert.equal(w.r2.objects.size, 4, 'attempt-1 + attempt-2 objects coexist, none overwritten');
});

// ==========================================================================
// G. PREFLIGHT (C5) — full independent verify in its own staging, exposes nothing
// ==========================================================================
test('(G1) preflight verifies archive+inventory then cleans its temp (exposes nothing)', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  const res = await preflight(w, ident());
  assert.equal(res.ok, true);
  assert.equal(res.registryShardCount, 128);
  assert.ok(w.state.extractCalled, 'preflight fully extracts to verify');
  assert.equal(w.state.cleaned.length, 1, 'preflight deletes its own temp copy');
  assert.ok(w.state.cleaned[0].includes(PREFLIGHT_ROLE));
});
test('(G2 / D230-5) preflight inventory != manifest REJECTED', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  const changed = mkFiles(128).map((f, i) => (i === 9 ? { ...f, size: f.size + 5 } : f));
  await rejects(() => preflight(w, ident(), { scanExtractedRegistry: () => changed }), 'HANDOFF_INVENTORY_MISMATCH');
});
test('(G3) preflight missing manifest / missing archive / byte / sha', async () => {
  const wEmpty = makeWorld();
  await rejects(() => preflight(wEmpty, ident()), 'HANDOFF_MANIFEST_MISSING');
  const wA = makeWorld(); await seedValidHandoff(wA, ident()); wA.r2.objects.delete(archiveKeyFor(ident()));
  await rejects(() => preflight(wA, ident()), 'HANDOFF_ARCHIVE_MISSING');
  const wB = makeWorld(); await seedValidHandoff(wB, ident());
  const mk = manifestKeyFor(ident()); const m = JSON.parse(wB.r2.objects.get(mk).body.toString()); m.archive_bytes += 1;
  wB.r2.objects.set(mk, { body: Buffer.from(JSON.stringify(m)) });
  await rejects(() => preflight(wB, ident()), 'HANDOFF_BYTE_MISMATCH');
});

// ==========================================================================
// H. CONSUMERS (C9(b) / D230-4,6) — 4 roles, independent, role-segmented
// ==========================================================================
test('(H1) each of the four satellites verifies + extracts to its OWN role staging', async () => {
  for (const role of ALLOWED_CONSUMERS) {
    const w = makeWorld(); await seedValidHandoff(w, ident());
    const res = await consume(w, ident(), role);
    assert.equal(res.ok, true);
    assert.equal(w.state.extractCalled, true);
    assert.ok(res.treeDir.includes(role), `staging carries role ${role}`);
  }
});
test('(H2) the four consumers + preflight use DISTINCT staging paths', () => {
  const paths = ALLOWED_CONSUMERS.map((r) => consumerStagingDir('/rt/base', ident(), r));
  assert.equal(new Set(paths).size, ALLOWED_CONSUMERS.length);
  for (const r of ALLOWED_CONSUMERS) assert.ok(consumerStagingDir('/rt/base', ident(), r).includes(r));
});
test('(H3) unauthorized / unknown role => UNAUTHORIZED, zero writes', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  await rejects(() => consume(w, ident(), 'attacker'), 'UNAUTHORIZED_HANDOFF_CONSUMER');
  assert.equal(w.state.extractCalled, false);
  assert.equal(assertConsumerRoleKnown('trending'), 'trending');
  rejectsSync(() => assertConsumerRoleKnown('merge-core-persist'), 'UNAUTHORIZED_HANDOFF_CONSUMER'); // core role is NOT a satellite consumer
});
test('(H4 / D230-6) each consumer inventory != manifest REJECTED', async () => {
  for (const role of ALLOWED_CONSUMERS) {
    const w = makeWorld(); await seedValidHandoff(w, ident());
    const changed = mkFiles(128).map((f, i) => (i === 3 ? { ...f, size: f.size + 2 } : f));
    await rejects(() => consume(w, ident(), role, { scanExtractedRegistry: () => changed }), 'HANDOFF_INVENTORY_MISMATCH');
    assert.equal(w.state.extractCalled, true); // mismatch is post-extraction; nothing exposed to workspace
  }
});
test('(H5) extracted shard COUNT mismatch => distinct code', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  await rejects(() => consume(w, ident(), 'search-index', { scanExtractedRegistry: () => mkFiles(127) }), 'HANDOFF_SHARD_COUNT_MISMATCH');
});
test('(H6) byte / sha mismatch on download => distinct codes, zero extract', async () => {
  const w1 = makeWorld(); await seedValidHandoff(w1, ident());
  let mk = manifestKeyFor(ident()); let m = JSON.parse(w1.r2.objects.get(mk).body.toString()); m.archive_bytes += 1;
  w1.r2.objects.set(mk, { body: Buffer.from(JSON.stringify(m)) });
  await rejects(() => consume(w1, ident(), 'rankings'), 'HANDOFF_BYTE_MISMATCH');
  assert.equal(w1.state.extractCalled, false);
  const w2 = makeWorld(); await seedValidHandoff(w2, ident());
  m = JSON.parse(w2.r2.objects.get(mk).body.toString()); m.archive_sha256 = 'e'.repeat(64);
  w2.r2.objects.set(mk, { body: Buffer.from(JSON.stringify(m)) });
  await rejects(() => consume(w2, ident(), 'trending'), 'HANDOFF_SHA_MISMATCH');
  assert.equal(w2.state.extractCalled, false);
});
test('(H7) unsafe archive members => UNSAFE, never extracted', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  await rejects(() => consume(w, ident(), 'knowledge-mesh', { listArchiveEntries: () => [{ name: 'cache/registry/../../evil', type: 'file', size: 1 }] }), 'HANDOFF_UNSAFE_ARCHIVE');
  assert.equal(w.state.extractCalled, false);
});
test('(H8) archive member-set mismatch at consumer (missing member) => rejected before extract', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  await rejects(() => consume(w, ident(), 'search-index', { listArchiveEntries: () => entriesFromFiles(mkFiles(128).slice(0, 127)) }), 'ARCHIVE_MEMBER_SET_MISMATCH');
  assert.equal(w.state.extractCalled, false);
});
test('(H9) missing manifest/archive + identity-mismatch manifest => distinct codes, zero extract', async () => {
  const w1 = makeWorld();
  await rejects(() => consume(w1, ident(), 'search-index'), 'HANDOFF_MANIFEST_MISSING');
  const w2 = makeWorld(); await seedValidHandoff(w2, ident()); w2.r2.objects.delete(archiveKeyFor(ident()));
  await rejects(() => consume(w2, ident(), 'rankings'), 'HANDOFF_ARCHIVE_MISSING');
  const w3 = makeWorld();
  w3.r2.objects.set(manifestKeyFor(ident()), { body: Buffer.from(JSON.stringify(validManifest(ident({ producerMainSha: 'c'.repeat(40) })))) });
  await rejects(() => consume(w3, ident(), 'trending'), 'HANDOFF_IDENTITY_MISMATCH');
  assert.equal(w3.state.extractCalled, false);
});
test('(H10) consumer signature carries NO peer-trust parameter', () => {
  const sig = consumeSatelliteHandoff.toString();
  const head = sig.slice(0, sig.indexOf('{', sig.indexOf('{') + 1));
  assert.ok(!/persist(Ok|Conclusion|Flag)|peerConclusion|outputFlag|inheritedBool/i.test(head));
  assert.ok(/r2, identity, consumerRole, stagingRoot/.test(head));
});
test('(H11) neither consumer deletes any R2 object', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  const before = w.r2.objects.size;
  await consume(w, ident(), 'search-index'); await consume(w, ident(), 'trending');
  assert.equal(w.r2.objects.size, before);
  assert.ok(!w.r2.opLog.some(([o]) => /delete/i.test(o)));
});

// ==========================================================================
// I. RECOVERY GUIDANCE + D-219 NON-CONTAMINATION (isolation proof)
// ==========================================================================
test('(I1) recovery guidance never emits the generic phrase; producer-green => RERUN_ALL', () => {
  assert.equal(satelliteGraphRecoveryGuidance({ producerConclusion: 'success' }).verdict, 'RERUN_ALL');
  for (const args of [{ producerConclusion: 'success' }, { producerConclusion: 'failure', missingProducersInFailedSet: true }, { rerunLimitConsumed: true }, {}]) {
    assert.ok(!satelliteGraphRecoveryGuidance(args).message.includes(FORBIDDEN_RERUN_PHRASE));
  }
});
test('(I2) ISOLATION: the CORE aggregate-handoff ALLOWED_CONSUMERS excludes every satellite role', () => {
  // Read-only proof: the core frozen set is exactly [merge-core-persist, finalize]
  // and contains NONE of the four satellite roles. Adding a satellite role to the
  // core module would change THIS array and red the core exact-array test (its
  // test (1)) — that is the D-219 contamination guard this repair must not trip.
  assert.deepEqual([...CORE_ALLOWED_CONSUMERS], ['merge-core-persist', 'finalize']);
  for (const r of ALLOWED_CONSUMERS) assert.ok(!CORE_ALLOWED_CONSUMERS.includes(r), `core must not contain satellite role ${r}`);
  // And the satellite set shares NO member with the core set (disjoint contracts).
  for (const r of ALLOWED_CONSUMERS) assert.ok(!['merge-core-persist', 'finalize'].includes(r));
});
