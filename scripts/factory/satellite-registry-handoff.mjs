// scripts/factory/satellite-registry-handoff.mjs
//
// Authoritative R2 attempt-scoped SATELLITE-REGISTRY handoff for the Factory 3/4
// Aggregate Persist -> {preflight, 4 satellites} seam. Distinct carrier from the
// D-211/D-219 CORE handoff.
//
// Authorized under Founder D-2026-0702-228 (P0 permanent repair) + D-226 §I +
// D-229 + the D-2026-0702-230 SCOPE CORRECTION. Binding design record:
// FREE2AITOOLS_BACKEND_SATELLITE_REGISTRY_HANDOFF_RELIABILITY_AMENDMENT_PROPOSAL_v1
// (§0 C1-C10 + D-230 C9/C10 supersede any looser body wording).
//
// C1 CONTRACT ISOLATION VIA DUPLICATION: this module is SELF-CONTAINED. It does
// NOT import from aggregate-handoff.mjs (the D-219 core). The small set of
// stateless, contract-free primitives it needs (HandoffError-style class,
// isSha256Hex, validateArchiveEntries, assertArchiveOutsidePayloadRoots,
// assertArchiveParentConfined, deterministic-tar argv, recovery-guidance policy)
// is DUPLICATED here so a future core refactor can never perturb this contract.
//
// Every external effect (R2, disk probe, archive build, hashing, extraction,
// clock) is an injectable dependency, so the whole contract is exercised by
// satellite-registry-handoff.test.mjs WITHOUT any real network / tar / @aws-sdk.
// The CLI wrapper (r2-workflow-cli.js satellite-registry-*) wires the REAL deps.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// ============================================================================
// Frozen contract constants (§6 manifest / §7 roles / §8 namespace / §5 archive)
// ============================================================================

export const SCHEMA_VERSION = 1;
export const CARRIER_TYPE = 'satellite-registry';               // §6 field 2, frozen
export const PRODUCER_ROLE = 'merge-core-persist';              // §6 field 7, frozen
export const HANDOFF_PREFIX_ROOT = 'internal-handoff/aggregate-satellite'; // §8, distinct from core
export const ARCHIVE_BASENAME = 'registry.tar.zst';
export const MANIFEST_BASENAME = 'manifest.json';
export const REGISTRY_ROOT = 'cache/registry';                 // the SOLE archived payload root (§3)
export const PAYLOAD_ROOTS = Object.freeze([REGISTRY_ROOT]);
export const DISK_HEADROOM_BYTES = 8 * 1024 * 1024 * 1024;     // 8 GiB (mirror core D-217 invariant)
export const COMPLETION_STATE = 'complete';

// Anti-vacuity floor ONLY (C9(a)): rejects an empty / tiny vacuous source. It is
// NOT an upstream generation-completeness oracle (D-230 removed C7). Production is
// ~601 shards and the registry is append-only monotonic, so 100 is a safe 6x
// margin that never false-rejects a real cycle while blocking a degenerate one.
export const REGISTRY_SHARD_FLOOR = 100;

// §6 field 13: frozen ORDERED array — EXACTLY these four in this order. No
// wildcard / 5th / reordered / duplicate member (validated exact).
export const ALLOWED_CONSUMERS = Object.freeze(['search-index', 'rankings', 'knowledge-mesh', 'trending']);

// The preflight is a verify-only role: it downloads + fully verifies but is NOT a
// member of ALLOWED_CONSUMERS (it exposes nothing to a workspace).
export const PREFLIGHT_ROLE = 'satellite-authority-preflight';

// The singular expected_consumer field (core D-209 draft) MUST NOT appear.
export const FORBIDDEN_MANIFEST_FIELDS = Object.freeze(['expected_consumer']);

// Recovery guidance must NEVER emit the generic incident phrase (duplicated policy).
export const FORBIDDEN_RERUN_PHRASE = 'Re-run failed jobs';

// Canonical shard grammar: registry-saver.js writes `part-${padStart(3,'0')}.bin`.
export const SHARD_NAME_RE = /^part-(\d+)\.bin$/;

// Deterministic archive command (§5). Kept as data so the test asserts the exact
// argv and the real builder shares one source. DUPLICATED from the core policy.
export const DETERMINISTIC_TAR_ARGS = Object.freeze([
  '--sort=name',
  '--mtime=UTC 1970-01-01',
  '--owner=0',
  '--group=0',
  '--numeric-owner',
  '--pax-option=delete=atime,delete=ctime',
  '--use-compress-program=zstd -T0 -3',
]);

export const PRODUCER_TERMINAL =
  'AUTHORITATIVE_SATELLITE_HANDOFF_NOT_ESTABLISHED / PERSIST_RED / SATELLITES_NOT_ELIGIBLE';
export const PREFLIGHT_TERMINAL =
  'SATELLITE_AUTHORITY_PREFLIGHT_FAILED / SATELLITES_NOT_STARTED';
export const CONSUMER_TERMINAL =
  'UNAUTHORIZED_OR_UNVERIFIED_SATELLITE_HANDOFF / EXECUTION_INVALID / ZERO_WRITES';

// ============================================================================
// Errors + sha256 guard (DUPLICATED primitives — C1)
// ============================================================================

export class SatelliteHandoffError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'SatelliteHandoffError';
    this.code = code;
  }
}
function fail(code, message) { throw new SatelliteHandoffError(code, message); }

// A regular 64-char lowercase hex sha256. A multipart R2 ETag ("ab12-50") can
// NEVER satisfy this — structural guard against ever treating an ETag as a sha256.
const SHA256_RE = /^[0-9a-f]{64}$/;
export function isSha256Hex(v) { return typeof v === 'string' && SHA256_RE.test(v); }

// ============================================================================
// Identity + key derivation (§8 tuple)
// ============================================================================

const IDENTITY_FIELDS = ['cycleId', 'runId', 'runAttempt', 'producerMainSha'];

export function assertIdentity(identity) {
  if (!identity || typeof identity !== 'object') fail('HANDOFF_IDENTITY_INVALID', 'identity object required');
  for (const f of IDENTITY_FIELDS) {
    const v = identity[f];
    if (typeof v !== 'string' || v.length === 0) fail('HANDOFF_IDENTITY_INVALID', `identity.${f} missing`);
    if (v === 'latest') fail('HANDOFF_IDENTITY_INVALID', `identity.${f} must not be the mutable token "latest"`);
    if (/[/\\]/.test(v) || v.includes('..')) fail('HANDOFF_IDENTITY_INVALID', `identity.${f} must be a single path-safe segment`);
  }
  return identity;
}

export function buildHandoffPrefix(identity) {
  assertIdentity(identity);
  const { cycleId, runId, runAttempt, producerMainSha } = identity;
  return `${HANDOFF_PREFIX_ROOT}/${cycleId}/${runId}/${runAttempt}/${producerMainSha}/`;
}
export function archiveKeyFor(identity) { return buildHandoffPrefix(identity) + ARCHIVE_BASENAME; }
export function manifestKeyFor(identity) { return buildHandoffPrefix(identity) + MANIFEST_BASENAME; }

// A satellite consumer_role is a FIXED workflow config literal, never user input.
export function assertConsumerRoleKnown(consumerRole) {
  if (!ALLOWED_CONSUMERS.includes(consumerRole)) {
    fail('UNAUTHORIZED_HANDOFF_CONSUMER', `role "${consumerRole}" is not a configured satellite consumer`);
  }
  return consumerRole;
}

// Role-segmented, distinct staging path. Two consumers can NEVER share a path —
// the role is a mandatory path segment. Any non [a-z0-9-] role is rejected.
export function stagingDirFor(stagingRoot, identity, role) {
  assertIdentity(identity);
  if (typeof role !== 'string' || !/^[a-z0-9-]+$/.test(role)) fail('HANDOFF_STAGING_INVALID', `bad role segment: ${role}`);
  return path.join(stagingRoot, identity.runId, identity.runAttempt, role);
}
// Consumer-facing helper that ALSO asserts the role is one of the four (used by
// the workflow wiring + the distinct-staging proof).
export function consumerStagingDir(stagingRoot, identity, consumerRole) {
  assertConsumerRoleKnown(consumerRole);
  return stagingDirFor(stagingRoot, identity, consumerRole);
}

// ============================================================================
// C9(a) SOURCE SNAPSHOT — exact, non-vacuous carrier-transport completeness
// ============================================================================

// inventory_sha256 = hash over a canonical sorted [path,size] inventory (NOT a
// circular self-hash of the manifest). DUPLICATED policy.
export function inventorySha256(inventory) {
  const canonical = [...inventory]
    .map((e) => [String(e.path), Number(e.size)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// Build the ONE exact source snapshot from a scanned cache/registry/ file list.
// `files` = [{ path: 'cache/registry/part-NNN.bin', size }]. Rejects (C9(a)):
// empty, count<floor, non part-NNN.bin grammar, non-canonical zero-pad, duplicate
// index, GAP between observed min..max, unexpected file, absolute/traversal path.
export function buildSourceSnapshot(files, { shardFloor = REGISTRY_SHARD_FLOOR } = {}) {
  if (!Array.isArray(files)) fail('SOURCE_SNAPSHOT_INVALID', 'files must be an array');
  if (files.length === 0) fail('SOURCE_REGISTRY_EMPTY', `no files under ${REGISTRY_ROOT}/`);
  const seen = new Map();
  const inventory = [];
  let aggregateBytes = 0;
  let minIndex = Infinity;
  let maxIndex = -Infinity;
  const prefix = `${REGISTRY_ROOT}/`;
  for (const f of files) {
    const rawPath = String(f && f.path);
    const size = f && f.size;
    if (!rawPath || rawPath === 'undefined') fail('SOURCE_UNEXPECTED_FILE', 'entry with no path');
    if (path.isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith('/') || rawPath.startsWith('\\')) {
      fail('SOURCE_ABSOLUTE_PATH', `absolute source path: ${rawPath}`);
    }
    const norm = rawPath.replace(/\\/g, '/');
    if (norm.split('/').some((s) => s === '..')) fail('SOURCE_TRAVERSAL_PATH', `traversal source path: ${rawPath}`);
    if (!norm.startsWith(prefix)) fail('SOURCE_UNEXPECTED_FILE', `outside ${REGISTRY_ROOT}: ${rawPath}`);
    const rel = norm.slice(prefix.length);
    if (rel.includes('/')) fail('SOURCE_UNEXPECTED_FILE', `nested path under registry: ${rawPath}`);
    const m = rel.match(SHARD_NAME_RE);
    if (!m) fail('SOURCE_UNEXPECTED_FILE', `filename outside part-NNN.bin grammar: ${rel}`);
    const idx = Number(m[1]);
    if (rel !== `part-${String(idx).padStart(3, '0')}.bin`) fail('SOURCE_UNEXPECTED_FILE', `non-canonical shard name: ${rel}`);
    if (!Number.isInteger(size) || size < 0) fail('SOURCE_SHARD_SIZE_INVALID', `${rel} size=${size}`);
    if (seen.has(idx)) fail('SOURCE_DUPLICATE_SHARD_INDEX', `index ${idx}: ${seen.get(idx)} and ${rel}`);
    seen.set(idx, rel);
    inventory.push({ path: norm, size });
    aggregateBytes += size;
    if (idx < minIndex) minIndex = idx;
    if (idx > maxIndex) maxIndex = idx;
  }
  const shardCount = inventory.length;
  if (shardCount < shardFloor) fail('SOURCE_SHARD_COUNT_BELOW_FLOOR', `${shardCount} < floor ${shardFloor}`);
  // GAP: with no duplicates, contiguity <=> (max-min+1 === count). Observed max is
  // a STRUCTURAL sanity check over the snapshot ONLY, NOT an upstream oracle.
  if (maxIndex - minIndex + 1 !== shardCount) {
    fail('SOURCE_SHARD_INDEX_GAP', `gap: min ${minIndex}..max ${maxIndex} spans ${maxIndex - minIndex + 1} but count is ${shardCount}`);
  }
  const sorted = [...inventory].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { shardCount, minIndex, maxIndex, aggregateBytes, inventory: sorted, inventorySha256: inventorySha256(sorted) };
}

// C9(c) source-stability: two snapshots of the SAME source must be EXACTLY equal.
export function assertSnapshotsEqual(a, b, code) {
  if (a.shardCount !== b.shardCount || a.aggregateBytes !== b.aggregateBytes
    || a.inventorySha256 !== b.inventorySha256 || a.minIndex !== b.minIndex || a.maxIndex !== b.maxIndex) {
    fail(code, `source snapshot drift: count ${a.shardCount}->${b.shardCount}, bytes ${a.aggregateBytes}->${b.aggregateBytes}, hash ${a.inventorySha256}!=${b.inventorySha256}`);
  }
  return true;
}

// C9(b) EXACT member-set equality between two sorted [{path,size}] inventories.
export function assertInventoriesEqual(a, b, code) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    fail(code, `member count ${a && a.length} != ${b && b.length}`);
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].path !== b[i].path) fail(code, `member path mismatch: ${a[i].path} vs ${b[i].path}`);
    if (Number(a[i].size) !== Number(b[i].size)) fail(code, `member size mismatch at ${a[i].path}: ${a[i].size} vs ${b[i].size}`);
  }
  return true;
}

// ============================================================================
// Manifest build + validation (§6 — 15 fields + C9(d) option-1 inventory array)
// ============================================================================

export function buildManifest({ identity, snapshot, archiveBytes, archiveSha256, createdAtUtc }) {
  assertIdentity(identity);
  if (!Number.isInteger(archiveBytes) || archiveBytes <= 0) fail('MANIFEST_BUILD_INVALID', 'archiveBytes must be positive int');
  if (!isSha256Hex(archiveSha256)) fail('MANIFEST_BUILD_INVALID', 'archiveSha256 must be sha256 hex');
  return {
    schema_version: SCHEMA_VERSION,
    carrier_type: CARRIER_TYPE,
    cycle_id: identity.cycleId,
    github_run_id: identity.runId,
    github_run_attempt: identity.runAttempt,
    producer_main_sha: identity.producerMainSha,
    producer_role: PRODUCER_ROLE,
    archive_key: archiveKeyFor(identity),
    archive_bytes: archiveBytes,
    archive_sha256: archiveSha256,
    inventory_sha256: snapshot.inventorySha256,
    registry_shard_count: snapshot.shardCount,
    allowed_consumers: [...ALLOWED_CONSUMERS],
    completion_state: COMPLETION_STATE,
    created_at_utc: createdAtUtc,
    // C9(d) option 1: sorted inventory array IN the manifest = exact member-set
    // evidence (not count-only). Bounded (~601 entries ~ 35-45 KB).
    inventory: snapshot.inventory.map((e) => ({ path: e.path, size: e.size })),
  };
}

// EXACT closed-set equality: same length, same members, SAME ORDER (§6 field 13).
function allowedConsumersExact(arr) {
  return Array.isArray(arr)
    && arr.length === ALLOWED_CONSUMERS.length
    && arr.every((v, i) => v === ALLOWED_CONSUMERS[i]);
}

// The manifest inventory array must be a sorted, grammar-conformant member set
// whose hash is exactly inventory_sha256 (binds the array to the hash — non-vacuous).
function validateManifestInventory(manifest) {
  const inv = manifest.inventory;
  if (!Array.isArray(inv)) fail('HANDOFF_MANIFEST_MALFORMED', 'inventory is not an array');
  if (inv.length !== manifest.registry_shard_count) fail('HANDOFF_MANIFEST_MALFORMED', `inventory length ${inv.length} != registry_shard_count ${manifest.registry_shard_count}`);
  const prefix = `${REGISTRY_ROOT}/`;
  let prev = null;
  for (const e of inv) {
    if (!e || typeof e !== 'object') fail('HANDOFF_MANIFEST_MALFORMED', 'inventory entry is not an object');
    const p = String(e.path);
    if (!p.startsWith(prefix)) fail('HANDOFF_MANIFEST_MALFORMED', `inventory path outside registry: ${p}`);
    const rel = p.slice(prefix.length);
    const m = rel.match(SHARD_NAME_RE);
    if (!m || rel !== `part-${String(Number(m[1])).padStart(3, '0')}.bin`) fail('HANDOFF_MANIFEST_MALFORMED', `inventory path grammar: ${p}`);
    if (!Number.isInteger(e.size) || e.size < 0) fail('HANDOFF_MANIFEST_MALFORMED', `inventory size invalid: ${p}`);
    if (prev !== null && !(prev < p)) fail('HANDOFF_MANIFEST_MALFORMED', `inventory not strictly sorted at ${p}`);
    prev = p;
  }
  if (inventorySha256(inv) !== manifest.inventory_sha256) fail('HANDOFF_MANIFEST_MALFORMED', 'inventory_sha256 does not match the inventory array');
  return true;
}

// Full manifest validation shared by producer re-verify, preflight, and every
// consumer. ZERO side effects (validate before any write).
export function validateManifest(manifest, identity, { shardFloor = REGISTRY_SHARD_FLOOR } = {}) {
  assertIdentity(identity);
  if (!manifest || typeof manifest !== 'object') fail('HANDOFF_MANIFEST_MALFORMED', 'not an object');
  for (const f of FORBIDDEN_MANIFEST_FIELDS) {
    if (f in manifest) fail('HANDOFF_MANIFEST_MALFORMED', `superseded field "${f}" present`);
  }
  if (manifest.schema_version !== SCHEMA_VERSION) fail('HANDOFF_MANIFEST_MALFORMED', 'schema_version mismatch');
  if (manifest.carrier_type !== CARRIER_TYPE) fail('HANDOFF_MANIFEST_MALFORMED', `carrier_type="${manifest.carrier_type}" (expected ${CARRIER_TYPE})`);
  if (manifest.producer_role !== PRODUCER_ROLE) fail('HANDOFF_MANIFEST_MALFORMED', `producer_role="${manifest.producer_role}"`);
  if (manifest.completion_state !== COMPLETION_STATE) fail('HANDOFF_MANIFEST_INCOMPLETE', `completion_state="${manifest.completion_state}"`);
  if (!allowedConsumersExact(manifest.allowed_consumers)) {
    fail('HANDOFF_MANIFEST_MALFORMED', 'allowed_consumers is not the exact ordered [search-index, rankings, knowledge-mesh, trending] array');
  }
  const idMap = {
    cycle_id: identity.cycleId,
    github_run_id: identity.runId,
    github_run_attempt: identity.runAttempt,
    producer_main_sha: identity.producerMainSha,
  };
  for (const [k, expected] of Object.entries(idMap)) {
    if (manifest[k] !== expected) fail('HANDOFF_IDENTITY_MISMATCH', `${k}: manifest="${manifest[k]}" expected="${expected}"`);
  }
  if (manifest.archive_key !== archiveKeyFor(identity)) fail('HANDOFF_IDENTITY_MISMATCH', 'archive_key does not match attempt prefix');
  if (!Number.isInteger(manifest.archive_bytes) || manifest.archive_bytes <= 0) fail('HANDOFF_MANIFEST_MALFORMED', 'archive_bytes invalid');
  if (!isSha256Hex(manifest.archive_sha256)) fail('HANDOFF_MANIFEST_MALFORMED', 'archive_sha256 is not a sha256 (multipart ETag rejected)');
  if (!isSha256Hex(manifest.inventory_sha256)) fail('HANDOFF_MANIFEST_MALFORMED', 'inventory_sha256 is not a sha256');
  if (!Number.isInteger(manifest.registry_shard_count) || manifest.registry_shard_count < shardFloor) {
    fail('HANDOFF_MANIFEST_MALFORMED', `registry_shard_count ${manifest.registry_shard_count} < floor ${shardFloor}`);
  }
  validateManifestInventory(manifest);
  return manifest;
}

// ============================================================================
// Archive location + payload safety (§5 / §10 extraction safety) — DUPLICATED
// ============================================================================

export function assertArchiveOutsidePayloadRoots(archivePath, workspaceDir) {
  const abs = path.resolve(archivePath);
  for (const root of PAYLOAD_ROOTS) {
    const rootAbs = path.resolve(workspaceDir, root) + path.sep;
    if ((abs + path.sep).startsWith(rootAbs)) {
      fail('ARCHIVE_INSIDE_PAYLOAD_ROOT', `archive ${abs} is inside payload root ${root}`);
    }
  }
}

export function assertArchiveParentConfined(archiveParent, handoffTempRoot) {
  const rootAbs = path.resolve(handoffTempRoot);
  const abs = path.resolve(archiveParent);
  if (abs !== rootAbs && !(abs + path.sep).startsWith(rootAbs + path.sep)) {
    fail('HANDOFF_ARCHIVE_PARENT_ESCAPE', `archive parent ${abs} escapes handoff temp root ${rootAbs}`);
  }
  return abs;
}

// Reject absolute members, ".." traversal, symlink/hardlink escapes BEFORE
// extraction. `entries` = [{ name, type, size, linkTarget }]. DUPLICATED.
export function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) fail('HANDOFF_UNSAFE_ARCHIVE', 'empty/invalid entry list');
  for (const e of entries) {
    const name = String(e && e.name);
    if (!name || name === 'undefined') fail('HANDOFF_UNSAFE_ARCHIVE', 'entry with no name');
    if (path.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name) || name.startsWith('/') || name.startsWith('\\')) {
      fail('HANDOFF_UNSAFE_ARCHIVE', `absolute member: ${name}`);
    }
    if (name.split(/[\\/]/).some((seg) => seg === '..')) fail('HANDOFF_UNSAFE_ARCHIVE', `traversal member: ${name}`);
    if (e && (e.type === 'symlink' || e.type === 'hardlink' || e.type === 'link')) {
      const tgt = String(e.linkTarget || '');
      if (!tgt) fail('HANDOFF_UNSAFE_ARCHIVE', `link ${name} with no target`);
      if (path.isAbsolute(tgt) || tgt.startsWith('/') || /^[A-Za-z]:[\\/]/.test(tgt)) fail('HANDOFF_UNSAFE_ARCHIVE', `absolute link target: ${name} -> ${tgt}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name.replace(/\\/g, '/')), tgt.replace(/\\/g, '/')));
      if (resolved.startsWith('..')) fail('HANDOFF_UNSAFE_ARCHIVE', `escaping link: ${name} -> ${tgt}`);
    }
  }
  return true;
}

// The archive must carry at least one cache/registry/part-*.bin member (§10 step 6).
export function assertRegistryRootPresent(entries) {
  const has = entries.some((e) => /^(\.\/)?cache\/registry\/part-\d+\.bin$/.test(String(e.name).replace(/\\/g, '/')));
  if (!has) fail('HANDOFF_MISSING_ROOT', `archive has no ${REGISTRY_ROOT}/ shard members`);
  return true;
}

// Build a sorted [{path,size}] inventory of the FILE members of a listed archive
// (directory members excluded). Used for the pre-extraction member-set check.
export function archiveInventoryFromEntries(entries) {
  const inv = [];
  for (const e of entries) {
    if (!e || e.type === 'dir') continue;
    const name = String(e.name).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    inv.push({ path: name, size: Number(e.size) });
  }
  return inv.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ============================================================================
// Producer: establish authoritative satellite handoff (§9 14-step / C5 / C6 / C9)
// ============================================================================
export async function establishSatelliteHandoff({
  r2, identity, workspaceDir, archivePath,
  deps = productionProducerDeps(), clock = Date, logger = console,
  handoffTempRoot = process.env.RUNNER_TEMP || os.tmpdir(), shardFloor = REGISTRY_SHARD_FLOOR,
}) {
  assertIdentity(identity);
  const log = (m) => logger.log?.(`[SAT-HANDOFF:establish] ${m}`);

  // 1. resolve archive parent; it MUST live OUTSIDE cache/registry (else tar would
  //    recurse into its own growing output) and stay confined to RUNNER_TEMP.
  const archiveParent = path.dirname(archivePath);
  assertArchiveOutsidePayloadRoots(archivePath, workspaceDir);
  assertArchiveParentConfined(archiveParent, handoffTempRoot);
  // 2. create parent BEFORE any statfs probe (D-217), then re-confine after realpath.
  deps.ensureDir(archiveParent);
  const realParent = deps.realpathDir(archiveParent);
  assertArchiveParentConfined(realParent, handoffTempRoot);

  // 3. C9(a) EXACT SOURCE SNAPSHOT #1 (pre-archive).
  const snapshot1 = buildSourceSnapshot(deps.scanRegistry(workspaceDir), { shardFloor });
  log(`source snapshot: ${snapshot1.shardCount} shards, ${snapshot1.aggregateBytes}B, idx ${snapshot1.minIndex}..${snapshot1.maxIndex}`);

  // 4. disk headroom on the now-existing parent.
  const destFree = deps.freeBytes(realParent);
  const required = snapshot1.aggregateBytes + DISK_HEADROOM_BYTES;
  if (destFree < required) fail('INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_ARCHIVE', `need ${required}B free, have ${destFree}B`);

  // 5. C6 IMMUTABILITY / FAIL-CLOSED collision: check BOTH keys before establishing.
  const archiveKey = archiveKeyFor(identity);
  const manifestKey = manifestKeyFor(identity);
  if (await objectExists(r2, manifestKey)) fail('AUTHORITY_COLLISION', `manifest already exists at ${manifestKey} — immutable tuple, no overwrite`);
  if (await objectExists(r2, archiveKey)) fail('ORPHANED_PARTIAL_AUTHORITY_COLLISION', `archive exists without manifest at ${archiveKey} — fail closed, no repair`);

  // 6. build deterministic tar+zstd of ONLY cache/registry/, close before hashing.
  deps.buildArchive(archivePath, workspaceDir, [REGISTRY_ROOT]);

  // 7. C9(c) SOURCE-STABILITY: rescan AFTER build, BEFORE upload; must equal #1.
  const snapshot2 = buildSourceSnapshot(deps.scanRegistry(workspaceDir), { shardFloor });
  assertSnapshotsEqual(snapshot1, snapshot2, 'SOURCE_CHANGED_DURING_AUTHORITY_ESTABLISHMENT');

  // 8. compute exact archive bytes + sha256; verify archive member set == snapshot.
  const { bytes: archiveBytes, sha256: archiveSha256 } = deps.hashFile(archivePath);
  if (!isSha256Hex(archiveSha256)) fail('ARCHIVE_HASH_INVALID', 'local sha256 malformed');
  const entries = deps.listArchiveEntries(archivePath);
  validateArchiveEntries(entries);
  assertRegistryRootPresent(entries);
  assertInventoriesEqual(archiveInventoryFromEntries(entries), snapshot1.inventory, 'ARCHIVE_MEMBER_SET_MISMATCH');

  // 9. multipart upload, then verify uploaded byte-count via HeadObject (ETag NOT a hash).
  await r2.uploadFile(archiveKey, archivePath, 'application/octet-stream');
  const head = await r2.headObject(archiveKey);
  if (Number(head.size) !== archiveBytes) fail('HANDOFF_UPLOAD_VERIFY_FAILED', `uploaded size ${head.size} != local ${archiveBytes}`);

  // 10. write the immutable manifest LAST (derived from the STABLE snapshot #1).
  const manifest = buildManifest({ identity, snapshot: snapshot1, archiveBytes, archiveSha256, createdAtUtc: new Date(clock.now()).toISOString() });
  await r2.putObject(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');

  // 11. GetObject manifest back + full validate + assert refetched evidence == local.
  const refetched = JSON.parse((await r2.getObjectBuffer(manifestKey)).toString('utf-8'));
  validateManifest(refetched, identity, { shardFloor });
  if (refetched.archive_bytes !== archiveBytes || refetched.archive_sha256 !== archiveSha256
    || refetched.inventory_sha256 !== snapshot1.inventorySha256 || refetched.registry_shard_count !== snapshot1.shardCount) {
    fail('MANIFEST_REVERIFY_FAILED', 'refetched manifest evidence drifted');
  }
  log(`established ${archiveKey} (${archiveBytes}B, ${snapshot1.shardCount} shards) + manifest LAST`);
  return {
    ok: true, archiveKey, manifestKey, archiveBytes, archiveSha256,
    inventorySha256: snapshot1.inventorySha256, registryShardCount: snapshot1.shardCount, manifest,
  };
}

async function objectExists(r2, key) {
  try { await r2.headObject(key); return true; }
  catch (e) { if (e && e.code === 'R2_OBJECT_NOT_FOUND') return false; throw e; }
}

// ============================================================================
// Shared verify+extract used by preflight and every consumer (§10 / C5 / C9(b,e))
// ============================================================================
async function verifyAndExtract({ r2, identity, role, stagingRoot, deps, shardFloor }) {
  // 1. load the CURRENT-attempt manifest (never a peer/cache/secondary manifest).
  const manifestKey = manifestKeyFor(identity);
  let manifestBuf;
  try { manifestBuf = await r2.getObjectBuffer(manifestKey); }
  catch (e) { if (e && e.code === 'R2_OBJECT_NOT_FOUND') fail('HANDOFF_MANIFEST_MISSING', `no manifest at ${manifestKey}`); throw e; }
  let manifest;
  try { manifest = JSON.parse(manifestBuf.toString('utf-8')); }
  catch { fail('HANDOFF_MANIFEST_MALFORMED', 'manifest is not valid JSON'); }
  // 2. full manifest validation + (for the four consumers) own-role membership.
  validateManifest(manifest, identity, { shardFloor });
  if (role !== PREFLIGHT_ROLE && !manifest.allowed_consumers.includes(role)) {
    fail('UNAUTHORIZED_HANDOFF_CONSUMER', `role "${role}" not in allowed_consumers`);
  }
  // 3. clean, role-segmented staging path — no shared mutable path.
  const stagingDir = stagingDirFor(stagingRoot, identity, role);
  const archiveDest = path.join(stagingDir, ARCHIVE_BASENAME);
  const treeDir = path.join(stagingDir, 'tree');
  deps.prepareCleanStaging(stagingDir, treeDir);
  // 4. download the EXACT archive.
  const archiveKey = manifest.archive_key;
  try { await deps.download(r2, archiveKey, archiveDest); }
  catch (e) { if (e && e.code === 'R2_OBJECT_NOT_FOUND') fail('HANDOFF_ARCHIVE_MISSING', `no archive at ${archiveKey}`); throw e; }
  // 5. recompute byte count + sha256, match the manifest (distinct FATAL codes).
  const { bytes, sha256 } = deps.hashFile(archiveDest);
  if (bytes !== manifest.archive_bytes) fail('HANDOFF_BYTE_MISMATCH', `downloaded ${bytes}B != manifest ${manifest.archive_bytes}B`);
  if (sha256 !== manifest.archive_sha256) fail('HANDOFF_SHA_MISMATCH', 'downloaded sha256 != manifest sha256');
  // 6. safety + required root + member-set == manifest inventory, BEFORE extraction.
  const entries = deps.listArchiveEntries(archiveDest);
  validateArchiveEntries(entries);
  assertRegistryRootPresent(entries);
  assertInventoriesEqual(archiveInventoryFromEntries(entries), manifest.inventory, 'ARCHIVE_MEMBER_SET_MISMATCH');
  // 7. extract, then INDEPENDENTLY re-scan the extracted tree and re-verify the
  //    exact member set + inventory hash + shard count (post-extraction proof).
  deps.extract(archiveDest, treeDir);
  const extractedSnap = buildSourceSnapshot(deps.scanExtractedRegistry(treeDir), { shardFloor });
  if (extractedSnap.shardCount !== manifest.registry_shard_count) fail('HANDOFF_SHARD_COUNT_MISMATCH', `extracted ${extractedSnap.shardCount} != manifest ${manifest.registry_shard_count}`);
  if (extractedSnap.inventorySha256 !== manifest.inventory_sha256) fail('HANDOFF_INVENTORY_MISMATCH', 'extracted inventory hash != manifest inventory_sha256');
  assertInventoriesEqual(extractedSnap.inventory, manifest.inventory, 'HANDOFF_INVENTORY_MISMATCH');
  return { ok: true, treeDir, stagingDir, archiveDest, bytes, sha256, registryShardCount: extractedSnap.shardCount, manifest };
}

// Preflight: single verify-only gate between Persist and the four satellites.
// Full independent remote verification in its OWN staging; exposes NOTHING and
// deletes its temp copy (C5).
export async function preflightSatelliteHandoff({
  r2, identity, stagingRoot,
  deps = productionConsumerDeps(), clock = Date, logger = console, shardFloor = REGISTRY_SHARD_FLOOR,
}) {
  assertIdentity(identity);
  const res = await verifyAndExtract({ r2, identity, role: PREFLIGHT_ROLE, stagingRoot, deps, shardFloor });
  deps.cleanup?.(res.stagingDir); // expose no reusable workspace / mutable payload
  logger.log?.(`[SAT-HANDOFF:preflight] verified ${res.manifest.archive_key} (${res.bytes}B, ${res.registryShardCount} shards) — authority established`);
  return { ok: true, archiveKey: res.manifest.archive_key, registryShardCount: res.registryShardCount, inventorySha256: res.manifest.inventory_sha256, manifest: res.manifest };
}

// Consumer: one of the four satellites, INDEPENDENTLY. Trusts ONLY its own verified
// staging — never a peer workspace/boolean, Persist success alone, mutable state,
// prior attempt/cycle, or prefix/latest lookup.
export async function consumeSatelliteHandoff({
  r2, identity, consumerRole, stagingRoot,
  deps = productionConsumerDeps(), clock = Date, logger = console, shardFloor = REGISTRY_SHARD_FLOOR,
}) {
  assertIdentity(identity);
  assertConsumerRoleKnown(consumerRole);
  const res = await verifyAndExtract({ r2, identity, role: consumerRole, stagingRoot, deps, shardFloor });
  logger.log?.(`[SAT-HANDOFF:consume:${consumerRole}] verified + extracted ${res.manifest.archive_key} -> ${res.treeDir}`);
  return res;
}

// ============================================================================
// Recovery guidance (NEVER the generic "rerun failed jobs") — DUPLICATED policy
// ============================================================================
export function satelliteGraphRecoveryGuidance({ producerConclusion, missingProducersInFailedSet, rerunLimitConsumed } = {}) {
  let verdict; let detail;
  if (rerunLimitConsumed) {
    verdict = 'NO_RERUN';
    detail = 'Deterministic producer failure and the rerun limit is consumed — recompute a fresh cycle; do not re-run.';
  } else if (producerConclusion === 'success') {
    verdict = 'RERUN_ALL';
    detail = 'Persist reported success but the authoritative R2 satellite handoff is absent — re-run the ENTIRE workflow so Persist re-establishes current-attempt authority.';
  } else if (missingProducersInFailedSet) {
    verdict = 'FAILED_JOBS_RERUN';
    detail = 'Every producer whose authoritative output is missing is in the failed set — re-running the failed producer jobs reconstructs current-attempt authority.';
  } else {
    verdict = 'RERUN_ALL';
    detail = 'Current-attempt authority cannot be reconstructed from the failed set alone — re-run the ENTIRE workflow.';
  }
  const message = `[SAT-HANDOFF-RECOVERY] verdict=${verdict}: ${detail}`;
  if (message.includes(FORBIDDEN_RERUN_PHRASE)) throw new SatelliteHandoffError('RECOVERY_GUIDANCE_INVALID', 'generic rerun phrase leaked');
  return { verdict, detail, message };
}

// ============================================================================
// Production dependency wiring (real fs / tar / R2). NOT exercised by tests.
// ============================================================================
export function productionProducerDeps() {
  return {
    scanRegistry: realScanRegistry,
    ensureDir: realEnsureDir,
    realpathDir: realRealpathDir,
    freeBytes: realFreeBytes,
    buildArchive: realBuildArchive,
    hashFile: realHashFile,
    listArchiveEntries: realListArchiveEntries,
  };
}
export function productionConsumerDeps() {
  return {
    prepareCleanStaging: realPrepareCleanStaging,
    download: realDownload,
    hashFile: realHashFile,
    listArchiveEntries: realListArchiveEntries,
    extract: realExtract,
    scanExtractedRegistry: realScanExtractedRegistry,
    cleanup: realCleanup,
  };
}

function realScanRegistry(workspaceDir) {
  const dir = path.resolve(workspaceDir, REGISTRY_ROOT);
  if (!fs.existsSync(dir)) fail('MISSING_PAYLOAD_ROOT', `required payload root does not exist: ${REGISTRY_ROOT}/`);
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) fail('SOURCE_SYMLINK_MEMBER', `symlink in registry: ${name}`);
    if (st.isDirectory()) fail('SOURCE_UNEXPECTED_FILE', `unexpected subdirectory in registry: ${name}`);
    if (st.isFile()) files.push({ path: `${REGISTRY_ROOT}/${name}`.replace(/\\/g, '/'), size: st.size });
  }
  return files;
}
function realScanExtractedRegistry(treeDir) { return realScanRegistry(treeDir); }

function realEnsureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function realRealpathDir(dir) {
  const real = fs.realpathSync(dir);
  if (!fs.statSync(real).isDirectory()) fail('HANDOFF_ARCHIVE_PARENT_NOT_DIR', `archive parent ${real} is not a directory`);
  return real;
}
function realFreeBytes(dir) { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); }

function realBuildArchive(archivePath, cwd, roots) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const args = [...DETERMINISTIC_TAR_ARGS, '-cf', archivePath, '--', ...roots];
  const r = spawnSync('tar', args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) fail('ARCHIVE_BUILD_FAILED', `tar exited ${r.status}${r.error ? ' ' + r.error.message : ''}`);
  if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size === 0) fail('ARCHIVE_BUILD_FAILED', 'archive missing/empty after tar');
}

function realHashFile(filePath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  let bytes = 0; let n;
  try { while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { h.update(buf.subarray(0, n)); bytes += n; } }
  finally { fs.closeSync(fd); }
  return { bytes, sha256: h.digest('hex') };
}

function realPrepareCleanStaging(stagingDir, treeDir) {
  const tmpRoot = process.env.RUNNER_TEMP || os.tmpdir();
  const abs = path.resolve(stagingDir);
  if (!(abs + path.sep).startsWith(path.resolve(tmpRoot) + path.sep)) fail('HANDOFF_STAGING_INVALID', `staging ${abs} escapes temp root ${tmpRoot}`);
  if (fs.existsSync(stagingDir)) {
    const st = fs.lstatSync(stagingDir);
    if (st.isSymbolicLink()) fail('HANDOFF_STAGING_INVALID', 'staging root is a symlink');
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  fs.mkdirSync(treeDir, { recursive: true });
}
function realCleanup(stagingDir) { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ } }

async function realDownload(r2, key, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await r2.getObjectToFile(key, dest);
}

function realListArchiveEntries(archivePath) {
  const r = spawnSync('tar', ['--use-compress-program=zstd -d', '-tvf', archivePath], { encoding: 'utf-8', maxBuffer: 1 << 28 });
  if (r.status !== 0) fail('HANDOFF_UNSAFE_ARCHIVE', `tar list exited ${r.status}`);
  const entries = [];
  for (const line of String(r.stdout).split('\n')) {
    if (!line.trim()) continue;
    const typeChar = line[0];
    const type = typeChar === 'd' ? 'dir' : typeChar === 'l' ? 'symlink' : typeChar === 'h' ? 'hardlink' : 'file';
    // "<mode> <owner>/<group> <size> YYYY-MM-DD HH:MM[:SS] <name>[ -> <target>]"
    const m = line.match(/^\S+\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.*)$/);
    let size = 0; let rest;
    if (m) { size = Number(m[1]); rest = m[2]; }
    else { const m2 = line.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.*)$/); rest = m2 ? m2[1] : line.slice(line.lastIndexOf(' ') + 1); }
    let name = rest; let linkTarget = '';
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) { name = rest.slice(0, arrow); linkTarget = rest.slice(arrow + 4); }
    entries.push({ name: name.replace(/\/$/, ''), type, size, linkTarget });
  }
  return entries;
}

function realExtract(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['--use-compress-program=zstd -d', '-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) fail('HANDOFF_EXTRACT_FAILED', `tar extract exited ${r.status}`);
}

// ============================================================================
// Real R2 adapter + CLI runners (workflow-facing; wired by r2-workflow-cli.js).
// ============================================================================
export async function createProductionR2Adapter(env = process.env) {
  const { createR2Client } = await import('./lib/r2-helpers.js');
  const s3 = createR2Client();
  const bucket = env.R2_BUCKET;
  if (!s3 || !bucket) fail('MISSING_R2_CREDENTIALS', 'R2 credentials/bucket not projected at step level');
  const sdk = await import('@aws-sdk/client-s3');
  const notFound = (e) => new SatelliteHandoffError('R2_OBJECT_NOT_FOUND', e?.name || 'not found');
  const isMissing = (e) => e && (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404);
  return {
    async uploadFile(key, filePath, contentType) {
      const { Upload } = await import('@aws-sdk/lib-storage');
      const body = fs.createReadStream(filePath);
      try {
        await new Upload({ client: s3, params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType }, partSize: 64 * 1024 * 1024 }).done();
      } catch (e) { fail('HANDOFF_UPLOAD_FAILED', e.message); }
    },
    async putObject(key, body, contentType) {
      try { await s3.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })); }
      catch (e) { fail('HANDOFF_MANIFEST_WRITE_FAILED', e.message); }
    },
    async headObject(key) {
      try { const r = await s3.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: key })); return { size: Number(r.ContentLength), etag: r.ETag }; }
      catch (e) { if (isMissing(e)) throw notFound(e); throw e; }
    },
    async getObjectBuffer(key) {
      try {
        const r = await s3.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = []; for await (const c of r.Body) chunks.push(c); return Buffer.concat(chunks);
      } catch (e) { if (isMissing(e)) throw notFound(e); throw e; }
    },
    async getObjectToFile(key, dest) {
      try {
        const r = await s3.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
        await new Promise((res, rej) => { const ws = fs.createWriteStream(dest); r.Body.pipe(ws); r.Body.on('error', rej); ws.on('error', rej); ws.on('finish', res); });
      } catch (e) { if (isMissing(e)) throw notFound(e); throw e; }
    },
  };
}

export function identityFromEnv(env = process.env) {
  return assertIdentity({
    cycleId: env.CYCLE_ID,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    producerMainSha: env.PRODUCER_MAIN_SHA || env.GITHUB_SHA,
  });
}

function handoffTempBase(env, identity) {
  const tmp = env.RUNNER_TEMP || os.tmpdir();
  return path.join(tmp, 'free2aitools-satellite-handoff', identity.runId, identity.runAttempt);
}

export async function runSatelliteEstablishCli(env = process.env) {
  const identity = identityFromEnv(env);
  const r2 = await createProductionR2Adapter(env);
  const workspaceDir = env.GITHUB_WORKSPACE || process.cwd();
  const archivePath = path.join(handoffTempBase(env, identity), ARCHIVE_BASENAME);
  const handoffTempRoot = env.RUNNER_TEMP || os.tmpdir();
  try {
    const res = await establishSatelliteHandoff({ r2, identity, workspaceDir, archivePath, handoffTempRoot });
    console.log(`[SAT-HANDOFF] authoritative satellite handoff established: ${res.archiveKey} (${res.registryShardCount} shards)`);
  } catch (e) {
    console.error(`::error::${PRODUCER_TERMINAL} — ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}

export async function runSatellitePreflightCli(env = process.env) {
  const identity = identityFromEnv(env);
  const r2 = await createProductionR2Adapter(env);
  const stagingRoot = path.join(env.RUNNER_TEMP || os.tmpdir(), 'free2aitools-satellite-handoff-preflight');
  try {
    const res = await preflightSatelliteHandoff({ r2, identity, stagingRoot });
    console.log(`[SAT-HANDOFF] preflight verified authority: ${res.archiveKey} (${res.registryShardCount} shards)`);
  } catch (e) {
    console.error(`::error::${PREFLIGHT_TERMINAL} — ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}

export async function runSatelliteConsumeCli(env = process.env, argv = []) {
  const roleArg = (argv || []).find((a) => a.startsWith('--role='));
  const consumerRole = roleArg ? roleArg.slice('--role='.length) : '';
  const identity = identityFromEnv(env);
  const r2 = await createProductionR2Adapter(env);
  const stagingRoot = path.join(env.RUNNER_TEMP || os.tmpdir(), 'free2aitools-satellite-handoff');
  try {
    const res = await consumeSatelliteHandoff({ r2, identity, consumerRole, stagingRoot });
    exposeRegistryToWorkspace(res.treeDir, env.GITHUB_WORKSPACE || process.cwd());
    // The downloaded archive is a local temp copy; drop it to reclaim disk. This
    // does NOT touch any R2 object (no in-workflow R2 deletion).
    try { fs.rmSync(res.archiveDest, { force: true }); } catch { /* best effort */ }
    console.log(`[SAT-HANDOFF] consumed + exposed ${REGISTRY_ROOT} for ${consumerRole}`);
  } catch (e) {
    console.error(`::error::${CONSUMER_TERMINAL} — ${e.message}`);
    const g = satelliteGraphRecoveryGuidance({ producerConclusion: 'success' });
    console.error(g.message);
    process.exitCode = 1;
    throw e;
  }
}

function exposeRegistryToWorkspace(treeDir, workspaceDir) {
  const src = path.join(treeDir, REGISTRY_ROOT);
  if (!fs.existsSync(src)) fail('HANDOFF_EXPOSE_FAILED', `verified tree missing ${REGISTRY_ROOT}/`);
  const dest = path.join(workspaceDir, REGISTRY_ROOT);
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync('cp', ['-a', src + '/.', dest + '/'], { stdio: 'inherit' });
  if (r.status !== 0) fail('HANDOFF_EXPOSE_FAILED', `cp of ${REGISTRY_ROOT}/ into workspace exited ${r.status}`);
}
