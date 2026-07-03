// scripts/factory/harvest-authoritative-handoff.test.mjs
//
// Hermetic node:test suite for the authoritative R2 HARVEST source-authority
// handoff (Founder D-2026-0703-236 / D-237). NO real network, NO real tar, NO
// real disk: the R2 client, data scanner, disk probe, archive builder, hasher,
// archive lister, extractor, GHA probe and workspace-union are ALL injected fakes
// that drive the PRODUCTION code paths exported from
// harvest-authoritative-handoff.mjs. Node built-ins only.
//
// Covers proposal §12: 7 positive + 33 negative + the D-236 §L 10 + D-237 §K 10
// anti-vacuity mutations. Every reject asserts the EXACT code AND (for producer
// establish) empty R2 side-effects; manifest-LAST is proven via opLog ordering.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';

import {
  SCHEMA_VERSION, CARRIER_TYPE, HANDOFF_PREFIX_ROOT, MANIFEST_BASENAME, COMPLETION_STATE,
  SOURCE_ROLES, ROLE_MEMBERSHIP, ALLOWED_CONSUMERS, FORBIDDEN_MANIFEST_FIELDS,
  DETERMINISTIC_TAR_ARGS, MERGE_VERIFIED_TOKEN, HarvestHandoffError, isSha256Hex, isGitSha,
  assertIdentity, archiveBasenameFor, buildHandoffPrefix, archiveKeyFor, manifestKeyFor,
  ownedSourcesFor, requiredMemberPaths, authorizedMemberPaths, inventorySha256, buildRoleSnapshot,
  buildManifest, validateManifest, assertArchiveOutsidePayloadRoots, validateArchiveEntries,
  assertDataRootPresent, archiveInventoryFromEntries, assertManifestsConsistent,
  establishHarvestHandoff, resolveCurrentRun, resolveExactTuple, resolveAndConsumeHarvest,
  establishIdentityFromEnv,
} from './harvest-authoritative-handoff.mjs';

// ISOLATION: import the CORE + SATELLITE frozen arrays READ-ONLY (never modify).
import { ALLOWED_CONSUMERS as CORE_ALLOWED, HANDOFF_PREFIX_ROOT as CORE_ROOT } from './aggregate-handoff.mjs';
import { HANDOFF_PREFIX_ROOT as SAT_ROOT } from './satellite-registry-handoff.mjs';

// --------------------------------------------------------------------------
// Fixtures + fake harness
// --------------------------------------------------------------------------
const SHA = 'a'.repeat(40);
function ident(over = {}) { return { runId: 'run-200', runAttempt: '2', sourceRole: 'huggingface', producerMainSha: SHA, ...over }; }
function hashBuf(buf) { if (!buf) throw new Error('hashFile: missing local buffer'); return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }; }
function mkFile(p) { return { path: p, bytes: 1000 + p.length, sha256: crypto.createHash('sha256').update('C:' + p).digest('hex') }; }
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// Deterministic authorized-actual member set for a role (all required present;
// ecosystem also carries one optional 'ollama' + every member's state sidecar).
function roleInventory(role) {
  const masters = { huggingface: ['huggingface'], github: ['github'], academic: ['arxiv', 'huggingface-papers', 'huggingface-datasets'], ecosystem: ['semanticscholar', 'ollama'] }[role];
  const files = [];
  for (const s of masters) { files.push(mkFile(`data/${s}_master.ndjson`)); files.push(mkFile(`data/state/harvest-state-${s}.json`)); }
  return files.sort(byPath);
}
function entriesFromInv(inv) {
  return [{ name: 'data/', type: 'dir', size: 0, linkTarget: '' }, ...inv.map((e) => ({ name: e.path, type: 'file', size: e.bytes, linkTarget: '' }))];
}

class FakeR2 {
  constructor(vfs) { this.vfs = vfs; this.objects = new Map(); this.opLog = []; this.faults = {}; this.corruptUpload = false; }
  _notFound() { return new HarvestHandoffError('R2_OBJECT_NOT_FOUND', 'nf'); }
  async uploadFile(key, filePath) {
    this.opLog.push(['uploadFile', key]);
    if (this.faults.uploadFile) throw this.faults.uploadFile;
    let body = this.vfs.get(path.resolve(filePath)); if (!body) throw new Error('uploadFile: missing local ' + filePath);
    if (this.corruptUpload) body = body.subarray(0, body.length - 1);
    this.objects.set(key, { body: Buffer.from(body) });
  }
  async putObject(key, body) { this.opLog.push(['putObject', key]); if (this.faults.putObject) throw this.faults.putObject; this.objects.set(key, { body: Buffer.from(body) }); }
  async headObject(key) { this.opLog.push(['headObject', key]); const o = this.objects.get(key); if (!o) throw this._notFound(); return { size: o.body.length, etag: '"' + crypto.createHash('md5').update(o.body).digest('hex') + '-3"' }; }
  async getObjectBuffer(key) { this.opLog.push(['getObjectBuffer', key]); const o = this.objects.get(key); if (!o) throw this._notFound(); return Buffer.from(o.body); }
  async getObjectToFile(key, dest) { this.opLog.push(['getObjectToFile', key]); const o = this.objects.get(key); if (!o) throw this._notFound(); this.vfs.set(path.resolve(dest), Buffer.from(o.body)); }
}

function makeWorld() {
  const vfs = new Map();
  const r2 = new FakeR2(vfs);
  const clock = { now: () => 1_700_000_000_000 };
  // Producer config (mutated by establish() before each call).
  const P = { scanFiles: null, scanSequence: null, scanCount: 0, entriesOverride: null, buildCalled: false, free: 500 * 2 ** 30 };
  const producerDeps = {
    scanData: () => { const i = P.scanCount++; if (P.scanSequence) return P.scanSequence[Math.min(i, P.scanSequence.length - 1)]; return P.scanFiles; },
    ensureDir: () => { P.ensureDirCalled = true; },
    realpathDir: (d) => d,
    freeBytes: () => P.free,
    buildArchive: (ap, cwd, memberPaths) => {
      P.buildCalled = true;
      const map = new Map((P.scanFiles || []).map((f) => [f.path, f]));
      const inv = memberPaths.map((p) => { const f = map.get(p); return { path: p, bytes: f.bytes, sha256: f.sha256 }; });
      vfs.set(path.resolve(ap), Buffer.from(JSON.stringify(inv)));
    },
    hashFile: (p) => hashBuf(vfs.get(path.resolve(p))),
    listArchiveEntries: (ap) => (P.entriesOverride ? P.entriesOverride() : entriesFromInv(JSON.parse(vfs.get(path.resolve(ap)).toString()))),
  };
  // Consumer config.
  const C = { ghaStatus: 'GHA_MISS', free: 500 * 2 ** 30, extractCalled: false, extractedByTree: {}, scanExtractedOverride: null, entriesOverride: null, unioned: [], cleaned: [] };
  const consumerDeps = {
    getManifestBuffer: async (r2c, key) => r2c.getObjectBuffer(key),
    freeBytes: () => C.free,
    prepareCleanStaging: (sd, td) => { C.extractCalled = false; C.lastStaging = sd; C.lastTree = td; },
    download: async (r2c, key, dest) => { await r2c.getObjectToFile(key, dest); },
    hashFile: (p) => hashBuf(vfs.get(path.resolve(p))),
    listArchiveEntries: (ap) => (C.entriesOverride ? C.entriesOverride() : entriesFromInv(JSON.parse(vfs.get(path.resolve(ap)).toString()))),
    extract: (ap, td) => { C.extractCalled = true; C.extractedByTree[path.resolve(td)] = JSON.parse(vfs.get(path.resolve(ap)).toString()); },
    scanExtracted: (td) => (C.scanExtractedOverride || C.extractedByTree[path.resolve(td)]),
    unionIntoWorkspace: (td, mp) => { C.unioned.push(...mp); },
    cleanup: (sd) => { C.cleaned.push(sd); },
    ghaProbe: () => C.ghaStatus,
  };
  return { vfs, r2, clock, P, C, producerDeps, consumerDeps };
}

function establish(world, over = {}) {
  const identity = over.identity || ident();
  world.P.scanFiles = over.scanFiles || roleInventory(identity.sourceRole);
  world.P.scanSequence = over.scanSequence || null;
  world.P.scanCount = 0;
  world.P.entriesOverride = over.entriesOverride || null;
  world.P.buildCalled = false;
  if (over.free != null) world.P.free = over.free;
  return establishHarvestHandoff({
    r2: world.r2, identity, workspaceDir: '/ws',
    archivePath: over.archivePath || `/tmp/h/${identity.sourceRole}.tar.zst`,
    handoffTempRoot: over.handoffTempRoot || '/tmp', deps: world.producerDeps, clock: world.clock,
  });
}
async function seedAttempt(world, runId, attempt, sha = SHA, roles = SOURCE_ROLES) {
  for (const role of roles) await establish(world, { identity: { runId, runAttempt: attempt, sourceRole: role, producerMainSha: sha } });
}
function consumeEnv(over = {}) { return { GITHUB_RUN_ID: 'run-200', GITHUB_RUN_ATTEMPT: '2', PRODUCER_MAIN_SHA: SHA, ...over }; }
function resolveConsume(world, env, overDeps = {}) {
  return resolveAndConsumeHarvest({ r2: world.r2, env, deps: { ...world.consumerDeps, ...overDeps }, workspaceDir: '/ws', stagingRoot: '/rt', logger: world.logger || console, ghaAccel: env.__ghaAccel !== false });
}
async function rejects(fn, code) { await assert.rejects(fn, (e) => { assert.ok(e instanceof HarvestHandoffError, `expected HarvestHandoffError got ${e}`); assert.equal(e.code, code, 'code'); return true; }); }
function rejectsSync(fn, code) { assert.throws(fn, (e) => { assert.ok(e instanceof HarvestHandoffError, `expected HarvestHandoffError got ${e}`); assert.equal(e.code, code); return true; }); }

// ==========================================================================
// A. CONSTANTS / IDENTITY / NAMESPACE / MEMBERSHIP + distinct-from core/satellite
// ==========================================================================
test('(A1) source-role closed set + allowed_consumers frozen', () => {
  assert.deepEqual([...SOURCE_ROLES], ['huggingface', 'github', 'academic', 'ecosystem']);
  assert.deepEqual([...ALLOWED_CONSUMERS], ['merge']);
  assert.equal(CARRIER_TYPE, 'harvest-source-authority');
});
test('(A2) namespace root is DISTINCT from core + satellite (zero collision)', () => {
  assert.equal(HANDOFF_PREFIX_ROOT, 'internal-handoff/harvest');
  assert.notEqual(HANDOFF_PREFIX_ROOT, CORE_ROOT);
  assert.notEqual(HANDOFF_PREFIX_ROOT, SAT_ROOT);
  assert.ok(buildHandoffPrefix(ident()).startsWith('internal-handoff/harvest/'));
});
test('(A3) prefix binds run/attempt/role — NO producer-sha path segment; rejects latest/traversal', () => {
  assert.equal(buildHandoffPrefix(ident()), 'internal-handoff/harvest/run-200/2/huggingface/');
  assert.equal(archiveKeyFor(ident()), 'internal-handoff/harvest/run-200/2/huggingface/huggingface.tar.zst');
  assert.equal(manifestKeyFor(ident()), 'internal-handoff/harvest/run-200/2/huggingface/' + MANIFEST_BASENAME);
  assert.ok(!buildHandoffPrefix(ident()).includes(SHA)); // producer sha is NOT a path segment
  rejectsSync(() => buildHandoffPrefix(ident({ runAttempt: 'latest' })), 'HANDOFF_IDENTITY_INVALID');
  rejectsSync(() => assertIdentity(ident({ runId: 'a/b' })), 'HANDOFF_IDENTITY_INVALID');
  rejectsSync(() => assertIdentity(ident({ sourceRole: 'bogus' })), 'HANDOFF_IDENTITY_INVALID');
});
test('(A4) archiveBasename is role-specific', () => {
  for (const r of SOURCE_ROLES) assert.equal(archiveBasenameFor(r), `${r}.tar.zst`);
});
test('(A5) frozen membership contract matches the grounded role->source mapping', () => {
  assert.deepEqual([...ROLE_MEMBERSHIP.huggingface.required], ['huggingface']);
  assert.deepEqual([...ROLE_MEMBERSHIP.github.required], ['github']);
  assert.deepEqual([...ROLE_MEMBERSHIP.academic.required], ['arxiv', 'huggingface-papers', 'huggingface-datasets']);
  assert.deepEqual([...ROLE_MEMBERSHIP.ecosystem.required], ['semanticscholar']);
  assert.deepEqual([...ROLE_MEMBERSHIP.ecosystem.optional], ['ollama', 'mcp', 'replicate', 'kaggle', 'civitai', 'openllm', 'benchmark', 'deepspec', 'agents']);
  for (const r of ['huggingface', 'github', 'academic']) assert.deepEqual([...ROLE_MEMBERSHIP[r].optional], []);
  assert.deepEqual(requiredMemberPaths('academic'), ['data/arxiv_master.ndjson', 'data/huggingface-datasets_master.ndjson', 'data/huggingface-papers_master.ndjson']);
});
test('(A6) establishIdentityFromEnv reads --role + GITHUB_* + PRODUCER_MAIN_SHA fallback', () => {
  const id = establishIdentityFromEnv({ GITHUB_RUN_ID: 'r', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: SHA }, ['--role=github']);
  assert.equal(id.sourceRole, 'github'); assert.equal(id.producerMainSha, SHA);
  rejectsSync(() => establishIdentityFromEnv({ GITHUB_RUN_ID: 'r', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: SHA }, ['--role=nope']), 'HANDOFF_IDENTITY_INVALID');
});

// ==========================================================================
// B. buildRoleSnapshot — membership acceptance, incidental exclusion, safety
// ==========================================================================
test('(B1) valid snapshot: authorized inventory + required subset + optional synthesis', () => {
  const s = buildRoleSnapshot('ecosystem', roleInventory('ecosystem'));
  assert.deepEqual(s.actualMembers, roleInventory('ecosystem').map((f) => f.path));
  assert.deepEqual(s.expectedRequiredMembers, ['data/semanticscholar_master.ndjson']);
  assert.equal(s.optionalMembers.length, 9);
  assert.equal(s.optionalMembers.find((o) => o.name === 'ollama').present, true);
  assert.equal(s.optionalMembers.find((o) => o.name === 'benchmark').present, false);
  assert.ok(isSha256Hex(s.inventorySha256));
});
test('(B2) required member missing => REQUIRED_MEMBER_MISSING', () => {
  const files = roleInventory('academic').filter((f) => f.path !== 'data/arxiv_master.ndjson');
  rejectsSync(() => buildRoleSnapshot('academic', files), 'REQUIRED_MEMBER_MISSING');
});
test('(B3) incidental benchmark_NNN.json + non-owned master EXCLUDED (not archived)', () => {
  const files = [...roleInventory('ecosystem'), mkFile('data/benchmark_042.json'), mkFile('data/github_master.ndjson')];
  const s = buildRoleSnapshot('ecosystem', files);
  assert.ok(!s.actualMembers.includes('data/benchmark_042.json'));
  assert.ok(!s.actualMembers.includes('data/github_master.ndjson'));
});
test('(B4) absolute + traversal source paths REJECTED', () => {
  rejectsSync(() => buildRoleSnapshot('github', [mkFile('/etc/passwd')]), 'SOURCE_ABSOLUTE_PATH');
  rejectsSync(() => buildRoleSnapshot('github', [mkFile('data/../evil')]), 'SOURCE_TRAVERSAL_PATH');
});
test('(B5) member with bad bytes/sha REJECTED', () => {
  rejectsSync(() => buildRoleSnapshot('github', [{ path: 'data/github_master.ndjson', bytes: -1, sha256: 'a'.repeat(64) }]), 'SOURCE_MEMBER_SIZE_INVALID');
  rejectsSync(() => buildRoleSnapshot('github', [{ path: 'data/github_master.ndjson', bytes: 5, sha256: 'zz' }]), 'SOURCE_MEMBER_SHA_INVALID');
});
test('(B6) inventory_sha256 order-independent + collision-resistant', () => {
  const inv = roleInventory('academic').map((e) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 }));
  assert.equal(inventorySha256(inv), inventorySha256([...inv].reverse()));
  const tampered = inv.map((e, i) => (i === 0 ? { ...e, sha256: 'f'.repeat(64) } : e));
  assert.notEqual(inventorySha256(inv), inventorySha256(tampered)); // sha bound, not size-only
});

// ==========================================================================
// C. MANIFEST SCHEMA + VALIDATION
// ==========================================================================
function validManifest(identity = ident(), over = {}) {
  const snap = buildRoleSnapshot(identity.sourceRole, roleInventory(identity.sourceRole));
  const m = buildManifest({ identity, snapshot: snap, archiveBytes: 100, archiveSha256: 'd'.repeat(64), createdAtUtc: '1970-01-01T00:00:00.000Z' });
  return { ...m, ...over };
}
test('(C1) buildManifest emits the full field set incl. membership evidence; no secrets', () => {
  const m = validManifest(ident({ sourceRole: 'ecosystem' }));
  assert.equal(m.schema_version, SCHEMA_VERSION);
  assert.equal(m.carrier_type, CARRIER_TYPE);
  assert.equal(m.source_role, 'ecosystem');
  assert.equal(m.producer_main_sha, SHA);
  assert.equal(m.completion_state, COMPLETION_STATE);
  assert.equal(m.entity_or_record_count, null);
  assert.deepEqual(m.allowed_consumers, ['merge']);
  assert.equal(m.optional_members.length, 9);
  assert.ok(Array.isArray(m.inventory) && m.inventory[0].sha256);
  assert.ok(!('expected_consumer' in m));
  assert.ok(!('cycle_id' in m)); // §2: no independent cycle_id field
  assert.deepEqual([...FORBIDDEN_MANIFEST_FIELDS], ['expected_consumer']);
  for (const k of Object.keys(m)) assert.ok(!/access|secret|token|password|cred/i.test(k), `leak key ${k}`);
});
test('(C2) valid manifest passes; producer-sha bound + unbound both OK', () => {
  assert.ok(validateManifest(validManifest(), ident()));
  assert.ok(validateManifest(validManifest(), { runId: 'run-200', runAttempt: '2', sourceRole: 'huggingface' })); // unbound sha (skip_harvest)
});
test('(C3) reject wrong carrier / completion / consumers', () => {
  rejectsSync(() => validateManifest(validManifest(ident(), { carrier_type: 'core' }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
  rejectsSync(() => validateManifest(validManifest(ident(), { completion_state: 'partial' }), ident()), 'HANDOFF_MANIFEST_INCOMPLETE');
  rejectsSync(() => validateManifest(validManifest(ident(), { allowed_consumers: ['merge', 'x'] }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
  rejectsSync(() => validateManifest(validManifest(ident(), { allowed_consumers: ['search-index'] }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(C4) identity mismatches (run/attempt/role/sha + archive_key)', () => {
  rejectsSync(() => validateManifest(validManifest(), ident({ runId: 'run-999' })), 'HANDOFF_IDENTITY_MISMATCH');
  rejectsSync(() => validateManifest(validManifest(ident({ runAttempt: '2' })), ident({ runAttempt: '3' })), 'HANDOFF_IDENTITY_MISMATCH');
  rejectsSync(() => validateManifest(validManifest(ident({ sourceRole: 'github' })), ident({ sourceRole: 'huggingface' })), 'HANDOFF_IDENTITY_MISMATCH'); // wrong role
  rejectsSync(() => validateManifest(validManifest(), ident({ producerMainSha: 'f'.repeat(40) })), 'HANDOFF_IDENTITY_MISMATCH');
  rejectsSync(() => validateManifest(validManifest(ident(), { archive_key: 'internal-handoff/harvest/x/y/huggingface/huggingface.tar.zst' }), ident()), 'HANDOFF_IDENTITY_MISMATCH');
});
test('(C5) multipart-ETag-as-sha + bad inventory hash rejected', () => {
  assert.equal(isSha256Hex('abc123-50'), false);
  rejectsSync(() => validateManifest(validManifest(ident(), { archive_sha256: 'abc123-50' }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
  const m = validManifest(); m.inventory = m.inventory.map((e, i) => (i === 0 ? { ...e, bytes: e.bytes + 1 } : e));
  rejectsSync(() => validateManifest(m, ident()), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(C6) membership contract bound INTO manifest (remove required member / tamper optional => RED)', () => {
  rejectsSync(() => validateManifest(validManifest(ident({ sourceRole: 'academic' }), { expected_required_members: ['data/arxiv_master.ndjson'] }), ident({ sourceRole: 'academic' })), 'HANDOFF_MANIFEST_MALFORMED');
  const eco = validManifest(ident({ sourceRole: 'ecosystem' }));
  eco.optional_members = eco.optional_members.filter((o) => o.name !== 'deepspec');
  rejectsSync(() => validateManifest(eco, ident({ sourceRole: 'ecosystem' })), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(C7) unexpected inventory member + forbidden field + cycle_id!=run_id rejected', () => {
  const m = validManifest(); m.inventory = [...m.inventory, mkFile('data/github_master.ndjson')]; m.actual_members = m.inventory.map((e) => e.path); m.file_count = m.inventory.length;
  rejectsSync(() => validateManifest(m, ident()), 'HANDOFF_MANIFEST_MALFORMED'); // github not owned by huggingface role
  rejectsSync(() => validateManifest(validManifest(ident(), { expected_consumer: 'merge' }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
  rejectsSync(() => validateManifest(validManifest(ident(), { cycle_id: 'other' }), ident()), 'HANDOFF_MANIFEST_MALFORMED');
});

// ==========================================================================
// D. ARCHIVE SAFETY
// ==========================================================================
test('(D1) archive inside data/ rejected; outside accepted', () => {
  rejectsSync(() => assertArchiveOutsidePayloadRoots('/ws/data/x.tar.zst', '/ws'), 'ARCHIVE_INSIDE_PAYLOAD_ROOT');
  assert.doesNotThrow(() => assertArchiveOutsidePayloadRoots('/rt/h/huggingface.tar.zst', '/ws'));
});
test('(D2) unsafe archive entries rejected', () => {
  rejectsSync(() => validateArchiveEntries([{ name: '/etc/passwd', type: 'file' }]), 'HANDOFF_UNSAFE_ARCHIVE');
  rejectsSync(() => validateArchiveEntries([{ name: 'data/../../evil', type: 'file' }]), 'HANDOFF_UNSAFE_ARCHIVE');
  rejectsSync(() => validateArchiveEntries([{ name: 'data/l', type: 'symlink', linkTarget: '/etc/shadow' }]), 'HANDOFF_UNSAFE_ARCHIVE');
  rejectsSync(() => validateArchiveEntries([{ name: 'data/h', type: 'hardlink', linkTarget: '../../../secret' }]), 'HANDOFF_UNSAFE_ARCHIVE');
});
test('(D3) data-root present/absent + inventory-from-entries drops dirs', () => {
  assert.ok(assertDataRootPresent(entriesFromInv(roleInventory('github'))));
  rejectsSync(() => assertDataRootPresent([{ name: 'data/', type: 'dir' }, { name: 'data/state/harvest-state-x.json', type: 'file' }]), 'HANDOFF_MISSING_ROOT');
  assert.equal(archiveInventoryFromEntries(entriesFromInv(roleInventory('github'))).length, roleInventory('github').length);
});
test('(D4) DETERMINISTIC_TAR_ARGS matches the §5 command exactly', () => {
  assert.deepEqual([...DETERMINISTIC_TAR_ARGS], ['--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0', '--numeric-owner', '--pax-option=delete=atime,delete=ctime', '--use-compress-program=zstd -T0 -3']);
});

// ==========================================================================
// E. PRODUCER establish — success (manifest LAST + read-back), faults
// ==========================================================================
test('(E1 positive) establish uploads archive then manifest LAST + re-verifies', async () => {
  for (const role of SOURCE_ROLES) {
    const w = makeWorld();
    const res = await establish(w, { identity: ident({ sourceRole: role }) });
    assert.equal(res.ok, true);
    assert.ok(w.r2.objects.has(archiveKeyFor(ident({ sourceRole: role }))));
    assert.ok(w.r2.objects.has(manifestKeyFor(ident({ sourceRole: role }))));
    const upIdx = w.r2.opLog.findIndex(([o]) => o === 'uploadFile');
    const mIdx = w.r2.opLog.findIndex(([o, k]) => o === 'putObject' && k.endsWith(MANIFEST_BASENAME));
    assert.ok(upIdx >= 0 && mIdx >= 0 && upIdx < mIdx, 'manifest LAST');
    assert.ok(w.r2.opLog.some(([o]) => o === 'headObject'), 'HeadObject byte-verify');
    assert.ok(w.r2.opLog.some(([o, k]) => o === 'getObjectBuffer' && k.endsWith(MANIFEST_BASENAME)), 'manifest read-back');
    const m = JSON.parse(w.r2.objects.get(manifestKeyFor(ident({ sourceRole: role }))).body.toString());
    assert.ok(isSha256Hex(m.archive_sha256));
  }
});
test('(E2) determinism: identical source => identical archive_sha256 + inventory_sha256', async () => {
  const a = await establish(makeWorld()); const b = await establish(makeWorld());
  assert.equal(a.archiveSha256, b.archiveSha256); assert.equal(a.inventorySha256, b.inventorySha256);
});
test('(E3) archive MISSING a member => ARCHIVE_MEMBER_SET_MISMATCH, no upload/manifest', async () => {
  const w = makeWorld();
  await rejects(() => establish(w, { entriesOverride: () => entriesFromInv(roleInventory('huggingface').slice(0, 1)) }), 'ARCHIVE_MEMBER_SET_MISMATCH');
  assert.equal(w.r2.objects.size, 0);
});
test('(E4) archive EXTRA member => ARCHIVE_MEMBER_SET_MISMATCH, no upload/manifest', async () => {
  const w = makeWorld();
  await rejects(() => establish(w, { entriesOverride: () => entriesFromInv([...roleInventory('huggingface'), mkFile('data/huggingface_extra_master.ndjson')]) }), 'ARCHIVE_MEMBER_SET_MISMATCH');
  assert.equal(w.r2.objects.size, 0);
});
test('(E5) SOURCE changed between pre/post scan => SOURCE_CHANGED, built but no upload', async () => {
  const changed = roleInventory('huggingface').map((f, i) => (i === 0 ? { ...f, bytes: f.bytes + 99 } : f));
  const w = makeWorld();
  await rejects(() => establish(w, { scanSequence: [roleInventory('huggingface'), changed] }), 'SOURCE_CHANGED_DURING_AUTHORITY_ESTABLISHMENT');
  assert.equal(w.P.buildCalled, true);
  assert.equal(w.r2.objects.size, 0);
});
test('(E6) disk preflight failure => RED, no build, no R2 op', async () => {
  const w = makeWorld();
  await rejects(() => establish(w, { free: 10 }), 'INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_ARCHIVE');
  assert.equal(w.P.buildCalled, false); assert.equal(w.r2.opLog.length, 0);
});
test('(E7) required missing at establish => REQUIRED_MEMBER_MISSING, no R2 op', async () => {
  const w = makeWorld();
  await rejects(() => establish(w, { scanFiles: roleInventory('academic').filter((f) => f.path !== 'data/arxiv_master.ndjson'), identity: ident({ sourceRole: 'academic' }) }), 'REQUIRED_MEMBER_MISSING');
  assert.equal(w.r2.objects.size, 0);
});
test('(E8) archive built inside data/ rejected before build', async () => {
  const w = makeWorld();
  await rejects(() => establish(w, { archivePath: '/ws/data/x.tar.zst', handoffTempRoot: '/ws' }), 'ARCHIVE_INSIDE_PAYLOAD_ROOT');
  assert.equal(w.P.buildCalled, false);
});
test('(E9) upload denied / corrupt => no manifest', async () => {
  const w1 = makeWorld(); w1.r2.faults.uploadFile = new HarvestHandoffError('HANDOFF_UPLOAD_FAILED', 'denied');
  await rejects(() => establish(w1, {}), 'HANDOFF_UPLOAD_FAILED');
  assert.ok(!w1.r2.objects.has(manifestKeyFor(ident())));
  const w2 = makeWorld(); w2.r2.corruptUpload = true;
  await rejects(() => establish(w2, {}), 'HANDOFF_UPLOAD_VERIFY_FAILED');
  assert.ok(!w2.r2.objects.has(manifestKeyFor(ident())));
});
test('(E10) manifest write denied / reverify drift => RED', async () => {
  const w1 = makeWorld(); w1.r2.faults.putObject = new HarvestHandoffError('HANDOFF_MANIFEST_WRITE_FAILED', 'denied');
  await rejects(() => establish(w1, {}), 'HANDOFF_MANIFEST_WRITE_FAILED');
  const w2 = makeWorld();
  const origGet = w2.r2.getObjectBuffer.bind(w2.r2);
  w2.r2.getObjectBuffer = async (key) => { const b = await origGet(key); if (key.endsWith(MANIFEST_BASENAME)) { const m = JSON.parse(b.toString()); m.archive_bytes += 7; return Buffer.from(JSON.stringify(m)); } return b; };
  await rejects(() => establish(w2, {}), 'MANIFEST_REVERIFY_FAILED');
});

// ==========================================================================
// F. C6 IMMUTABILITY — fail-closed collision (no overwrite of the exact tuple)
// ==========================================================================
test('(F1) existing MANIFEST => AUTHORITY_COLLISION, no build/overwrite', async () => {
  const w = makeWorld(); w.r2.objects.set(manifestKeyFor(ident()), { body: Buffer.from('{"pre":true}') });
  await rejects(() => establish(w, {}), 'AUTHORITY_COLLISION');
  assert.equal(w.P.buildCalled, false);
  assert.equal(w.r2.objects.get(manifestKeyFor(ident())).body.toString(), '{"pre":true}');
});
test('(F2) existing ARCHIVE without manifest => ORPHANED_PARTIAL_AUTHORITY_COLLISION', async () => {
  const w = makeWorld(); w.r2.objects.set(archiveKeyFor(ident()), { body: Buffer.from('partial') });
  await rejects(() => establish(w, {}), 'ORPHANED_PARTIAL_AUTHORITY_COLLISION');
  assert.equal(w.P.buildCalled, false);
});
test('(F3) re-establish SAME tuple rejected; NEW attempt tuple is not a collision', async () => {
  const w = makeWorld(); await establish(w, {});
  assert.equal(w.r2.objects.size, 2);
  await rejects(() => establish(w, {}), 'AUTHORITY_COLLISION');
  assert.equal(w.r2.objects.size, 2);
  await establish(w, { identity: ident({ runAttempt: '3' }) });
  assert.equal(w.r2.objects.size, 4);
});

// ==========================================================================
// G. §6 MERGE RESOLVER — current-first, bounded prior recovery, fail-closed
// ==========================================================================
test('(G1 positive) current attempt COMPLETE => selects CURRENT (even with a prior complete)', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '1'); await seedAttempt(w, 'run-200', '2');
  const r = await resolveCurrentRun({ r2: w.r2, runId: 'run-200', currentAttempt: '2', producerMainSha: SHA, deps: w.consumerDeps });
  assert.equal(r.selectedAttempt, '2'); assert.equal(r.mode, 'CURRENT_ATTEMPT');
});
test('(G2 positive) current EMPTY => highest prior complete of SAME run', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '1'); // attempt 2 empty
  const r = await resolveCurrentRun({ r2: w.r2, runId: 'run-200', currentAttempt: '2', producerMainSha: SHA, deps: w.consumerDeps });
  assert.equal(r.selectedAttempt, '1'); assert.equal(r.mode, 'HIGHEST_PRIOR_COMPLETE_ATTEMPT_OF_SAME_RUN');
});
test('(G3 positive) rerun-all current complete (attempt 3) selects current, ignoring priors', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '1'); await seedAttempt(w, 'run-200', '3');
  const r = await resolveCurrentRun({ r2: w.r2, runId: 'run-200', currentAttempt: '3', producerMainSha: SHA, deps: w.consumerDeps });
  assert.equal(r.selectedAttempt, '3'); assert.equal(r.mode, 'CURRENT_ATTEMPT');
});
test('(G4 negative) current PARTIAL (1-3) => FAIL_CLOSED, NO prior fallback', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '1'); // complete prior
  await seedAttempt(w, 'run-200', '2', SHA, ['huggingface', 'github']); // partial current (2/4)
  await rejects(() => resolveCurrentRun({ r2: w.r2, runId: 'run-200', currentAttempt: '2', producerMainSha: SHA, deps: w.consumerDeps }), 'HARVEST_MERGE_CURRENT_PARTIAL');
});
test('(G5 negative) NO complete attempt => MERGE_RED', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '1', SHA, ['huggingface']); // 1/4 prior
  await rejects(() => resolveCurrentRun({ r2: w.r2, runId: 'run-200', currentAttempt: '2', producerMainSha: SHA, deps: w.consumerDeps }), 'HARVEST_MERGE_NO_COMPLETE_ATTEMPT');
});
test('(G6 negative) current has a WRONG-producer-sha manifest => IDENTITY_MISMATCH (corrupt current)', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2', SHA, ['github', 'academic', 'ecosystem']);
  await establish(w, { identity: ident({ sourceRole: 'huggingface', runAttempt: '2', producerMainSha: 'b'.repeat(40) }) });
  await rejects(() => resolveCurrentRun({ r2: w.r2, runId: 'run-200', currentAttempt: '2', producerMainSha: SHA, deps: w.consumerDeps }), 'HANDOFF_IDENTITY_MISMATCH');
});
test('(G7 negative) prior attempt with mismatched sha is NOT eligible => MERGE_RED', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '1', 'c'.repeat(40)); // prior complete but different sha
  await rejects(() => resolveCurrentRun({ r2: w.r2, runId: 'run-200', currentAttempt: '2', producerMainSha: SHA, deps: w.consumerDeps }), 'HARVEST_MERGE_NO_COMPLETE_ATTEMPT');
});

// ==========================================================================
// H. §7 skip_harvest EXACT tuple
// ==========================================================================
test('(H1 positive) skip_harvest exact tuple 4/4 verified', async () => {
  const w = makeWorld(); await seedAttempt(w, 'src-9', '5', 'e'.repeat(40));
  const r = await resolveExactTuple({ r2: w.r2, runId: 'src-9', runAttempt: '5', deps: w.consumerDeps });
  assert.equal(r.selectedAttempt, '5'); assert.equal(r.mode, 'EXACT_TUPLE');
});
test('(H2 negative) skip_harvest tuple with 3/4 => SOURCE_INCOMPLETE (no prior/latest)', async () => {
  const w = makeWorld(); await seedAttempt(w, 'src-9', '5', 'e'.repeat(40), ['huggingface', 'github', 'academic']);
  await rejects(() => resolveExactTuple({ r2: w.r2, runId: 'src-9', runAttempt: '5', deps: w.consumerDeps }), 'HARVEST_MERGE_SOURCE_INCOMPLETE');
});
test('(H3 negative) mixed producer_main_sha across roles => HARVEST_MIXED_AUTHORITY', async () => {
  const w = makeWorld(); await seedAttempt(w, 'src-9', '5', 'e'.repeat(40));
  const mk = manifestKeyFor({ runId: 'src-9', runAttempt: '5', sourceRole: 'github' });
  const m = JSON.parse(w.r2.objects.get(mk).body.toString()); m.producer_main_sha = 'f'.repeat(40);
  w.r2.objects.set(mk, { body: Buffer.from(JSON.stringify(m)) });
  await rejects(() => resolveExactTuple({ r2: w.r2, runId: 'src-9', runAttempt: '5', deps: w.consumerDeps }), 'HARVEST_MIXED_AUTHORITY');
});

// ==========================================================================
// I. END-TO-END resolve + consume (verify + extract + union)
// ==========================================================================
test('(I1 positive) full current-attempt resolve+consume unions all four roles', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2');
  const res = await resolveConsume(w, consumeEnv());
  assert.equal(res.mode, 'CURRENT_ATTEMPT');
  assert.ok(w.C.unioned.includes('data/huggingface_master.ndjson'));
  assert.ok(w.C.unioned.includes('data/semanticscholar_master.ndjson'));
  assert.ok(w.C.unioned.includes('data/arxiv_master.ndjson'));
});
test('(I2 positive) skip_harvest env routes to exact tuple', async () => {
  const w = makeWorld(); await seedAttempt(w, 'src-1', '4', 'e'.repeat(40));
  const res = await resolveConsume(w, { SKIP_HARVEST: 'true', SOURCE_RUN_ID: 'src-1', SOURCE_RUN_ATTEMPT: '4' });
  assert.equal(res.mode, 'EXACT_TUPLE');
});
test('(I3 negative) downloaded byte / sha mismatch => distinct codes, no union', async () => {
  const w1 = makeWorld(); await seedAttempt(w1, 'run-200', '2');
  const mk = manifestKeyFor({ runId: 'run-200', runAttempt: '2', sourceRole: 'huggingface' });
  const m = JSON.parse(w1.r2.objects.get(mk).body.toString()); m.archive_bytes += 1;
  w1.r2.objects.set(mk, { body: Buffer.from(JSON.stringify(m)) });
  await rejects(() => resolveConsume(w1, consumeEnv()), 'HANDOFF_BYTE_MISMATCH');
  const w2 = makeWorld(); await seedAttempt(w2, 'run-200', '2');
  const m2 = JSON.parse(w2.r2.objects.get(mk).body.toString()); m2.archive_sha256 = 'c'.repeat(64);
  w2.r2.objects.set(mk, { body: Buffer.from(JSON.stringify(m2)) });
  await rejects(() => resolveConsume(w2, consumeEnv()), 'HANDOFF_SHA_MISMATCH');
});
test('(I4 negative) unsafe archive members => UNSAFE, never extracted/unioned', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2');
  await rejects(() => resolveConsume(w, consumeEnv(), { listArchiveEntries: () => [{ name: 'data/../../evil', type: 'file', size: 1 }] }), 'HANDOFF_UNSAFE_ARCHIVE');
  assert.equal(w.C.unioned.length, 0);
});
test('(I5 negative) archive member-set mismatch at consumer => rejected before extract', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2');
  await rejects(() => resolveConsume(w, consumeEnv(), { listArchiveEntries: () => entriesFromInv(roleInventory('huggingface').slice(0, 1)) }), 'ARCHIVE_MEMBER_SET_MISMATCH');
});
test('(I6 negative) extracted inventory / count mismatch => distinct codes', async () => {
  const w1 = makeWorld(); await seedAttempt(w1, 'run-200', '2');
  const changed = roleInventory('huggingface').map((e, i) => (i === 0 ? { ...e, sha256: 'd'.repeat(64) } : e));
  await rejects(() => resolveConsume(w1, consumeEnv(), { scanExtracted: () => changed }), 'HANDOFF_INVENTORY_MISMATCH');
  const w2 = makeWorld(); await seedAttempt(w2, 'run-200', '2');
  await rejects(() => resolveConsume(w2, consumeEnv(), { scanExtracted: () => roleInventory('huggingface').slice(0, 1) }), 'HANDOFF_FILE_COUNT_MISMATCH');
});
test('(I7 negative) archive object missing (manifest without payload) => HANDOFF_ARCHIVE_MISSING', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2');
  w.r2.objects.delete(archiveKeyFor({ runId: 'run-200', runAttempt: '2', sourceRole: 'huggingface' }));
  await rejects(() => resolveConsume(w, consumeEnv()), 'HANDOFF_ARCHIVE_MISSING');
});
test('(I8) no R2 object is ever deleted during consume', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2');
  const before = w.r2.objects.size;
  await resolveConsume(w, consumeEnv());
  assert.equal(w.r2.objects.size, before);
  assert.ok(!w.r2.opLog.some(([o]) => /delete/i.test(o)));
});
test('(I9 review FIX 4) each role staging is DROPPED after its union (peak disk bounded to 1 role)', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2'); // GHA_MISS -> all 4 consumed via R2
  await resolveConsume(w, consumeEnv());
  assert.equal(w.C.cleaned.length, 4, 'one staging cleaned per role');
  assert.equal(new Set(w.C.cleaned).size, 4, 'distinct per-role staging dirs, cleaned between roles');
});
test('(I10 review FIX 4) consumer disk-headroom preflight fails closed BEFORE download', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2'); w.C.free = 10;
  await rejects(() => resolveConsume(w, consumeEnv()), 'INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_CONSUME');
  assert.ok(!w.r2.opLog.some(([o]) => o === 'getObjectToFile'), 'no archive downloaded when disk-short');
  assert.equal(w.C.unioned.length, 0);
});

// ==========================================================================
// J. §8 GHA optional acceleration verified against the selected R2 manifest
// ==========================================================================
test('(J1 positive) GHA_EXACT_MATCH accelerates: no R2 archive download', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2'); w.C.ghaStatus = 'GHA_EXACT_MATCH';
  await resolveConsume(w, consumeEnv());
  assert.ok(!w.r2.opLog.some(([o]) => o === 'getObjectToFile'), 'no archive download on exact GHA match');
  assert.equal(w.C.unioned.length, 0, 'GHA copy already in place; no re-union');
});
test('(J2 positive) GHA_MISS => download + verify exact R2 (not fatal)', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2'); w.C.ghaStatus = 'GHA_MISS';
  await resolveConsume(w, consumeEnv());
  assert.ok(w.r2.opLog.some(([o]) => o === 'getObjectToFile'), 'downloads R2 on GHA miss');
  assert.ok(w.C.unioned.includes('data/github_master.ndjson'));
});
test('(J3 positive) GHA_MISMATCH => discard + download exact R2', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2'); w.C.ghaStatus = 'GHA_MISMATCH';
  await resolveConsume(w, consumeEnv());
  assert.ok(w.r2.opLog.some(([o]) => o === 'getObjectToFile'), 'downloads R2 on GHA mismatch');
});
test('(J4 negative/anti-vacuity) GHA match still MERGE_RED when the R2 authority is absent', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2', SHA, ['huggingface', 'github', 'academic']); // ecosystem authority absent
  w.C.ghaStatus = 'GHA_EXACT_MATCH';
  await rejects(() => resolveConsume(w, consumeEnv()), 'HARVEST_MERGE_CURRENT_PARTIAL');
});
test('(J5 review FIX 4) GHA_EXACT_MATCH bypasses download AND the consumer headroom preflight', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2'); w.C.ghaStatus = 'GHA_EXACT_MATCH'; w.C.free = 10; // disk-short
  await resolveConsume(w, consumeEnv()); // no download needed -> headroom never gates -> OK
  assert.ok(!w.r2.opLog.some(([o]) => o === 'getObjectToFile'));
  assert.equal(w.C.cleaned.length, 0, 'no staging created/cleaned on exact match');
});

// ==========================================================================
// K. ANTI-VACUITY MUTATIONS (D-236 §L 10 + D-237 §K 10) — documented ties
// ==========================================================================
test('(K1) manifest-LAST ordering is asserted (E1 reds if putObject precedes uploadFile)', async () => {
  const w = makeWorld(); await establish(w, {});
  const up = w.r2.opLog.findIndex(([o]) => o === 'uploadFile');
  const mf = w.r2.opLog.findIndex(([o, k]) => o === 'putObject' && k.endsWith(MANIFEST_BASENAME));
  assert.ok(up < mf);
});
test('(K2) producer read-back is asserted (drop it and E1/E10 red)', async () => {
  const w = makeWorld(); await establish(w, {});
  assert.ok(w.r2.opLog.filter(([o, k]) => o === 'getObjectBuffer' && k.endsWith(MANIFEST_BASENAME)).length >= 1);
});
test('(K3) exact run + attempt binding (mixed run_id at exact tuple => IDENTITY_MISMATCH)', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2');
  const mk = manifestKeyFor({ runId: 'run-200', runAttempt: '2', sourceRole: 'github' });
  const m = JSON.parse(w.r2.objects.get(mk).body.toString()); m.github_run_id = 'run-OTHER';
  w.r2.objects.set(mk, { body: Buffer.from(JSON.stringify(m)) });
  await rejects(() => resolveCurrentRun({ r2: w.r2, runId: 'run-200', currentAttempt: '2', producerMainSha: SHA, deps: w.consumerDeps }), 'HANDOFF_IDENTITY_MISMATCH');
});
test('(K4) four-role closed set required (3 roles present at current => PARTIAL, not consumed)', async () => {
  const w = makeWorld(); await seedAttempt(w, 'run-200', '2', SHA, ['huggingface', 'github', 'academic']);
  await rejects(() => resolveConsume(w, consumeEnv()), 'HARVEST_MERGE_CURRENT_PARTIAL');
});
test('(K5) expected role membership is FROZEN, not dir-scan (extra owned source in scan is excluded)', () => {
  // adding an unlisted source to the scan does NOT expand the archive/manifest
  const s = buildRoleSnapshot('github', [...roleInventory('github'), mkFile('data/replicate_master.ndjson')]);
  assert.ok(!s.actualMembers.includes('data/replicate_master.ndjson'));
});
test('(K6) removing a configured required Academic member (keeping arxiv) reds the manifest', () => {
  rejectsSync(() => validateManifest(validManifest(ident({ sourceRole: 'academic' }), { expected_required_members: ['data/arxiv_master.ndjson', 'data/huggingface-papers_master.ndjson'] }), ident({ sourceRole: 'academic' })), 'HANDOFF_MANIFEST_MALFORMED');
});
test('(K7) cross-module isolation: core + satellite roots disjoint from harvest', () => {
  assert.deepEqual([...CORE_ALLOWED], ['merge-core-persist', 'finalize']);
  assert.ok(!CORE_ALLOWED.includes('merge'));
  assert.notEqual(HANDOFF_PREFIX_ROOT, CORE_ROOT);
  assert.notEqual(HANDOFF_PREFIX_ROOT, SAT_ROOT);
});
test('(K8) MERGE_VERIFIED_TOKEN is the frozen gate token + assertManifestsConsistent catches mixed attempt', () => {
  assert.equal(MERGE_VERIFIED_TOKEN, 'FOUR_R2_SOURCE_AUTHORITIES_VERIFIED');
  const good = {}; for (const r of SOURCE_ROLES) good[r] = { source_role: r, github_run_id: 'x', github_run_attempt: '1', producer_main_sha: SHA, schema_version: 1 };
  assert.ok(assertManifestsConsistent(good));
  const mixed = JSON.parse(JSON.stringify(good)); mixed.github.github_run_attempt = '2';
  rejectsSync(() => assertManifestsConsistent(mixed), 'HARVEST_MIXED_AUTHORITY');
});
test('(K9) isGitSha / isSha256Hex structural guards', () => {
  assert.equal(isGitSha('a'.repeat(40)), true); assert.equal(isGitSha('a'.repeat(64)), false);
  assert.equal(isSha256Hex('a'.repeat(64)), true); assert.equal(isSha256Hex('a'.repeat(40)), false);
});
test('(K10) ownedSources + authorizedMemberPaths cover masters + sidecars only', () => {
  const owned = ownedSourcesFor('ecosystem');
  assert.equal(owned.all.length, 10);
  const paths = authorizedMemberPaths('huggingface');
  assert.deepEqual(paths.sort(), ['data/huggingface_master.ndjson', 'data/state/harvest-state-huggingface.json']);
});
