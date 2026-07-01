// scripts/factory/aggregate-handoff.test.mjs
//
// Hermetic node:test suite for the authoritative R2 aggregate-handoff contract
// (Founder D-209 §T(30)+§R(15) + D-211 §N(20 dual-consumer) obligations, and the
// §K/§S/§O anti-vacuity mutation families). NO real network, NO real tar, NO real
// disk: the R2 client, disk probe, archive builder, hasher, archive lister and
// extractor are ALL injected fakes that drive the PRODUCTION code paths exported
// from aggregate-handoff.mjs. Node built-ins only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

import {
  SCHEMA_VERSION, HANDOFF_PREFIX_ROOT, ARCHIVE_BASENAME, MANIFEST_BASENAME,
  PAYLOAD_ROOTS, DISK_HEADROOM_BYTES, COMPLETION_STATE, ALLOWED_CONSUMERS,
  FORBIDDEN_MANIFEST_FIELDS, FORBIDDEN_RERUN_PHRASE, DETERMINISTIC_TAR_ARGS,
  HandoffError, isSha256Hex,
  assertIdentity, buildHandoffPrefix, archiveKeyFor, manifestKeyFor,
  consumerStagingDir, assertConsumerRoleKnown,
  inventorySha256, buildManifest, validateManifest,
  assertArchiveOutsidePayloadRoots, validateArchiveEntries, assertRequiredRootsPresent,
  establishHandoff, consumeHandoff, producerGraphRecoveryGuidance,
  identityFromEnv, productionProducerDeps, assertArchiveParentConfined,
} from './aggregate-handoff.mjs';

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
function goodEntries() {
  return [
    { name: 'output/', type: 'dir', linkTarget: '' },
    { name: 'output/registry.bin', type: 'file', linkTarget: '' },
    { name: 'cache/', type: 'dir', linkTarget: '' },
    { name: 'cache/global.zst', type: 'file', linkTarget: '' },
    { name: 'artifacts/', type: 'dir', linkTarget: '' },
    { name: 'artifacts/shard-0.zst', type: 'file', linkTarget: '' },
  ];
}
function goodInventory() {
  return [
    { path: 'output/registry.bin', size: 100 },
    { path: 'cache/global.zst', size: 40 },
    { path: 'artifacts/shard-0.zst', size: 10 },
  ];
}

class FakeR2 {
  constructor(vfs) {
    this.vfs = vfs; this.objects = new Map(); this.opLog = [];
    this.faults = {}; this.corruptUpload = false; this.manifestMutator = null;
  }
  _notFound() { const e = new HandoffError('R2_OBJECT_NOT_FOUND', 'nf'); return e; }
  async uploadFile(key, filePath, ct) {
    this.opLog.push(['uploadFile', key]);
    if (this.faults.uploadFile) throw this.faults.uploadFile;
    let body = this.vfs.get(path.resolve(filePath));
    if (!body) throw new Error('uploadFile: missing local ' + filePath);
    if (this.corruptUpload) body = body.subarray(0, body.length - 1);
    this.objects.set(key, { body: Buffer.from(body), ct });
    if (this.faults.uploadFileAfter) throw this.faults.uploadFileAfter; // "interrupted after partial"
  }
  async putObject(key, body, ct) {
    this.opLog.push(['putObject', key]);
    if (this.faults.putObject) throw this.faults.putObject;
    this.objects.set(key, { body: Buffer.from(body), ct });
  }
  async headObject(key) {
    this.opLog.push(['headObject', key]);
    const o = this.objects.get(key); if (!o) throw this._notFound();
    return { size: o.body.length, etag: '"' + crypto.createHash('md5').update(o.body).digest('hex') + '-3"' };
  }
  async getObjectBuffer(key) {
    this.opLog.push(['getObjectBuffer', key]);
    const o = this.objects.get(key); if (!o) throw this._notFound();
    let body = o.body;
    if (this.manifestMutator && key.endsWith(MANIFEST_BASENAME)) body = this.manifestMutator(Buffer.from(body));
    return Buffer.from(body);
  }
  async getObjectToFile(key, dest) {
    this.opLog.push(['getObjectToFile', key]);
    const o = this.objects.get(key); if (!o) throw this._notFound();
    this.vfs.set(path.resolve(dest), Buffer.from(o.body));
  }
}

// A "world": injected fakes + recorded state for one scenario.
function makeWorld(opts = {}) {
  const vfs = new Map();
  const archiveBuf = opts.archiveBuf || Buffer.from('CORE-ARCHIVE-' + Math.random().toString(36));
  const state = { buildCalled: false, extractCalled: false, stagingDirs: [], treeDir: null, exposed: false };
  const r2 = new FakeR2(vfs);
  const clock = { now: () => opts.now ?? 1_700_000_000_000 };
  const producerDeps = {
    scanPayload: opts.scanPayload || (() => ({ logicalBytes: opts.logicalBytes ?? 150, inventory: opts.inventory || goodInventory() })),
    // In-memory fakes: ensureDir is a no-op and realpathDir is identity, so the
    // hermetic suite drives the (reordered) production preflight without touching
    // a real filesystem. The real-fs ordering is exercised by the §G tests below.
    ensureDir: opts.ensureDir || (() => { state.ensureDirCalled = true; }),
    realpathDir: opts.realpathDir || ((d) => d),
    freeBytes: opts.freeBytes || (() => opts.free ?? 500 * 2 ** 30),
    buildArchive: opts.buildArchive || ((ap) => { state.buildCalled = true; vfs.set(path.resolve(ap), archiveBuf); }),
    hashFile: (p) => hashBuf(vfs.get(path.resolve(p))),
  };
  const consumerDeps = {
    prepareCleanStaging: (sd, td) => { state.stagingDirs.push(sd); state.treeDir = td; },
    download: async (r2c, key, dest) => { await r2c.getObjectToFile(key, dest); },
    hashFile: (p) => hashBuf(vfs.get(path.resolve(p))),
    listArchiveEntries: opts.listArchiveEntries || (() => (opts.entries || goodEntries())),
    extract: () => { state.extractCalled = true; },
    verifyExtractedRoots: opts.verifyExtractedRoots || (() => true),
  };
  return { vfs, archiveBuf, state, r2, clock, producerDeps, consumerDeps };
}

async function seedValidHandoff(world, identity, over = {}) {
  const res = await establishHandoff({
    r2: world.r2, identity, workflowIdentity: 'Factory 3/4 - Aggregate',
    workspaceDir: '/ws', archivePath: '/tmp/handoff/handoff.tar.zst',
    // The fake archive parent (/tmp/handoff) is confined under this temp root so
    // the reordered producer preflight passes in the hermetic suite (D-217 §F.2).
    handoffTempRoot: '/tmp',
    deps: world.producerDeps, clock: world.clock, ...over,
  });
  return res;
}
function consume(world, identity, role, over = {}) {
  return consumeHandoff({
    r2: world.r2, identity, consumerRole: role, stagingRoot: '/rt/free2aitools-aggregate-handoff',
    deps: world.consumerDeps, clock: world.clock, ...over,
  });
}
async function rejects(fn, code) {
  await assert.rejects(fn, (e) => { assert.ok(e instanceof HandoffError, `expected HandoffError got ${e}`); assert.equal(e.code, code, `code`); return true; });
}

// ==========================================================================
// A. CONSTANTS / IDENTITY / PREFIX (§H) + no-public / no-latest
// ==========================================================================
test('(1) allowed_consumers is the exact fixed [persist, finalize] order', () => {
  assert.deepEqual([...ALLOWED_CONSUMERS], ['merge-core-persist', 'finalize']);
});
test('(2) prefix is the private internal-handoff namespace, not a public path', () => {
  const p = buildHandoffPrefix(ident());
  assert.ok(p.startsWith('internal-handoff/aggregate/'));
  assert.equal(HANDOFF_PREFIX_ROOT, 'internal-handoff/aggregate');
});
test('(3) prefix embeds cycle/run/attempt/producer-sha in order', () => {
  assert.equal(buildHandoffPrefix(ident()), 'internal-handoff/aggregate/proc-100/run-200/1/' + 'a'.repeat(40) + '/');
});
test('(4) prefix has no mutable "latest" alias — rejected as identity token', () => {
  rejectsSync(() => buildHandoffPrefix(ident({ runAttempt: 'latest' })), 'HANDOFF_IDENTITY_INVALID');
});
test('(5) archive + manifest keys are attempt-scoped siblings', () => {
  assert.equal(archiveKeyFor(ident()), buildHandoffPrefix(ident()) + ARCHIVE_BASENAME);
  assert.equal(manifestKeyFor(ident()), buildHandoffPrefix(ident()) + MANIFEST_BASENAME);
});
test('(6) identity rejects missing components', () => {
  for (const f of ['cycleId', 'runId', 'runAttempt', 'producerMainSha']) rejectsSync(() => assertIdentity(ident({ [f]: '' })), 'HANDOFF_IDENTITY_INVALID');
});
test('(7) identity rejects path-injection / traversal segments', () => {
  rejectsSync(() => assertIdentity(ident({ cycleId: '../evil' })), 'HANDOFF_IDENTITY_INVALID');
  rejectsSync(() => assertIdentity(ident({ runId: 'a/b' })), 'HANDOFF_IDENTITY_INVALID');
});
test('(8) identityFromEnv reads GITHUB_* + CYCLE_ID and falls back GITHUB_SHA', () => {
  const id = identityFromEnv({ CYCLE_ID: 'c', GITHUB_RUN_ID: 'r', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'b'.repeat(40) });
  assert.equal(id.producerMainSha, 'b'.repeat(40));
  assert.equal(id.runAttempt, '2');
});
test('(9) identityFromEnv fails when a component is absent', () => {
  rejectsSync(() => identityFromEnv({ GITHUB_RUN_ID: 'r', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'x' }), 'HANDOFF_IDENTITY_INVALID');
});
function rejectsSync(fn, code) {
  assert.throws(fn, (e) => { assert.ok(e instanceof HandoffError); assert.equal(e.code, code); return true; });
}

// ==========================================================================
// B. MANIFEST SCHEMA + VALIDATION (§I) — incl. wildcard/3rd/reversed/dup/etag
// ==========================================================================
function validManifest(identity = ident(), over = {}) {
  return buildManifest({
    identity, workflowIdentity: 'wf', archiveBytes: 100,
    archiveSha256: 'd'.repeat(64), inventory: goodInventory(), createdAtUtc: '1970-01-01T00:00:00.000Z', ...over,
  });
}
test('(10) buildManifest emits schema_version, exact consumers, completion=complete', () => {
  const m = validManifest();
  assert.equal(m.schema_version, SCHEMA_VERSION);
  assert.deepEqual(m.allowed_consumers, ['merge-core-persist', 'finalize']);
  assert.equal(m.completion_state, COMPLETION_STATE);
});
test('(11) manifest carries no singular expected_consumer field (superseded)', () => {
  assert.ok(!('expected_consumer' in validManifest()));
  assert.deepEqual([...FORBIDDEN_MANIFEST_FIELDS], ['expected_consumer']);
});
test('(12) manifest contains no credential/secret fields', () => {
  const keys = Object.keys(validManifest());
  for (const k of keys) assert.ok(!/access|secret|token|password|cred/i.test(k), `leak key ${k}`);
});
test('(13) valid manifest passes validateManifest', () => { assert.ok(validateManifest(validManifest(), ident())); });
test('(14) reject completion_state != complete (incomplete manifest)', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), completion_state: 'partial' }, ident()), 'HANDOFF_MANIFEST_INCOMPLETE');
});
test('(15) reject wildcard allowed_consumers', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), allowed_consumers: ['*'] }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(16) reject reversed consumer order (fixed workflow order, not lexical)', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), allowed_consumers: ['finalize', 'merge-core-persist'] }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(17) reject a third / extra consumer', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), allowed_consumers: ['merge-core-persist', 'finalize', 'ranker'] }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(18) reject duplicate consumer', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), allowed_consumers: ['merge-core-persist', 'merge-core-persist'] }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(19) reject missing (singular) consumer array', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), allowed_consumers: ['merge-core-persist'] }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(20) reject a generic-role member', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), allowed_consumers: ['consumer', 'finalize'] }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(21) reject re-introduced superseded expected_consumer field', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), expected_consumer: 'merge-core-persist' }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(22) reject archive_sha256 that is a multipart ETag (ETag != SHA-256)', () => {
  assert.equal(isSha256Hex('abc123-50'), false);
  assert.equal(isSha256Hex('d'.repeat(64)), true);
  rejectsSync(() => validateManifest({ ...validManifest(), archive_sha256: 'abc123-50' }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(23) reject non-int / non-positive archive_bytes', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), archive_bytes: 0 }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
  rejectsSync(() => validateManifest({ ...validManifest(), archive_bytes: 1.5 }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(24) reject wrong schema_version', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), schema_version: 2 }, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(25) identity mismatch: wrong run id', () => {
  rejectsSync(() => validateManifest(validManifest(), ident({ runId: 'run-999' })), 'HANDOFF_IDENTITY_MISMATCH');
});
test('(26) identity mismatch: wrong attempt (prior-attempt manifest rejected)', () => {
  rejectsSync(() => validateManifest(validManifest(ident({ runAttempt: '1' })), ident({ runAttempt: '2' })), 'HANDOFF_IDENTITY_MISMATCH');
});
test('(27) identity mismatch: wrong cycle (cross-cycle rejected)', () => {
  rejectsSync(() => validateManifest(validManifest(ident({ cycleId: 'proc-OLD' })), ident({ cycleId: 'proc-100' })), 'HANDOFF_IDENTITY_MISMATCH');
});
test('(28) identity mismatch: wrong producer sha', () => {
  rejectsSync(() => validateManifest(validManifest(), ident({ producerMainSha: 'f'.repeat(40) })), 'HANDOFF_IDENTITY_MISMATCH');
});
test('(29) reject archive_key that does not match the attempt prefix', () => {
  rejectsSync(() => validateManifest({ ...validManifest(), archive_key: 'internal-handoff/aggregate/x/y/z/w/handoff.tar.zst' }, ident()), 'HANDOFF_IDENTITY_MISMATCH');
});
test('(30) inventory_sha256 is a non-circular hash over sorted payload inventory', () => {
  const a = inventorySha256(goodInventory());
  const b = inventorySha256([...goodInventory()].reverse());
  assert.equal(a, b, 'order-independent (sorted)');
  assert.ok(isSha256Hex(a));
  assert.notEqual(a, validManifest().archive_sha256, 'not a self/archive hash');
});

// ==========================================================================
// C. ARCHIVE LOCATION + EXTRACTION SAFETY (§D / §J steps 10-13)
// ==========================================================================
test('(31) archive inside a payload root is rejected (no self-recursion)', () => {
  rejectsSync(() => assertArchiveOutsidePayloadRoots('/ws/output/handoff.tar.zst', '/ws'), 'ARCHIVE_INSIDE_PAYLOAD_ROOT');
  rejectsSync(() => assertArchiveOutsidePayloadRoots('/ws/cache/h.zst', '/ws'), 'ARCHIVE_INSIDE_PAYLOAD_ROOT');
});
test('(32) archive outside payload roots is accepted', () => {
  assert.doesNotThrow(() => assertArchiveOutsidePayloadRoots('/rt/handoff/handoff.tar.zst', '/ws'));
});
test('(33) reject absolute member', () => {
  rejectsSync(() => validateArchiveEntries([{ name: '/etc/passwd', type: 'file' }]), 'HANDOFF_UNSAFE_ARCHIVE');
});
test('(34) reject ".." traversal member', () => {
  rejectsSync(() => validateArchiveEntries([{ name: 'output/../../evil', type: 'file' }]), 'HANDOFF_UNSAFE_ARCHIVE');
});
test('(35) reject symlink with absolute target', () => {
  rejectsSync(() => validateArchiveEntries([{ name: 'output/link', type: 'symlink', linkTarget: '/etc/shadow' }]), 'HANDOFF_UNSAFE_ARCHIVE');
});
test('(36) reject symlink whose relative target escapes the root', () => {
  rejectsSync(() => validateArchiveEntries([{ name: 'output/link', type: 'symlink', linkTarget: '../../../etc' }]), 'HANDOFF_UNSAFE_ARCHIVE');
});
test('(37) reject hardlink escape', () => {
  rejectsSync(() => validateArchiveEntries([{ name: 'output/h', type: 'hardlink', linkTarget: '../../secret' }]), 'HANDOFF_UNSAFE_ARCHIVE');
});
test('(38) accept a clean in-tree entry set', () => { assert.ok(validateArchiveEntries(goodEntries())); });
test('(39) required-roots present passes for a complete archive', () => { assert.ok(assertRequiredRootsPresent(goodEntries())); });
test('(40) missing payload root in archive is rejected', () => {
  const e = goodEntries().filter((x) => !x.name.startsWith('artifacts'));
  rejectsSync(() => assertRequiredRootsPresent(e), 'HANDOFF_MISSING_ROOT');
});

// ==========================================================================
// D. PRODUCER (§G / §F) — success, disk, roots, upload, manifest-last, reverify
// ==========================================================================
test('(41) producer success establishes archive + manifest + returns identity', async () => {
  const w = makeWorld();
  const res = await seedValidHandoff(w, ident());
  assert.equal(res.ok, true);
  assert.ok(w.r2.objects.has(archiveKeyFor(ident())));
  assert.ok(w.r2.objects.has(manifestKeyFor(ident())));
  assert.ok(isSha256Hex(res.archiveSha256));
});
test('(42) producer writes the manifest LAST (upload precedes manifest put)', async () => {
  const w = makeWorld();
  await seedValidHandoff(w, ident());
  const upIdx = w.r2.opLog.findIndex(([o]) => o === 'uploadFile');
  const mIdx = w.r2.opLog.findIndex(([o, k]) => o === 'putObject' && k.endsWith(MANIFEST_BASENAME));
  assert.ok(upIdx >= 0 && mIdx >= 0 && upIdx < mIdx, `upload(${upIdx}) must precede manifest(${mIdx})`);
});
test('(43) producer verifies upload via HeadObject byte-count (not ETag as sha)', async () => {
  const w = makeWorld();
  await seedValidHandoff(w, ident());
  assert.ok(w.r2.opLog.some(([o]) => o === 'headObject'));
  const m = JSON.parse(w.r2.objects.get(manifestKeyFor(ident())).body.toString());
  assert.ok(isSha256Hex(m.archive_sha256)); // sha, never the multipart etag
});
test('(44) producer re-fetches + validates the manifest before green', async () => {
  const w = makeWorld();
  await seedValidHandoff(w, ident());
  const reads = w.r2.opLog.filter(([o, k]) => o === 'getObjectBuffer' && k.endsWith(MANIFEST_BASENAME));
  assert.ok(reads.length >= 1);
});
test('(45) disk preflight failure => COMPUTE RED, no build, no upload', async () => {
  const w = makeWorld({ free: 10, logicalBytes: 1000 });
  await rejects(() => seedValidHandoff(w, ident()), 'INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_ARCHIVE');
  assert.equal(w.state.buildCalled, false);
  assert.equal(w.r2.objects.size, 0);
});
test('(46) disk invariant is exactly logical + 8 GiB headroom', async () => {
  const logical = 1000;
  const wOk = makeWorld({ free: logical + DISK_HEADROOM_BYTES, logicalBytes: logical });
  await seedValidHandoff(wOk, ident()); // exactly enough passes
  const wBad = makeWorld({ free: logical + DISK_HEADROOM_BYTES - 1, logicalBytes: logical });
  await rejects(() => seedValidHandoff(wBad, ident()), 'INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_ARCHIVE');
});
test('(47) missing payload root => fatal, no upload', async () => {
  const w = makeWorld({ scanPayload: () => { throw new HandoffError('MISSING_PAYLOAD_ROOT', 'artifacts/'); } });
  await rejects(() => seedValidHandoff(w, ident()), 'MISSING_PAYLOAD_ROOT');
  assert.equal(w.r2.objects.size, 0);
});
test('(48) archive built inside output/ => rejected before upload', async () => {
  const w = makeWorld();
  await rejects(() => establishHandoff({ r2: w.r2, identity: ident(), workspaceDir: '/ws', archivePath: '/ws/output/handoff.tar.zst', deps: w.producerDeps, clock: w.clock }), 'ARCHIVE_INSIDE_PAYLOAD_ROOT');
  assert.equal(w.state.buildCalled, false);
});
test('(49) upload DENIED => throws, no manifest (never warning-only-green)', async () => {
  const w = makeWorld();
  w.r2.faults.uploadFile = new HandoffError('HANDOFF_UPLOAD_FAILED', 'denied');
  await rejects(() => seedValidHandoff(w, ident()), 'HANDOFF_UPLOAD_FAILED');
  assert.ok(!w.r2.objects.has(manifestKeyFor(ident())));
});
test('(50) upload INTERRUPTED after partial => throws, no manifest', async () => {
  const w = makeWorld();
  w.r2.faults.uploadFileAfter = new HandoffError('HANDOFF_UPLOAD_FAILED', 'reset');
  await rejects(() => seedValidHandoff(w, ident()), 'HANDOFF_UPLOAD_FAILED');
  assert.ok(!w.r2.objects.has(manifestKeyFor(ident())));
});
test('(51) upload byte-count mismatch (corrupt) => verify fails, no manifest', async () => {
  const w = makeWorld();
  w.r2.corruptUpload = true;
  await rejects(() => seedValidHandoff(w, ident()), 'HANDOFF_UPLOAD_VERIFY_FAILED');
  assert.ok(!w.r2.objects.has(manifestKeyFor(ident())));
});
test('(52) manifest WRITE denied => COMPUTE RED', async () => {
  const w = makeWorld();
  w.r2.faults.putObject = new HandoffError('HANDOFF_MANIFEST_WRITE_FAILED', 'denied');
  await rejects(() => seedValidHandoff(w, ident()), 'HANDOFF_MANIFEST_WRITE_FAILED');
});
test('(53) manifest re-verify catches post-write drift => COMPUTE RED', async () => {
  const w = makeWorld();
  w.r2.manifestMutator = (buf) => { const m = JSON.parse(buf.toString()); m.archive_bytes = m.archive_bytes + 7; return Buffer.from(JSON.stringify(m)); };
  await rejects(() => seedValidHandoff(w, ident()), 'MANIFEST_REVERIFY_FAILED');
});
test('(82) producer re-verify runs full validateManifest on the refetched manifest', async () => {
  const w = makeWorld();
  // corrupt completion_state on read-back only: reverify must reject via validateManifest.
  w.r2.manifestMutator = (buf) => { const m = JSON.parse(buf.toString()); m.completion_state = 'partial'; return Buffer.from(JSON.stringify(m)); };
  await rejects(() => seedValidHandoff(w, ident()), 'HANDOFF_MANIFEST_INCOMPLETE');
});
test('(54) producer stores exactly one archive + one manifest (single-object)', async () => {
  const w = makeWorld();
  await seedValidHandoff(w, ident());
  assert.equal(w.r2.objects.size, 2);
});
test('(55) DETERMINISTIC_TAR_ARGS matches the proposal §Q.4 command exactly', () => {
  assert.deepEqual([...DETERMINISTIC_TAR_ARGS], [
    '--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0',
    '--numeric-owner', '--pax-option=delete=atime,delete=ctime', '--use-compress-program=zstd -T0 -3',
  ]);
});

// ==========================================================================
// E. DUAL CONSUMER (§J) — Persist AND Finalize each INDEPENDENTLY
// ==========================================================================
test('(56) persist consumer verifies + extracts a valid current-attempt handoff', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  const res = await consume(w, ident(), 'merge-core-persist');
  assert.equal(res.ok, true);
  assert.equal(w.state.extractCalled, true);
  assert.ok(res.treeDir.includes('merge-core-persist'));
});
test('(57) finalize consumer independently verifies the SAME manifest (no persist trust)', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  // finalize runs with zero knowledge of persist: same manifest, own staging.
  const res = await consume(w, ident(), 'finalize');
  assert.equal(res.ok, true);
  assert.ok(res.treeDir.includes('finalize'));
});
test('(58) the two consumers use DISTINCT staging paths (never shared)', () => {
  const sp = consumerStagingDir('/rt/base', ident(), 'merge-core-persist');
  const sf = consumerStagingDir('/rt/base', ident(), 'finalize');
  assert.notEqual(sp, sf);
  assert.ok(sp.includes('merge-core-persist') && sf.includes('finalize'));
});
test('(59) unauthorized consumer role => UNAUTHORIZED, zero writes', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  await rejects(() => consume(w, ident(), 'attacker'), 'UNAUTHORIZED_HANDOFF_CONSUMER');
  assert.equal(w.state.extractCalled, false);
});
test('(60) assertConsumerRoleKnown accepts only the two fixed roles', () => {
  assert.equal(assertConsumerRoleKnown('merge-core-persist'), 'merge-core-persist');
  assert.equal(assertConsumerRoleKnown('finalize'), 'finalize');
  rejectsSync(() => assertConsumerRoleKnown('ranker'), 'UNAUTHORIZED_HANDOFF_CONSUMER');
});
test('(61) missing manifest => MANIFEST_MISSING, zero writes (both roles)', async () => {
  for (const role of ALLOWED_CONSUMERS) {
    const w = makeWorld(); // nothing seeded
    await rejects(() => consume(w, ident(), role), 'HANDOFF_MANIFEST_MISSING');
    assert.equal(w.state.extractCalled, false);
  }
});
test('(62) malformed (non-JSON) manifest => MALFORMED, zero writes', async () => {
  const w = makeWorld();
  w.r2.objects.set(manifestKeyFor(ident()), { body: Buffer.from('{not-json') });
  await rejects(() => consume(w, ident(), 'finalize'), 'HANDOFF_MANIFEST_MALFORMED');
  assert.equal(w.state.extractCalled, false);
});
test('(63) incomplete manifest => INCOMPLETE, zero writes', async () => {
  const w = makeWorld();
  w.r2.objects.set(manifestKeyFor(ident()), { body: Buffer.from(JSON.stringify({ ...validManifest(), completion_state: 'partial' })) });
  await rejects(() => consume(w, ident(), 'merge-core-persist'), 'HANDOFF_MANIFEST_INCOMPLETE');
  assert.equal(w.state.extractCalled, false);
});
test('(64) wrong-run manifest at this key => IDENTITY_MISMATCH, zero writes', async () => {
  const w = makeWorld();
  w.r2.objects.set(manifestKeyFor(ident()), { body: Buffer.from(JSON.stringify(validManifest(ident({ runId: 'run-999' })))) });
  await rejects(() => consume(w, ident(), 'finalize'), 'HANDOFF_IDENTITY_MISMATCH');
  assert.equal(w.state.extractCalled, false);
});
test('(65) prior-attempt manifest => IDENTITY_MISMATCH, zero writes', async () => {
  const w = makeWorld();
  w.r2.objects.set(manifestKeyFor(ident()), { body: Buffer.from(JSON.stringify(validManifest(ident({ runAttempt: '1' })))) });
  await rejects(() => consume(w, ident({ runAttempt: '2' }), 'finalize'), 'HANDOFF_MANIFEST_MISSING');
  assert.equal(w.state.extractCalled, false);
});
test('(66) cross-cycle manifest => IDENTITY_MISMATCH, zero writes', async () => {
  const w = makeWorld();
  w.r2.objects.set(manifestKeyFor(ident()), { body: Buffer.from(JSON.stringify(validManifest(ident({ cycleId: 'proc-OLD' })))) });
  await rejects(() => consume(w, ident(), 'merge-core-persist'), 'HANDOFF_IDENTITY_MISMATCH');
  assert.equal(w.state.extractCalled, false);
});
test('(67) wrong producer sha manifest => IDENTITY_MISMATCH, zero writes', async () => {
  const w = makeWorld();
  w.r2.objects.set(manifestKeyFor(ident()), { body: Buffer.from(JSON.stringify(validManifest(ident({ producerMainSha: 'c'.repeat(40) })))) });
  await rejects(() => consume(w, ident(), 'finalize'), 'HANDOFF_IDENTITY_MISMATCH');
  assert.equal(w.state.extractCalled, false);
});
test('(68) archive object missing (manifest present) => ARCHIVE_MISSING, zero writes', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  w.r2.objects.delete(archiveKeyFor(ident()));
  await rejects(() => consume(w, ident(), 'merge-core-persist'), 'HANDOFF_ARCHIVE_MISSING');
  assert.equal(w.state.extractCalled, false);
});
test('(69) byte-count mismatch on download => BYTE_MISMATCH, zero writes', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  const key = manifestKeyFor(ident());
  const m = JSON.parse(w.r2.objects.get(key).body.toString()); m.archive_bytes = m.archive_bytes + 1;
  w.r2.objects.set(key, { body: Buffer.from(JSON.stringify(m)) });
  await rejects(() => consume(w, ident(), 'finalize'), 'HANDOFF_BYTE_MISMATCH');
  assert.equal(w.state.extractCalled, false);
});
test('(70) sha mismatch on download => SHA_MISMATCH, zero writes', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  const key = manifestKeyFor(ident());
  const m = JSON.parse(w.r2.objects.get(key).body.toString()); m.archive_sha256 = 'e'.repeat(64);
  w.r2.objects.set(key, { body: Buffer.from(JSON.stringify(m)) });
  await rejects(() => consume(w, ident(), 'merge-core-persist'), 'HANDOFF_SHA_MISMATCH');
  assert.equal(w.state.extractCalled, false);
});
test('(71) unsafe archive entries (traversal) => UNSAFE, zero writes', async () => {
  const w = makeWorld({ entries: [{ name: '../escape', type: 'file' }] });
  await seedValidHandoff(w, ident());
  await rejects(() => consume(w, ident(), 'finalize'), 'HANDOFF_UNSAFE_ARCHIVE');
  assert.equal(w.state.extractCalled, false);
});
test('(72) archive missing a required root => MISSING_ROOT, zero writes', async () => {
  const w = makeWorld({ entries: goodEntries().filter((e) => !e.name.startsWith('cache')) });
  await seedValidHandoff(w, ident());
  await rejects(() => consume(w, ident(), 'merge-core-persist'), 'HANDOFF_MISSING_ROOT');
  assert.equal(w.state.extractCalled, false);
});
test('(73) safety + roots are validated BEFORE extract (exposure only post-verify)', async () => {
  const w = makeWorld({ entries: [{ name: '/abs', type: 'file' }] });
  await seedValidHandoff(w, ident());
  await rejects(() => consume(w, ident(), 'finalize'), 'HANDOFF_UNSAFE_ARCHIVE');
  assert.equal(w.state.extractCalled, false, 'extract must never run on an unsafe archive');
});
test('(74) consumer has NO local/cache fallback — R2 manifest is mandatory', async () => {
  const w = makeWorld(); // archive-less + manifest-less; a "local cache" cannot substitute
  await rejects(() => consume(w, ident(), 'merge-core-persist'), 'HANDOFF_MANIFEST_MISSING');
});
test('(75) finalize does not consult any persist output flag / boolean param', () => {
  // consumeHandoff signature accepts only r2/identity/consumerRole/stagingRoot/deps/clock/logger:
  // there is no "peerConclusion"/"persistOk"/"outputFlag" input to trust.
  const src = consumeHandoff.toString();
  const sig = src.slice(0, src.indexOf('{', src.indexOf('{') + 1)); // the options-destructure block
  assert.ok(!/persist(Ok|Conclusion|Flag)|peerConclusion|outputFlag|inheritedBool/i.test(sig), 'no peer-trust parameter');
  // The accepted options are exactly the injectable contract inputs — nothing that
  // could carry a Persist verdict into Finalize.
  assert.ok(/r2, identity, consumerRole, stagingRoot/.test(sig));
});

// ==========================================================================
// F. LIFETIME (§M) + RECOVERY GUIDANCE (§G)
// ==========================================================================
test('(76) neither consumer deletes any R2 object (no in-workflow deletion)', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  const before = w.r2.objects.size;
  await consume(w, ident(), 'merge-core-persist');
  await consume(w, ident(), 'finalize');
  assert.equal(w.r2.objects.size, before, 'objects untouched');
  assert.ok(!w.r2.opLog.some(([o]) => /delete/i.test(o)), 'no delete op issued');
});
test('(77) a valid handoff unlocks BOTH consumers on the same objects', async () => {
  const w = makeWorld(); await seedValidHandoff(w, ident());
  assert.equal((await consume(w, ident(), 'merge-core-persist')).ok, true);
  assert.equal((await consume(w, ident(), 'finalize')).ok, true);
});
test('(78) recovery guidance: producer GREEN but authority absent => RERUN_ALL', () => {
  const g = producerGraphRecoveryGuidance({ producerConclusion: 'success' });
  assert.equal(g.verdict, 'RERUN_ALL');
  assert.ok(!g.message.includes(FORBIDDEN_RERUN_PHRASE));
});
test('(79) recovery guidance: missing producer in failed set => FAILED_JOBS_RERUN', () => {
  const g = producerGraphRecoveryGuidance({ producerConclusion: 'failure', missingProducersInFailedSet: true });
  assert.equal(g.verdict, 'FAILED_JOBS_RERUN');
});
test('(80) recovery guidance: rerun limit consumed => NO_RERUN', () => {
  assert.equal(producerGraphRecoveryGuidance({ rerunLimitConsumed: true }).verdict, 'NO_RERUN');
});
test('(81) recovery guidance NEVER emits the generic "Re-run failed jobs" phrase', () => {
  for (const args of [{ producerConclusion: 'success' }, { producerConclusion: 'failure', missingProducersInFailedSet: true }, { rerunLimitConsumed: true }, {}]) {
    assert.ok(!producerGraphRecoveryGuidance(args).message.includes(FORBIDDEN_RERUN_PHRASE));
  }
});

// ==========================================================================
// G. CACHE-REMOVAL / UNRELATED-CACHE / CREDENTIALS — workflow structural (§K)
//    (validated against the post-Commit-B factory-aggregate.yml)
// ==========================================================================
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const WF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.github/workflows/factory-aggregate.yml');
const wf = () => fs.readFileSync(WF, 'utf-8');
function occurrences(hay, needle) { return hay.split(needle).length - 1; }

test('WF-1 the intra-cycle -core GHA cache key is fully REMOVED (no save/restore)', () => {
  assert.equal(occurrences(wf(), 'intra-cycle-${{ github.run_id }}-core'), 0);
});
test('WF-2 unrelated intra-cycle caches are UNCHANGED (satellite/search/rankings/trending/relations)', () => {
  const t = wf();
  for (const k of ['-satellite', '-search', '-rankings', '-trending', '-relations']) {
    assert.ok(t.includes('intra-cycle-${{ github.run_id }}' + k), `missing unrelated cache ${k}`);
  }
});
test('WF-3 unrelated caches (global-registry/fni-history/daily-accum/checksums/cycle-output/shards/harvest) UNCHANGED', () => {
  const t = wf();
  for (const k of ['global-registry-${{ github.run_id }}', 'fni-history-${{ github.run_id }}', 'daily-accum-${{ github.run_id }}', 'checksums-${{ github.run_id }}', 'cycle-${{ github.run_id }}-output', '-shards', '-harvest']) {
    assert.ok(t.includes(k), `missing unrelated cache ${k}`);
  }
});
test('WF-4 producer establish + both consumer roles are wired', () => {
  const t = wf();
  assert.equal(occurrences(t, 'handoff-establish'), 1);
  assert.ok(t.includes('handoff-consume --role=merge-core-persist'));
  assert.ok(t.includes('handoff-consume --role=finalize'));
});
test('WF-5 every new handoff step projects R2 creds + CYCLE_ID at STEP level', () => {
  const t = wf();
  // each of the 3 handoff invocations must be preceded (in its step env) by the
  // 4 credential keys + CYCLE_ID + PRODUCER_MAIN_SHA. Assert the composite counts.
  assert.ok(occurrences(t, 'CYCLE_ID: ${{ needs.check-upstream.outputs.process-id }}') >= 3);
  assert.ok(occurrences(t, 'PRODUCER_MAIN_SHA: ${{ github.sha }}') >= 3);
  // R2 creds still projected (composite factory-setup cannot inject secrets).
  assert.ok(occurrences(t, 'R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}') >= 3);
});
test('WF-6 no in-workflow deletion of the internal-handoff prefix', () => {
  const t = wf();
  assert.ok(!/delete-prefix\s+internal-handoff/.test(t));
  assert.ok(!t.includes('internal-handoff'), 'prefix is built in code, never hardcoded/mutated in YAML');
});
test('WF-7 no mutable "latest" handoff pointer + old defensive core cache-hit guard removed', () => {
  const t = wf();
  assert.ok(!t.includes('Cache miss on intra-cycle-${{ github.run_id }}-core'));
  assert.ok(!t.includes('Restore Intra-Cycle Core (UNPRUNED from compute)'));
});

// ==========================================================================
// H. REAL-FS PREFLIGHT ORDERING (D-217 §G) — the mkdir-before-statfs regression.
//    These tests drive the PRODUCTION establishHandoff with REAL Node fs deps
//    (real ensureDir/realpathDir/freeBytes/scanPayload/hashFile) against a
//    process-local temp dir. R2 is a local in-memory stub that reads the REAL
//    archive file — NO network, NO real tar/zstd (buildArchive writes a plain
//    file). Each world is torn down in finally (§G.9 cleanup).
// ==========================================================================

// A local R2 stub that persists REAL on-disk archive bytes (no network).
function realFsR2() {
  const objects = new Map(); const opLog = [];
  return {
    objects, opLog,
    async uploadFile(key, filePath) { opLog.push(['uploadFile', key]); objects.set(key, fs.readFileSync(filePath)); },
    async putObject(key, body) { opLog.push(['putObject', key]); objects.set(key, Buffer.from(body)); },
    async headObject(key) { opLog.push(['headObject', key]); const b = objects.get(key); if (!b) throw new HandoffError('R2_OBJECT_NOT_FOUND', 'nf'); return { size: b.length }; },
    async getObjectBuffer(key) { opLog.push(['getObjectBuffer', key]); const b = objects.get(key); if (!b) throw new HandoffError('R2_OBJECT_NOT_FOUND', 'nf'); return Buffer.from(b); },
  };
}

// Build a real, isolated temp world. archiveParent does NOT pre-exist.
function realFsWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aggh-preflight-'));
  const workspaceDir = path.join(root, 'ws');
  for (const r of PAYLOAD_ROOTS) {
    fs.mkdirSync(path.join(workspaceDir, r), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, r, 'f.bin'), Buffer.from('x'.repeat(16)));
  }
  const handoffTempRoot = path.join(root, 'rt');
  fs.mkdirSync(handoffTempRoot, { recursive: true });
  // Mirrors the production handoffTempBase layout under RUNNER_TEMP.
  const archiveParent = path.join(handoffTempRoot, 'free2aitools-aggregate-handoff', 'run-200', '1');
  const archivePath = path.join(archiveParent, ARCHIVE_BASENAME);
  const r2 = realFsR2();
  // Real fs deps for the disk-critical operations; buildArchive writes a real
  // file (no tar/zstd) so real hashFile + the R2 stub can read it.
  const baseDeps = {
    ...productionProducerDeps(),
    buildArchive: (ap) => { fs.mkdirSync(path.dirname(ap), { recursive: true }); fs.writeFileSync(ap, Buffer.from('REAL-FS-ARCHIVE-BODY')); },
  };
  return {
    root, workspaceDir, handoffTempRoot, archiveParent, archivePath, r2, baseDeps,
    run: (over = {}) => establishHandoff({
      r2, identity: ident(), workflowIdentity: 'wf', workspaceDir,
      archivePath, handoffTempRoot, deps: baseDeps, ...over,
    }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('(83) REAL_FS_NONEXISTENT_PARENT: producer creates the nested parent before statfs (no ENOENT)', async () => {
  const w = realFsWorld();
  try {
    assert.equal(fs.existsSync(w.archiveParent), false, 'precondition: parent must not pre-exist');
    const res = await w.run();
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(w.archiveParent), true, 'parent was created (real mkdir before real statfs)');
  } finally { w.cleanup(); }
});

test('(84) ORDER_ASSERTION: freeBytes is only ever probed on an existing directory', async () => {
  const w = realFsWorld();
  try {
    const deps = {
      ...w.baseDeps,
      freeBytes: (d) => {
        assert.ok(fs.existsSync(d) && fs.statSync(d).isDirectory(), `freeBytes probed a non-existent/non-dir path: ${d}`);
        return w.baseDeps.freeBytes(d);
      },
    };
    const res = await w.run({ deps });
    assert.equal(res.ok, true);
  } finally { w.cleanup(); }
});

test('(85) ENOENT_REGRESSION: pre-fix ordering (no mkdir) reproduces statfs ENOENT; fixed ordering succeeds', async () => {
  const w = realFsWorld();
  try {
    // Reproduce the exact pre-fix condition: the mkdir step is a no-op, so the
    // REAL statfsSync runs against the non-existent parent -> raw ENOENT.
    const broken = { ...w.baseDeps, ensureDir: () => {}, realpathDir: (d) => d };
    await assert.rejects(() => w.run({ deps: broken }), (e) => { assert.equal(e.code, 'ENOENT', `expected ENOENT got ${e.code}`); return true; });
    assert.equal(fs.existsSync(w.archiveParent), false, 'broken run never created the parent');
    // Fixed ordering (production deps create the parent first) -> success.
    const res = await w.run();
    assert.equal(res.ok, true);
  } finally { w.cleanup(); }
});

test('(86) DISK_GATE_PRESERVED: after mkdir, insufficient free bytes still fails closed', async () => {
  const w = realFsWorld();
  try {
    const deps = { ...w.baseDeps, freeBytes: () => 10 }; // real ensureDir, tiny free
    await rejects(() => w.run({ deps }), 'INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_ARCHIVE');
    assert.equal(fs.existsSync(w.archiveParent), true, 'parent is created before the disk gate');
    assert.equal(w.r2.opLog.length, 0, 'no R2 op on a disk-preflight failure');
  } finally { w.cleanup(); }
});

test('(87) NO_ARCHIVE_ON_DISK_FAILURE: a disk-preflight failure builds no archive and calls no R2', async () => {
  const w = realFsWorld();
  try {
    let built = false;
    const deps = { ...w.baseDeps, freeBytes: () => 10, buildArchive: (ap) => { built = true; fs.writeFileSync(ap, Buffer.from('x')); } };
    await rejects(() => w.run({ deps }), 'INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_ARCHIVE');
    assert.equal(built, false, 'buildArchive must not run');
    assert.equal(fs.existsSync(w.archivePath), false, 'no archive file on disk');
    assert.equal(w.r2.opLog.length, 0, 'no R2 client invocation');
  } finally { w.cleanup(); }
});

test('(88) NO_MANIFEST_ON_DISK_FAILURE: a disk-preflight failure writes no manifest', async () => {
  const w = realFsWorld();
  try {
    const deps = { ...w.baseDeps, freeBytes: () => 10 };
    await rejects(() => w.run({ deps }), 'INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_ARCHIVE');
    assert.ok(!w.r2.opLog.some(([o]) => o === 'putObject'), 'no manifest putObject');
    assert.equal(w.r2.objects.has(manifestKeyFor(ident())), false, 'no manifest object');
  } finally { w.cleanup(); }
});

test('(89) PATH_CONFINEMENT: an archive parent escaping the RUNNER_TEMP handoff root is rejected before mkdir', async () => {
  const w = realFsWorld();
  try {
    const escapeParent = path.join(w.root, 'outside-root');
    const escapeArchive = path.join(escapeParent, ARCHIVE_BASENAME);
    let created = false;
    const deps = { ...w.baseDeps, ensureDir: (d) => { created = true; fs.mkdirSync(d, { recursive: true }); } };
    await rejects(() => w.run({ deps, archivePath: escapeArchive }), 'HANDOFF_ARCHIVE_PARENT_ESCAPE');
    assert.equal(created, false, 'ensureDir must not run for an escaping parent');
    assert.equal(fs.existsSync(escapeParent), false, 'no directory created outside the handoff root');
    // The pure confinement helper agrees on the classification.
    assert.throws(() => assertArchiveParentConfined(escapeParent, w.handoffTempRoot), (e) => e.code === 'HANDOFF_ARCHIVE_PARENT_ESCAPE');
  } finally { w.cleanup(); }
  // §F.4 defense: the post-mkdir realpath guard must reject a parent that resolves
  // to a NON-directory (this is the real-fs stand-in for the symlink-escape guard,
  // which cannot be created on this host). A stub ensureDir preserves the planted
  // file so the PRODUCTION realpathDir directory-assertion is the code under test.
  const w2 = realFsWorld();
  try {
    fs.mkdirSync(path.dirname(w2.archiveParent), { recursive: true });
    fs.writeFileSync(w2.archiveParent, Buffer.from('not-a-dir'));
    await rejects(() => w2.run({ deps: { ...w2.baseDeps, ensureDir: () => {} } }), 'HANDOFF_ARCHIVE_PARENT_NOT_DIR');
  } finally { w2.cleanup(); }
});

test('(90) EXISTING_PARENT: a pre-existing archive parent is handled idempotently', async () => {
  const w = realFsWorld();
  try {
    fs.mkdirSync(w.archiveParent, { recursive: true }); // pre-exists
    const res = await w.run();
    assert.equal(res.ok, true);
    assert.ok(w.r2.objects.has(manifestKeyFor(ident())));
  } finally { w.cleanup(); }
});

test('(91) CLEANUP: real temp fs state is removed after the test', () => {
  const w = realFsWorld();
  const root = w.root;
  assert.ok(fs.existsSync(root));
  w.cleanup();
  assert.equal(fs.existsSync(root), false, 'temp world is torn down');
});
