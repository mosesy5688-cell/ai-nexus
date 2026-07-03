// scripts/factory/harvest-authoritative-handoff.mjs
//
// Authoritative R2 attempt-scoped HARVEST source-authority handoff for the
// Factory 1/4 Harvest producers -> Merge & Upload seam. Replaces the ephemeral
// GHA-cache carrier with an R2-authoritative, attempt-scoped, manifest-last
// handoff so a GitHub "Re-run failed jobs" (which reruns ONLY Merge as a new
// attempt, leaving the four already-successful producers at the prior attempt)
// can safely recover the producers' data.
//
// Authorized under Founder D-2026-0703-236 + D-2026-0703-237. Binding design
// record: FREE2AITOOLS_BACKEND_HARVEST_R2_AUTHORITATIVE_HANDOFF_AMENDMENT_
// PROPOSAL_v1 (§0-§14). Section citations below reference that proposal.
//
// C1 CONTRACT ISOLATION VIA DUPLICATION: this module is SELF-CONTAINED. It does
// NOT import from aggregate-handoff.mjs (the D-219 core) or from
// satellite-registry-handoff.mjs (the D-228/D-230 satellite). The stateless,
// contract-free primitives it needs (HandoffError, isSha256Hex, path-safety,
// deterministic-tar argv, inventory hashing) are DUPLICATED so a future core /
// satellite refactor can never perturb this contract.
//
// Every external effect (R2, disk probe, archive build, hashing, extraction,
// clock, GHA probe, workspace union) is an injectable dependency, so the whole
// contract is exercised by harvest-authoritative-handoff.test.mjs WITHOUT any
// real network / tar / @aws-sdk. The CLI wrapper (r2-workflow-cli.js
// harvest-handoff-establish / harvest-handoff-consume) wires the REAL deps.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// ============================================================================
// Frozen contract constants (§2 identity / §3 namespace / §4 membership)
// ============================================================================

export const SCHEMA_VERSION = 1;
export const CARRIER_TYPE = 'harvest-source-authority';        // §3 field, frozen
export const HANDOFF_PREFIX_ROOT = 'internal-handoff/harvest'; // §3, distinct root
export const MANIFEST_BASENAME = 'manifest.json';
export const COMPLETION_STATE = 'complete';
export const DATA_ROOT = 'data';                               // payload root
export const STATE_ROOT = 'data/state';                        // sidecar root
export const DISK_HEADROOM_BYTES = 8 * 1024 * 1024 * 1024;     // 8 GiB (mirror D-217)

// §2 cycle identity = github.run_id ONLY. No date/cron/branch/upstream/mutable
// derivation, and NO generic cycle_id field is introduced (preferred per D-237
// §G): the R2 prefix + manifest bind github_run_id directly.

// §3 source-role closed set (exact, ordered). Each producer job establishes its
// OWN role authority (4 independent establishes).
export const SOURCE_ROLES = Object.freeze(['huggingface', 'github', 'academic', 'ecosystem']);

// §4 ROLE PAYLOAD MEMBERSHIP CONTRACT — EXPLICIT, hand-derived from
// factory-harvest.yml's `harvest-single.js <source>` invocations, NOT dir-scan-
// derived. Drift-guarded by factory-harvest-handoff-invariant.test.ts (re-parses
// the workflow's invocations and asserts they equal this declared membership).
// REQUIRED (REQUIRED_GATED: absence of `|| echo "skipped"` in the workflow AND
// presence in exported DEFAULT_FLOORS). OPTIONAL (OPTIONAL_TOLERATED: `|| echo`
// AND absent from DEFAULT_FLOORS). Keep each role on ONE line for the text guard.
export const ROLE_MEMBERSHIP = Object.freeze({
  huggingface: Object.freeze({ required: Object.freeze(['huggingface']), optional: Object.freeze([]) }),
  github: Object.freeze({ required: Object.freeze(['github']), optional: Object.freeze([]) }),
  academic: Object.freeze({ required: Object.freeze(['arxiv', 'huggingface-papers', 'huggingface-datasets']), optional: Object.freeze([]) }),
  ecosystem: Object.freeze({ required: Object.freeze(['semanticscholar']), optional: Object.freeze(['ollama', 'mcp', 'replicate', 'kaggle', 'civitai', 'openllm', 'benchmark', 'deepspec', 'agents']) }),
});

// §4: REQUIRED_WITH_DEGRADED_TERMINAL_ALLOWED = ∅ as a distinct source set. The
// repo has a single required mechanism (floor gate + fail-loud) that ALREADY
// permits a rate-limited/partial terminal that still clears the floor, so
// "degraded terminal above floor" is a PROPERTY of REQUIRED_GATED, not a
// separate list. Documented explicitly (honest classification).

// §6 the sole consumer of a harvest source authority is the Merge job.
export const ALLOWED_CONSUMERS = Object.freeze(['merge']);

// The singular expected_consumer field (core D-209 draft) MUST NOT appear (§3).
export const FORBIDDEN_MANIFEST_FIELDS = Object.freeze(['expected_consumer']);

// Deterministic archive command (§5). Kept as data so the test asserts the exact
// argv and the real builder shares one source. DUPLICATED from core policy.
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
  'AUTHORITATIVE_HARVEST_SOURCE_HANDOFF_NOT_ESTABLISHED / HARVEST_PRODUCER_RED';
export const MERGE_TERMINAL =
  'HARVEST_R2_AUTHORITY_UNRESOLVED / MERGE_RED / ZERO_PUBLICATION';
export const MERGE_VERIFIED_TOKEN = 'FOUR_R2_SOURCE_AUTHORITIES_VERIFIED';

// ============================================================================
// Errors + sha256 guard (DUPLICATED primitives — C1)
// ============================================================================

export class HarvestHandoffError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'HarvestHandoffError';
    this.code = code;
  }
}
function fail(code, message) { throw new HarvestHandoffError(code, message); }

// A regular 64-char lowercase hex sha256. A multipart R2 ETag ("ab12-50") can
// NEVER satisfy this — structural guard against ever treating an ETag as a sha256.
const SHA256_RE = /^[0-9a-f]{64}$/;
export function isSha256Hex(v) { return typeof v === 'string' && SHA256_RE.test(v); }
// producer_main_sha is a git commit sha (40-hex).
const GITSHA_RE = /^[0-9a-f]{40}$/;
export function isGitSha(v) { return typeof v === 'string' && GITSHA_RE.test(v); }

// ============================================================================
// Identity + key derivation (§2 / §3) — cycle identity == github.run_id
// ============================================================================

// The key tuple is (runId, runAttempt, sourceRole) — producer_main_sha is a
// MANIFEST field, NOT a path segment (§3 namespace). Every path component must
// be a present, non-empty, single path-safe segment; this alone forbids a
// mutable "latest" token, an empty/inferred prefix, and any path injection.
const IDENTITY_KEY_FIELDS = ['runId', 'runAttempt', 'sourceRole'];

export function assertIdentity(identity) {
  if (!identity || typeof identity !== 'object') fail('HANDOFF_IDENTITY_INVALID', 'identity object required');
  for (const f of IDENTITY_KEY_FIELDS) assertSegment(identity[f], `identity.${f}`);
  if (!SOURCE_ROLES.includes(identity.sourceRole)) fail('HANDOFF_IDENTITY_INVALID', `unknown source_role "${identity.sourceRole}"`);
  return identity;
}

export function assertSegment(v, label) {
  if (typeof v !== 'string' || v.length === 0) fail('HANDOFF_IDENTITY_INVALID', `${label} missing`);
  if (v === 'latest') fail('HANDOFF_IDENTITY_INVALID', `${label} must not be the mutable token "latest"`);
  if (/[/\\]/.test(v) || v.includes('..')) fail('HANDOFF_IDENTITY_INVALID', `${label} must be a single path-safe segment`);
  return v;
}

export function archiveBasenameFor(sourceRole) { return `${sourceRole}.tar.zst`; }

export function buildHandoffPrefix(identity) {
  assertIdentity(identity);
  const { runId, runAttempt, sourceRole } = identity;
  return `${HANDOFF_PREFIX_ROOT}/${runId}/${runAttempt}/${sourceRole}/`;
}
export function archiveKeyFor(identity) { return buildHandoffPrefix(identity) + archiveBasenameFor(identity.sourceRole); }
export function manifestKeyFor(identity) { return buildHandoffPrefix(identity) + MANIFEST_BASENAME; }

// A source_role is a FIXED workflow config literal, never user input.
export function assertSourceRoleKnown(sourceRole) {
  if (!SOURCE_ROLES.includes(sourceRole)) fail('UNKNOWN_SOURCE_ROLE', `role "${sourceRole}" is not a configured source role`);
  return sourceRole;
}

// Role-segmented, distinct staging path — two roles can NEVER share a path.
export function stagingDirFor(stagingRoot, identity) {
  assertIdentity(identity);
  return path.join(stagingRoot, identity.runId, identity.runAttempt, identity.sourceRole);
}

// ============================================================================
// §4 membership derivation + §4 acceptance (authorized ACTUAL member set)
// ============================================================================

export function ownedSourcesFor(sourceRole) {
  assertSourceRoleKnown(sourceRole);
  const m = ROLE_MEMBERSHIP[sourceRole];
  return { required: [...m.required], optional: [...m.optional], all: [...m.required, ...m.optional] };
}

// The exact authorized member PATHS for a role: each owned source's master
// ndjson + its terminal-state sidecar. Deterministic non-aliasing filename rule
// (harvest-single.js:38): data/<source>_master.ndjson ; sidecar
// data/state/harvest-state-<source>.json (§4).
export function requiredMemberPaths(sourceRole) {
  return ownedSourcesFor(sourceRole).required.map((s) => `${DATA_ROOT}/${s}_master.ndjson`).sort();
}
export function authorizedMemberPaths(sourceRole) {
  const owned = ownedSourcesFor(sourceRole).all;
  const paths = [];
  for (const s of owned) {
    paths.push(`${DATA_ROOT}/${s}_master.ndjson`);
    paths.push(`${STATE_ROOT}/harvest-state-${s}.json`);
  }
  return paths;
}

// inventory_sha256 = hash over a canonical sorted [path, bytes, sha256]
// inventory (collision-resistant on content; NOT a self-hash of the manifest).
export function inventorySha256(inventory) {
  const canonical = [...inventory]
    .map((e) => [String(e.path), Number(e.bytes), String(e.sha256)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// Build the ONE authorized-actual snapshot for a role from a scanned data/ file
// list. `files` = [{ path, bytes, sha256 }] (paths under data/ or data/state/).
// Filters to EXACTLY the authorized member paths that exist (benchmark_NNN.json
// and any non-owned file are incidental and EXCLUDED, §4a). Rejects absolute /
// traversal source paths. Then enforces §4 acceptance:
// EXPECTED_REQUIRED_MEMBERS ⊆ ACTUAL_MEMBERS (each required _master.ndjson present).
export function buildRoleSnapshot(sourceRole, files) {
  assertSourceRoleKnown(sourceRole);
  if (!Array.isArray(files)) fail('SOURCE_SNAPSHOT_INVALID', 'files must be an array');
  const authorized = new Set(authorizedMemberPaths(sourceRole));
  const inventory = [];
  const seen = new Set();
  let aggregateBytes = 0;
  for (const f of files) {
    const rawPath = String(f && f.path);
    if (!rawPath || rawPath === 'undefined') fail('SOURCE_UNEXPECTED_FILE', 'entry with no path');
    if (path.isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith('/') || rawPath.startsWith('\\')) {
      fail('SOURCE_ABSOLUTE_PATH', `absolute source path: ${rawPath}`);
    }
    const norm = rawPath.replace(/\\/g, '/');
    if (norm.split('/').some((s) => s === '..')) fail('SOURCE_TRAVERSAL_PATH', `traversal source path: ${rawPath}`);
    if (!authorized.has(norm)) continue; // incidental (e.g. benchmark_NNN.json) — excluded, not archived
    if (seen.has(norm)) fail('SOURCE_DUPLICATE_MEMBER', `duplicate member: ${norm}`);
    const bytes = f && f.bytes;
    if (!Number.isInteger(bytes) || bytes < 0) fail('SOURCE_MEMBER_SIZE_INVALID', `${norm} bytes=${bytes}`);
    if (!isSha256Hex(f && f.sha256)) fail('SOURCE_MEMBER_SHA_INVALID', `${norm} sha256 malformed`);
    seen.add(norm);
    inventory.push({ path: norm, bytes, sha256: f.sha256 });
    aggregateBytes += bytes;
  }
  inventory.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const actualMembers = inventory.map((e) => e.path);
  const expectedRequiredMembers = requiredMemberPaths(sourceRole);
  // §4 acceptance: each required master must be present (non-vacuity is enforced
  // UPSTREAM by the producer floor gate — the handoff invents NO record-count
  // threshold, D-237 §H(1)).
  for (const req of expectedRequiredMembers) {
    if (!seen.has(req)) fail('REQUIRED_MEMBER_MISSING', `required member absent for role ${sourceRole}: ${req}`);
  }
  // §4b absence-as-record: synthesize optional_members[{name, present}] from the
  // frozen optional set (kept in the FROZEN declaration order — deterministic and
  // matching the contract) so an absent optional source is explicitly represented.
  const optionalMembers = ownedSourcesFor(sourceRole).optional
    .map((name) => ({ name, present: seen.has(`${DATA_ROOT}/${name}_master.ndjson`) }));
  return {
    sourceRole,
    inventory,
    memberPaths: actualMembers,
    actualMembers,
    expectedRequiredMembers,
    optionalMembers,
    fileCount: inventory.length,
    aggregateBytes,
    inventorySha256: inventorySha256(inventory),
  };
}

// Source-stability: two snapshots of the SAME source must be EXACTLY equal (§5.7).
export function assertSnapshotsEqual(a, b, code) {
  if (a.fileCount !== b.fileCount || a.aggregateBytes !== b.aggregateBytes || a.inventorySha256 !== b.inventorySha256) {
    fail(code, `source snapshot drift: files ${a.fileCount}->${b.fileCount}, bytes ${a.aggregateBytes}->${b.aggregateBytes}, hash ${a.inventorySha256}!=${b.inventorySha256}`);
  }
  return true;
}

// EXACT member-set equality between two sorted inventories. `withSha`=false
// compares path+bytes only (archive tar listing carries no per-file sha256);
// withSha=true compares path+bytes+sha256 (post-extract re-scan vs manifest).
export function assertInventoriesEqual(a, b, code, { withSha = true } = {}) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) fail(code, `member count ${a && a.length} != ${b && b.length}`);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].path !== b[i].path) fail(code, `member path mismatch: ${a[i].path} vs ${b[i].path}`);
    if (Number(a[i].bytes) !== Number(b[i].bytes)) fail(code, `member bytes mismatch at ${a[i].path}: ${a[i].bytes} vs ${b[i].bytes}`);
    if (withSha && a[i].sha256 !== b[i].sha256) fail(code, `member sha256 mismatch at ${a[i].path}`);
  }
  return true;
}

// ============================================================================
// Manifest build + validation (§3 record requirements + §4 membership evidence)
// ============================================================================

export function buildManifest({ identity, snapshot, archiveBytes, archiveSha256, createdAtUtc }) {
  assertIdentity(identity);
  if (!isGitSha(identity.producerMainSha)) fail('MANIFEST_BUILD_INVALID', 'producerMainSha must be a 40-hex git sha');
  if (!Number.isInteger(archiveBytes) || archiveBytes <= 0) fail('MANIFEST_BUILD_INVALID', 'archiveBytes must be positive int');
  if (!isSha256Hex(archiveSha256)) fail('MANIFEST_BUILD_INVALID', 'archiveSha256 must be sha256 hex');
  return {
    schema_version: SCHEMA_VERSION,
    carrier_type: CARRIER_TYPE,
    github_run_id: identity.runId,
    github_run_attempt: identity.runAttempt,
    producer_main_sha: identity.producerMainSha,
    source_role: identity.sourceRole,
    archive_key: archiveKeyFor(identity),
    archive_bytes: archiveBytes,
    archive_sha256: archiveSha256,
    inventory_sha256: snapshot.inventorySha256,
    file_count: snapshot.fileCount,
    // §3/§6: no replacement record-count floor is invented — null unless a source
    // authoritatively exposes it (it does not today), so ALWAYS null here.
    entity_or_record_count: null,
    completion_state: COMPLETION_STATE,
    created_at_utc: createdAtUtc,
    expected_required_members: [...snapshot.expectedRequiredMembers],
    actual_members: [...snapshot.actualMembers],
    optional_members: snapshot.optionalMembers.map((o) => ({ name: o.name, present: o.present })),
    allowed_consumers: [...ALLOWED_CONSUMERS],
    inventory: snapshot.inventory.map((e) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 })),
  };
}

function allowedConsumersExact(arr) {
  return Array.isArray(arr) && arr.length === ALLOWED_CONSUMERS.length && arr.every((v, i) => v === ALLOWED_CONSUMERS[i]);
}
function sameStringArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

// Validate the manifest inventory array: authorized grammar, strictly sorted,
// bytes/sha256 well-formed, and hash-bound to inventory_sha256 (non-vacuous).
function validateManifestInventory(manifest) {
  const inv = manifest.inventory;
  if (!Array.isArray(inv)) fail('HANDOFF_MANIFEST_MALFORMED', 'inventory is not an array');
  if (inv.length !== manifest.file_count) fail('HANDOFF_MANIFEST_MALFORMED', `inventory length ${inv.length} != file_count ${manifest.file_count}`);
  const authorized = new Set(authorizedMemberPaths(manifest.source_role));
  let prev = null;
  for (const e of inv) {
    if (!e || typeof e !== 'object') fail('HANDOFF_MANIFEST_MALFORMED', 'inventory entry is not an object');
    const p = String(e.path);
    if (!authorized.has(p)) fail('HANDOFF_MANIFEST_MALFORMED', `unexpected inventory member for role ${manifest.source_role}: ${p}`);
    if (!Number.isInteger(e.bytes) || e.bytes < 0) fail('HANDOFF_MANIFEST_MALFORMED', `inventory bytes invalid: ${p}`);
    if (!isSha256Hex(e.sha256)) fail('HANDOFF_MANIFEST_MALFORMED', `inventory sha256 invalid: ${p}`);
    if (prev !== null && !(prev < p)) fail('HANDOFF_MANIFEST_MALFORMED', `inventory not strictly sorted at ${p}`);
    prev = p;
  }
  if (!sameStringArray(inv.map((e) => e.path), [...manifest.actual_members])) {
    fail('HANDOFF_MANIFEST_MALFORMED', 'inventory paths != actual_members');
  }
  if (inventorySha256(inv) !== manifest.inventory_sha256) fail('HANDOFF_MANIFEST_MALFORMED', 'inventory_sha256 does not match the inventory array');
  return true;
}

// Full manifest validation. `expected` = { runId, runAttempt, sourceRole,
// producerMainSha? }. When producerMainSha is provided (normal/current path) the
// manifest sha must equal it; when omitted (skip_harvest exact tuple — the source
// run's sha is not an input) the sha is only checked well-formed and cross-role
// agreement is enforced by the resolver. ZERO side effects.
export function validateManifest(manifest, expected) {
  if (!expected || typeof expected !== 'object') fail('HANDOFF_IDENTITY_INVALID', 'expected identity required');
  for (const f of IDENTITY_KEY_FIELDS) assertSegment(expected[f], `expected.${f}`);
  assertSourceRoleKnown(expected.sourceRole);
  if (!manifest || typeof manifest !== 'object') fail('HANDOFF_MANIFEST_MALFORMED', 'not an object');
  for (const f of FORBIDDEN_MANIFEST_FIELDS) {
    if (f in manifest) fail('HANDOFF_MANIFEST_MALFORMED', `superseded field "${f}" present`);
  }
  // §2: no independent cycle_id authority. If a cycle_id field ever appears it
  // MUST equal String(github_run_id) — never an independent identity.
  if ('cycle_id' in manifest && manifest.cycle_id !== String(manifest.github_run_id)) {
    fail('HANDOFF_MANIFEST_MALFORMED', 'cycle_id is not String(github_run_id)');
  }
  if (manifest.schema_version !== SCHEMA_VERSION) fail('HANDOFF_MANIFEST_MALFORMED', 'schema_version mismatch');
  if (manifest.carrier_type !== CARRIER_TYPE) fail('HANDOFF_MANIFEST_MALFORMED', `carrier_type="${manifest.carrier_type}"`);
  if (manifest.completion_state !== COMPLETION_STATE) fail('HANDOFF_MANIFEST_INCOMPLETE', `completion_state="${manifest.completion_state}"`);
  if (!allowedConsumersExact(manifest.allowed_consumers)) fail('HANDOFF_MANIFEST_MALFORMED', 'allowed_consumers is not the exact frozen [merge] array');
  if (!SOURCE_ROLES.includes(manifest.source_role)) fail('HANDOFF_MANIFEST_MALFORMED', `unknown source_role "${manifest.source_role}"`);
  if (manifest.source_role !== expected.sourceRole) fail('HANDOFF_IDENTITY_MISMATCH', `source_role="${manifest.source_role}" expected="${expected.sourceRole}"`);
  if (manifest.github_run_id !== expected.runId) fail('HANDOFF_IDENTITY_MISMATCH', `github_run_id="${manifest.github_run_id}" expected="${expected.runId}"`);
  if (manifest.github_run_attempt !== expected.runAttempt) fail('HANDOFF_IDENTITY_MISMATCH', `github_run_attempt="${manifest.github_run_attempt}" expected="${expected.runAttempt}"`);
  if (!isGitSha(manifest.producer_main_sha)) fail('HANDOFF_MANIFEST_MALFORMED', 'producer_main_sha is not a git sha');
  if (expected.producerMainSha != null && manifest.producer_main_sha !== expected.producerMainSha) {
    fail('HANDOFF_IDENTITY_MISMATCH', `producer_main_sha="${manifest.producer_main_sha}" expected="${expected.producerMainSha}"`);
  }
  if (manifest.archive_key !== archiveKeyFor(expected)) fail('HANDOFF_IDENTITY_MISMATCH', 'archive_key does not match attempt prefix');
  if (!Number.isInteger(manifest.archive_bytes) || manifest.archive_bytes <= 0) fail('HANDOFF_MANIFEST_MALFORMED', 'archive_bytes invalid');
  if (!isSha256Hex(manifest.archive_sha256)) fail('HANDOFF_MANIFEST_MALFORMED', 'archive_sha256 is not a sha256 (multipart ETag rejected)');
  if (!isSha256Hex(manifest.inventory_sha256)) fail('HANDOFF_MANIFEST_MALFORMED', 'inventory_sha256 is not a sha256');
  if (manifest.entity_or_record_count !== null && !(Number.isInteger(manifest.entity_or_record_count) && manifest.entity_or_record_count >= 0)) {
    fail('HANDOFF_MANIFEST_MALFORMED', 'entity_or_record_count must be null or a non-negative int');
  }
  // §4 membership contract bound INTO the manifest: expected_required_members and
  // optional_members must equal the FROZEN contract for the role (removing a
  // configured required Academic/Ecosystem member or tampering optional set reds).
  if (!sameStringArray(manifest.expected_required_members, requiredMemberPaths(manifest.source_role))) {
    fail('HANDOFF_MANIFEST_MALFORMED', 'expected_required_members != frozen role contract');
  }
  const expectedOptionalNames = ownedSourcesFor(manifest.source_role).optional;
  const optNames = Array.isArray(manifest.optional_members) ? manifest.optional_members.map((o) => o && o.name) : null;
  if (!sameStringArray(optNames, expectedOptionalNames)) fail('HANDOFF_MANIFEST_MALFORMED', 'optional_members names != frozen role contract');
  for (const o of manifest.optional_members) {
    if (typeof o.present !== 'boolean') fail('HANDOFF_MANIFEST_MALFORMED', `optional_members.present not boolean for ${o.name}`);
  }
  if (!Array.isArray(manifest.actual_members)) fail('HANDOFF_MANIFEST_MALFORMED', 'actual_members is not an array');
  for (const req of manifest.expected_required_members) {
    if (!manifest.actual_members.includes(req)) fail('HANDOFF_MANIFEST_MALFORMED', `required member absent from actual_members: ${req}`);
  }
  validateManifestInventory(manifest);
  return manifest;
}

// ============================================================================
// Archive location + payload safety (§5 / §6 extraction safety) — DUPLICATED
// ============================================================================

export function assertArchiveOutsidePayloadRoots(archivePath, workspaceDir) {
  const abs = path.resolve(archivePath);
  const rootAbs = path.resolve(workspaceDir, DATA_ROOT) + path.sep;
  if ((abs + path.sep).startsWith(rootAbs)) fail('ARCHIVE_INSIDE_PAYLOAD_ROOT', `archive ${abs} is inside payload root ${DATA_ROOT}`);
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

// The archive must carry at least one data/ master member (§6).
export function assertDataRootPresent(entries) {
  const has = entries.some((e) => /^(\.\/)?data\/[^/]+_master\.ndjson$/.test(String(e.name).replace(/\\/g, '/')));
  if (!has) fail('HANDOFF_MISSING_ROOT', `archive has no ${DATA_ROOT}/*_master.ndjson member`);
  return true;
}

// Build a sorted [{path,bytes}] inventory of the FILE members of a listed archive
// (directory members excluded). Used for the pre-extraction member-set check.
export function archiveInventoryFromEntries(entries) {
  const inv = [];
  for (const e of entries) {
    if (!e || e.type === 'dir') continue;
    const name = String(e.name).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    inv.push({ path: name, bytes: Number(e.size) });
  }
  return inv.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ============================================================================
// Producer: establish authoritative harvest source authority (§5, manifest-last)
// ============================================================================
export async function establishHarvestHandoff({
  r2, identity, workspaceDir, archivePath,
  deps = productionProducerDeps(), clock = Date, logger = console,
  handoffTempRoot = process.env.RUNNER_TEMP || os.tmpdir(),
}) {
  assertIdentity(identity);
  if (!isGitSha(identity.producerMainSha)) fail('HANDOFF_IDENTITY_INVALID', 'producerMainSha must be a 40-hex git sha');
  const role = identity.sourceRole;
  const log = (m) => logger.log?.(`[HARVEST-HANDOFF:establish:${role}] ${m}`);

  // 1-2. archive parent OUTSIDE data/, confined to RUNNER_TEMP; ensureDir BEFORE
  //      any statfs probe (D-217), then re-confine after realpath.
  const archiveParent = path.dirname(archivePath);
  assertArchiveOutsidePayloadRoots(archivePath, workspaceDir);
  assertArchiveParentConfined(archiveParent, handoffTempRoot);
  deps.ensureDir(archiveParent);
  const realParent = deps.realpathDir(archiveParent);
  assertArchiveParentConfined(realParent, handoffTempRoot);

  // 3. EXACT source snapshot #1 (pre-archive) + §4 acceptance.
  const snapshot1 = buildRoleSnapshot(role, deps.scanData(workspaceDir));
  log(`source snapshot: ${snapshot1.fileCount} members, ${snapshot1.aggregateBytes}B`);

  // 4. disk headroom on the now-existing parent.
  const destFree = deps.freeBytes(realParent);
  const required = snapshot1.aggregateBytes + DISK_HEADROOM_BYTES;
  if (destFree < required) fail('INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_ARCHIVE', `need ${required}B free, have ${destFree}B`);

  // 5. C6 IMMUTABILITY / FAIL-CLOSED collision: check BOTH keys before establishing.
  const archiveKey = archiveKeyFor(identity);
  const manifestKey = manifestKeyFor(identity);
  if (await objectExists(r2, manifestKey)) fail('AUTHORITY_COLLISION', `manifest already exists at ${manifestKey} — immutable tuple, no overwrite`);
  if (await objectExists(r2, archiveKey)) fail('ORPHANED_PARTIAL_AUTHORITY_COLLISION', `archive exists without manifest at ${archiveKey} — fail closed`);

  // 6. deterministic tar+zstd of EXACTLY the authorized members.
  deps.buildArchive(archivePath, workspaceDir, snapshot1.memberPaths);

  // 7. source-stability rescan #2; must equal #1.
  const snapshot2 = buildRoleSnapshot(role, deps.scanData(workspaceDir));
  assertSnapshotsEqual(snapshot1, snapshot2, 'SOURCE_CHANGED_DURING_AUTHORITY_ESTABLISHMENT');

  // 8. archive bytes + sha256; safety; member set == snapshot (path+bytes).
  const { bytes: archiveBytes, sha256: archiveSha256 } = deps.hashFile(archivePath);
  if (!isSha256Hex(archiveSha256)) fail('ARCHIVE_HASH_INVALID', 'local sha256 malformed');
  const entries = deps.listArchiveEntries(archivePath);
  validateArchiveEntries(entries);
  assertDataRootPresent(entries);
  assertInventoriesEqual(archiveInventoryFromEntries(entries), snapshot1.inventory.map((e) => ({ path: e.path, bytes: e.bytes })), 'ARCHIVE_MEMBER_SET_MISMATCH', { withSha: false });

  // 9. multipart upload, verify byte-count via HeadObject (ETag NEVER trusted).
  await r2.uploadFile(archiveKey, archivePath, 'application/octet-stream');
  const head = await r2.headObject(archiveKey);
  if (Number(head.size) !== archiveBytes) fail('HANDOFF_UPLOAD_VERIFY_FAILED', `uploaded size ${head.size} != local ${archiveBytes}`);

  // 10. write the immutable manifest LAST (derived from the STABLE snapshot #1).
  const manifest = buildManifest({ identity, snapshot: snapshot1, archiveBytes, archiveSha256, createdAtUtc: new Date(clock.now()).toISOString() });
  await r2.putObject(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');

  // 11. read-back: GetObject manifest, full validate, assert refetched == local.
  const refetched = JSON.parse((await r2.getObjectBuffer(manifestKey)).toString('utf-8'));
  validateManifest(refetched, identity);
  if (refetched.archive_bytes !== archiveBytes || refetched.archive_sha256 !== archiveSha256
    || refetched.inventory_sha256 !== snapshot1.inventorySha256 || refetched.file_count !== snapshot1.fileCount) {
    fail('MANIFEST_REVERIFY_FAILED', 'refetched manifest evidence drifted');
  }
  log(`established ${archiveKey} (${archiveBytes}B, ${snapshot1.fileCount} members) + manifest LAST`);
  return { ok: true, archiveKey, manifestKey, archiveBytes, archiveSha256, inventorySha256: snapshot1.inventorySha256, fileCount: snapshot1.fileCount, manifest };
}

async function objectExists(r2, key) {
  try { await r2.headObject(key); return true; }
  catch (e) { if (e && e.code === 'R2_OBJECT_NOT_FOUND') return false; throw e; }
}

// ============================================================================
// §6 MERGE AUTHORITY RESOLUTION — bounded prior-attempt recovery
// ============================================================================

function parseAttempt(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail('HANDOFF_IDENTITY_INVALID', `run_attempt must be a positive integer, got "${v}"`);
  return n;
}

// Probe ALL four role authorities at one exact (runId, attempt). Non-throwing on
// per-role validity: a present-but-invalid manifest marks the role invalid (and
// records the first error) rather than throwing, so the resolver can decide.
async function probeAttempt({ r2, runId, attempt, producerMainSha, deps }) {
  const manifests = {};
  let presentCount = 0; let validCount = 0; let firstError = null;
  for (const role of SOURCE_ROLES) {
    const expected = { runId, runAttempt: attempt, sourceRole: role, producerMainSha };
    const mk = manifestKeyFor(expected);
    let buf;
    try { buf = await deps.getManifestBuffer(r2, mk); }
    catch (e) { if (e && e.code === 'R2_OBJECT_NOT_FOUND') { manifests[role] = null; continue; } throw e; }
    presentCount += 1;
    try {
      const m = JSON.parse(buf.toString('utf-8'));
      validateManifest(m, expected);
      manifests[role] = m; validCount += 1;
    } catch (e) { manifests[role] = { __invalid: true }; if (!firstError) firstError = e; }
  }
  return { presentCount, validCount, manifests, firstError };
}

// Cross-role consistency: all four manifests carry ONE identical run_id +
// run_attempt + producer_main_sha + schema (§6(2) "one identical run_id + one
// identical producer attempt"). Rejects mixed attempts / mixed run_ids.
export function assertManifestsConsistent(manifests) {
  const roles = SOURCE_ROLES.filter((r) => manifests[r] && !manifests[r].__invalid);
  if (roles.length !== SOURCE_ROLES.length) fail('HARVEST_MERGE_INCOMPLETE_ROLE_SET', `roles present: ${roles.join(',')}`);
  const ref = manifests[SOURCE_ROLES[0]];
  for (const r of SOURCE_ROLES) {
    const m = manifests[r];
    if (m.source_role !== r) fail('HARVEST_MIXED_AUTHORITY', `role ${r} manifest carries source_role ${m.source_role}`);
    if (m.github_run_id !== ref.github_run_id) fail('HARVEST_MIXED_AUTHORITY', `mixed github_run_id across roles`);
    if (m.github_run_attempt !== ref.github_run_attempt) fail('HARVEST_MIXED_AUTHORITY', `mixed github_run_attempt across roles`);
    if (m.producer_main_sha !== ref.producer_main_sha) fail('HARVEST_MIXED_AUTHORITY', `mixed producer_main_sha across roles`);
    if (m.schema_version !== ref.schema_version) fail('HARVEST_MIXED_AUTHORITY', `mixed schema_version across roles`);
  }
  return true;
}

// §6 current-attempt-first, bounded descending same-run prior-attempt recovery.
export async function resolveCurrentRun({ r2, runId, currentAttempt, producerMainSha, deps, logger = console }) {
  assertSegment(runId, 'runId');
  if (producerMainSha != null && !isGitSha(producerMainSha)) fail('HANDOFF_IDENTITY_INVALID', 'producerMainSha must be a git sha');
  const currentN = parseAttempt(currentAttempt);
  const cur = await probeAttempt({ r2, runId, attempt: currentAttempt, producerMainSha, deps });
  if (cur.presentCount === 0) {
    // (2) CURRENT EMPTY -> bounded DESCENDING search of same-run prior attempts.
    for (let a = currentN - 1; a >= 1; a -= 1) {
      const prior = await probeAttempt({ r2, runId, attempt: String(a), producerMainSha, deps });
      if (prior.presentCount === 4 && prior.validCount === 4) {
        assertManifestsConsistent(prior.manifests);
        logger.log?.(`[HARVEST-RESOLVE] current attempt ${currentAttempt} EMPTY; recovered highest prior complete attempt ${a} (same run ${runId})`);
        return { selectedAttempt: String(a), manifests: prior.manifests, mode: 'HIGHEST_PRIOR_COMPLETE_ATTEMPT_OF_SAME_RUN' };
      }
    }
    fail('HARVEST_MERGE_NO_COMPLETE_ATTEMPT', `run ${runId}: current attempt ${currentAttempt} empty and no bounded prior complete attempt`);
  }
  if (cur.presentCount < 4) {
    // (3) CURRENT PARTIAL -> fail-closed, NO prior fallback.
    fail('HARVEST_MERGE_CURRENT_PARTIAL', `run ${runId} attempt ${currentAttempt}: ${cur.presentCount}/4 authorities — a partial rerun must not consume an earlier set`);
  }
  if (cur.validCount < 4) fail(cur.firstError.code, cur.firstError.message); // corrupt current authority
  assertManifestsConsistent(cur.manifests);
  return { selectedAttempt: currentAttempt, manifests: cur.manifests, mode: 'CURRENT_ATTEMPT' };
}

// §7 skip_harvest EXACT tuple: consume ONLY the one (source_run_id,
// source_run_attempt); require all four; NO prior/latest/prefix/cross-run.
export async function resolveExactTuple({ r2, runId, runAttempt, deps, logger = console }) {
  assertSegment(runId, 'source_run_id');
  assertSegment(runAttempt, 'source_run_attempt');
  const probe = await probeAttempt({ r2, runId, attempt: runAttempt, producerMainSha: undefined, deps });
  if (probe.presentCount < 4) fail('HARVEST_MERGE_SOURCE_INCOMPLETE', `skip_harvest tuple ${runId}/${runAttempt}: ${probe.presentCount}/4 authorities present`);
  if (probe.validCount < 4) fail(probe.firstError.code, probe.firstError.message);
  assertManifestsConsistent(probe.manifests);
  logger.log?.(`[HARVEST-RESOLVE] skip_harvest exact tuple ${runId}/${runAttempt}: 4/4 authorities verified`);
  return { selectedAttempt: runAttempt, manifests: probe.manifests, mode: 'EXACT_TUPLE' };
}

// ============================================================================
// §6/§8 per-role verify + safe extract + union (GHA optional, R2-verified)
// ============================================================================
async function verifyExtractUnion({ r2, manifest, identity, stagingRoot, workspaceDir, deps, logger, ghaAccel }) {
  const role = identity.sourceRole;
  validateManifest(manifest, identity);
  const log = (m) => logger.log?.(`[HARVEST-HANDOFF:consume:${role}] ${m}`);

  // §8 GHA acceleration: a GHA-restored payload already in data/ is USED only if
  // it matches the selected R2 manifest identity+bytes+inventory (GHA_EXACT_MATCH).
  // GHA_MISS / GHA_MISMATCH -> discard + download the EXACT R2 archive. GHA_MISS is
  // NEVER MERGE_RED unless the exact R2 authority is also missing/invalid.
  if (ghaAccel && deps.ghaProbe) {
    const status = deps.ghaProbe(workspaceDir, manifest.inventory);
    if (status === 'GHA_EXACT_MATCH') { log('GHA_EXACT_MATCH — verified byte+sha against R2 manifest; no R2 download'); return { ok: true, role, source: 'gha', ghaStatus: status, manifest }; }
    log(`GHA ${status} — downloading + verifying the exact R2 authority`);
  }

  const stagingDir = stagingDirFor(stagingRoot, identity);
  const archiveDest = path.join(stagingDir, archiveBasenameFor(role));
  const treeDir = path.join(stagingDir, 'tree');
  deps.prepareCleanStaging(stagingDir, treeDir);

  // Consumer-side disk-headroom preflight (review FIX 4): on the cold-GHA merge-only
  // recovery path each of the four roles downloads + extracts a full R2 archive. Fail
  // CLOSED here — BEFORE download/extract — if this role's archive + margin would not
  // fit, so a mid-extract ENOSPC can never silently corrupt the merge input under the
  // append-only growth mandate. Distinct code from any producer/content-integrity code.
  const requiredFree = manifest.archive_bytes + DISK_HEADROOM_BYTES;
  const freeBytes = deps.freeBytes(stagingDir);
  if (freeBytes < requiredFree) fail('INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_CONSUME', `role ${role}: need ${requiredFree}B free, have ${freeBytes}B`);

  const archiveKey = manifest.archive_key;
  try { await deps.download(r2, archiveKey, archiveDest); }
  catch (e) { if (e && e.code === 'R2_OBJECT_NOT_FOUND') fail('HANDOFF_ARCHIVE_MISSING', `no archive at ${archiveKey}`); throw e; }

  const { bytes, sha256 } = deps.hashFile(archiveDest);
  if (bytes !== manifest.archive_bytes) fail('HANDOFF_BYTE_MISMATCH', `downloaded ${bytes}B != manifest ${manifest.archive_bytes}B`);
  if (sha256 !== manifest.archive_sha256) fail('HANDOFF_SHA_MISMATCH', 'downloaded sha256 != manifest sha256');

  const entries = deps.listArchiveEntries(archiveDest);
  validateArchiveEntries(entries);
  assertDataRootPresent(entries);
  assertInventoriesEqual(archiveInventoryFromEntries(entries), manifest.inventory.map((e) => ({ path: e.path, bytes: e.bytes })), 'ARCHIVE_MEMBER_SET_MISMATCH', { withSha: false });

  // extract, then INDEPENDENTLY re-scan + re-verify member set + per-file sha256
  // + count + inventory hash (post-extraction proof) BEFORE union.
  deps.extract(archiveDest, treeDir);
  const extracted = [...deps.scanExtracted(treeDir)].sort((a, b) => (a.path < b.path ? -1 : 1));
  if (extracted.length !== manifest.file_count) fail('HANDOFF_FILE_COUNT_MISMATCH', `extracted ${extracted.length} != manifest ${manifest.file_count}`);
  assertInventoriesEqual(extracted, manifest.inventory, 'HANDOFF_INVENTORY_MISMATCH', { withSha: true });
  if (inventorySha256(extracted) !== manifest.inventory_sha256) fail('HANDOFF_INVENTORY_MISMATCH', 'extracted inventory hash != manifest inventory_sha256');

  deps.unionIntoWorkspace(treeDir, manifest.inventory.map((e) => e.path), workspaceDir);
  // review FIX 4: drop THIS role's archive + extracted tree immediately after union,
  // so peak disk stays bounded to ONE role's archive+tree (not four resident at once).
  // Mirrors satellite-registry-handoff cleanup; never touches any R2 object.
  deps.cleanup?.(stagingDir);
  log(`verified + extracted ${archiveKey} (${bytes}B, ${extracted.length} members) -> data/ (staging dropped)`);
  return { ok: true, role, source: 'r2', treeDir, stagingDir, archiveDest, manifest };
}

// Orchestrate the full Merge-side resolve + 4-role sequential consume + union.
// Throws on ANY failure (fail-closed); prints FOUR_R2_SOURCE_AUTHORITIES_VERIFIED
// only after all four roles are verified. `env` selects the mode (§7/§6).
export async function resolveAndConsumeHarvest({ r2, env, deps = productionConsumerDeps(), workspaceDir, stagingRoot, logger = console, ghaAccel = true }) {
  const skip = env.SKIP_HARVEST === 'true';
  let selection;
  if (skip) {
    selection = await resolveExactTuple({ r2, runId: env.SOURCE_RUN_ID, runAttempt: env.SOURCE_RUN_ATTEMPT, deps, logger });
  } else {
    selection = await resolveCurrentRun({ r2, runId: env.GITHUB_RUN_ID, currentAttempt: env.GITHUB_RUN_ATTEMPT, producerMainSha: env.PRODUCER_MAIN_SHA || env.GITHUB_SHA, deps, logger });
  }
  // Sequential per role (disk headroom): each archive downloaded to role-isolated
  // staging, safe-extracted, post-extract re-verified, unioned into data/.
  for (const role of SOURCE_ROLES) {
    const m = selection.manifests[role];
    const identity = { runId: m.github_run_id, runAttempt: m.github_run_attempt, sourceRole: role, producerMainSha: m.producer_main_sha };
    await verifyExtractUnion({ r2, manifest: m, identity, stagingRoot, workspaceDir, deps, logger, ghaAccel });
  }
  logger.log?.(`[HARVEST-RESOLVE] ${MERGE_VERIFIED_TOKEN} — selected attempt ${selection.selectedAttempt} (${selection.mode})`);
  return { ok: true, selectedAttempt: selection.selectedAttempt, mode: selection.mode };
}

// ============================================================================
// Production dependency wiring (real fs / tar / R2). NOT exercised by tests.
// ============================================================================
export function productionProducerDeps() {
  return {
    scanData: realScanData,
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
    getManifestBuffer: async (r2, key) => r2.getObjectBuffer(key),
    freeBytes: realFreeBytes,
    prepareCleanStaging: realPrepareCleanStaging,
    download: realDownload,
    hashFile: realHashFile,
    listArchiveEntries: realListArchiveEntries,
    extract: realExtract,
    scanExtracted: realScanExtracted,
    unionIntoWorkspace: realUnionIntoWorkspace,
    cleanup: realCleanup,
    ghaProbe: realGhaProbe,
  };
}

// Scan data/*_master.ndjson + data/state/harvest-state-*.json with per-file
// sha256 (the incidental benchmark_NNN.json shards + non-owned files are filtered
// downstream by buildRoleSnapshot). Symlinks rejected.
function realScanData(workspaceDir) {
  const out = [];
  const scanDir = (relDir, filter) => {
    const abs = path.resolve(workspaceDir, relDir);
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs)) {
      const full = path.join(abs, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) fail('SOURCE_SYMLINK_MEMBER', `symlink in ${relDir}: ${name}`);
      if (!st.isFile()) continue;
      if (!filter(name)) continue;
      out.push({ path: `${relDir}/${name}`.replace(/\\/g, '/'), bytes: st.size, sha256: realHashFile(full).sha256 });
    }
  };
  scanDir(DATA_ROOT, (n) => n.endsWith('_master.ndjson'));
  scanDir(STATE_ROOT, (n) => /^harvest-state-.+\.json$/.test(n));
  return out;
}
function realScanExtracted(treeDir) {
  const out = [];
  const scanDir = (relDir, filter) => {
    const abs = path.resolve(treeDir, relDir);
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs)) {
      const full = path.join(abs, name);
      const st = fs.lstatSync(full);
      if (!st.isFile()) continue;
      if (!filter(name)) continue;
      out.push({ path: `${relDir}/${name}`.replace(/\\/g, '/'), bytes: st.size, sha256: realHashFile(full).sha256 });
    }
  };
  scanDir(DATA_ROOT, (n) => n.endsWith('_master.ndjson'));
  scanDir(STATE_ROOT, (n) => /^harvest-state-.+\.json$/.test(n));
  return out;
}

function realEnsureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function realRealpathDir(dir) {
  const real = fs.realpathSync(dir);
  if (!fs.statSync(real).isDirectory()) fail('HANDOFF_ARCHIVE_PARENT_NOT_DIR', `archive parent ${real} is not a directory`);
  return real;
}
function realFreeBytes(dir) { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); }

function realBuildArchive(archivePath, cwd, memberPaths) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const args = [...DETERMINISTIC_TAR_ARGS, '-cf', archivePath, '--', ...memberPaths];
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

// Union the verified extracted members into the workspace data/ tree (disjoint
// basenames across roles). Overwrites any GHA_MISMATCH copy with the R2-verified
// bytes. Never deletes any R2 object.
function realUnionIntoWorkspace(treeDir, memberPaths, workspaceDir) {
  for (const rel of memberPaths) {
    const src = path.join(treeDir, rel);
    if (!fs.existsSync(src)) fail('HANDOFF_EXPOSE_FAILED', `verified tree missing ${rel}`);
    const dest = path.join(workspaceDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// review FIX 4: drop a consumed role's staging (archive + extracted tree) after its
// union so peak disk stays bounded to one role at a time. Best-effort; local temp
// only — never an R2 object.
function realCleanup(stagingDir) { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ } }

// GHA match probe: for each manifest inventory member, compare the workspace
// data/ copy's bytes+sha256. All present+match -> GHA_EXACT_MATCH; any missing ->
// GHA_MISS; any present-but-different -> GHA_MISMATCH.
function realGhaProbe(workspaceDir, inventory) {
  let anyMissing = false;
  for (const e of inventory) {
    const full = path.join(workspaceDir, e.path);
    if (!fs.existsSync(full)) { anyMissing = true; continue; }
    const { bytes, sha256 } = realHashFile(full);
    if (bytes !== e.bytes || sha256 !== e.sha256) return 'GHA_MISMATCH';
  }
  return anyMissing ? 'GHA_MISS' : 'GHA_EXACT_MATCH';
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
  const notFound = (e) => new HarvestHandoffError('R2_OBJECT_NOT_FOUND', e?.name || 'not found');
  const isMissing = (e) => e && (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404);
  return {
    async uploadFile(key, filePath, contentType) {
      const { Upload } = await import('@aws-sdk/lib-storage');
      const body = fs.createReadStream(filePath);
      try { await new Upload({ client: s3, params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType }, partSize: 64 * 1024 * 1024 }).done(); }
      catch (e) { fail('HANDOFF_UPLOAD_FAILED', e.message); }
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

export function establishIdentityFromEnv(env = process.env, argv = []) {
  const roleArg = (argv || []).find((a) => a.startsWith('--role='));
  const sourceRole = roleArg ? roleArg.slice('--role='.length) : '';
  return assertIdentity({
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    sourceRole,
    producerMainSha: env.PRODUCER_MAIN_SHA || env.GITHUB_SHA,
  });
}

function handoffTempBase(env, identity) {
  const tmp = env.RUNNER_TEMP || os.tmpdir();
  return path.join(tmp, 'free2aitools-harvest-handoff', identity.runId, identity.runAttempt, identity.sourceRole);
}

export async function runHarvestEstablishCli(env = process.env, argv = []) {
  const identity = establishIdentityFromEnv(env, argv);
  const r2 = await createProductionR2Adapter(env);
  const workspaceDir = env.GITHUB_WORKSPACE || process.cwd();
  const archivePath = path.join(handoffTempBase(env, identity), archiveBasenameFor(identity.sourceRole));
  const handoffTempRoot = env.RUNNER_TEMP || os.tmpdir();
  try {
    const res = await establishHarvestHandoff({ r2, identity, workspaceDir, archivePath, handoffTempRoot });
    console.log(`[HARVEST-HANDOFF] authoritative source authority established: ${res.archiveKey} (${res.fileCount} members)`);
  } catch (e) {
    console.error(`::error::${PRODUCER_TERMINAL} — ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}

export async function runHarvestConsumeCli(env = process.env) {
  const r2 = await createProductionR2Adapter(env);
  const workspaceDir = env.GITHUB_WORKSPACE || process.cwd();
  const stagingRoot = path.join(env.RUNNER_TEMP || os.tmpdir(), 'free2aitools-harvest-handoff-consume');
  try {
    const res = await resolveAndConsumeHarvest({ r2, env, workspaceDir, stagingRoot });
    console.log(`[HARVEST-HANDOFF] ${MERGE_VERIFIED_TOKEN} — attempt ${res.selectedAttempt} (${res.mode})`);
  } catch (e) {
    console.error(`::error::${MERGE_TERMINAL} — ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}
