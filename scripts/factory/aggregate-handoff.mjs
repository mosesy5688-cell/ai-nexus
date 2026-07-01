// scripts/factory/aggregate-handoff.mjs
//
// Authoritative R2 attempt-scoped handoff for the Factory 3/4 Aggregate
// Compute -> {Persist, Finalize} intra-cycle "core" seam.
// Amendment authorized under Founder D-209 (as amended by D-211/D-212/D-213/D-214).
//
// The GHA `actions/cache` core-handoff is REMOVED from this seam; the R2 manifest
// is the SINGLE SOURCE OF TRUTH. This module is a pure, injectable library:
//   * every external effect (R2, disk probe, archive build, hashing, extraction,
//     clock) is a swappable dependency, so the whole contract is exercised by
//     scripts/factory/aggregate-handoff.test.mjs WITHOUT any real network / tar.
//   * the CLI wrapper (scripts/factory/r2-workflow-cli.js `handoff-establish` /
//     `handoff-consume`) wires the REAL dependencies at workflow runtime.
//
// Contract references below cite the amendment proposal sections (§G producer,
// §H R2 identity, §I manifest, §J dual-consumer, §K anti-vacuity, §L credentials,
// §M object lifetime).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// ============================================================================
// Frozen contract constants (§H identity, §I manifest, §D archive command)
// ============================================================================

export const SCHEMA_VERSION = 1;
export const HANDOFF_PREFIX_ROOT = 'internal-handoff/aggregate';
export const ARCHIVE_BASENAME = 'handoff.tar.zst';
export const MANIFEST_BASENAME = 'manifest.json';
export const PAYLOAD_ROOTS = ['output', 'cache', 'artifacts'];
export const DISK_HEADROOM_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB (§C invariant)
export const COMPLETION_STATE = 'complete';

// EXACT fixed workflow order (D-212 §K erratum: NOT lexically sorted). Validation
// requires this exact array — no wildcard / generic / 3rd / optional / duplicate /
// reversed member (§I / §J).
export const ALLOWED_CONSUMERS = Object.freeze(['merge-core-persist', 'finalize']);

// The singular `expected_consumer` field (D-209 §J draft) is SUPERSEDED and MUST
// NOT be present in a valid manifest (D-211 §G).
export const FORBIDDEN_MANIFEST_FIELDS = Object.freeze(['expected_consumer']);

// §G recovery guidance must NEVER emit the generic incident phrase.
export const FORBIDDEN_RERUN_PHRASE = 'Re-run failed jobs';

// Deterministic archive command (proposal §Q.4 / D-211 §E). Kept as data so the
// test suite can assert the exact argv and the real builder shares one source.
export const DETERMINISTIC_TAR_ARGS = Object.freeze([
  '--sort=name',
  '--mtime=UTC 1970-01-01',
  '--owner=0',
  '--group=0',
  '--numeric-owner',
  '--pax-option=delete=atime,delete=ctime',
  '--use-compress-program=zstd -T0 -3',
]);

// Terminal producer verdict surfaced to the workflow when authority is not
// established (§F). Compute goes RED; neither consumer becomes eligible.
export const PRODUCER_TERMINAL =
  'AUTHORITATIVE_HANDOFF_NOT_ESTABLISHED / COMPUTE_RED / CONSUMERS_NOT_ELIGIBLE';
export const CONSUMER_TERMINAL =
  'UNAUTHORIZED_OR_UNVERIFIED_HANDOFF / EXECUTION_INVALID / ZERO_WRITES';

// ============================================================================
// Errors
// ============================================================================

export class HandoffError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'HandoffError';
    this.code = code;
  }
}
function fail(code, message) { throw new HandoffError(code, message); }

// A regular 64-char lowercase hex sha256. A multipart R2 ETag (e.g. "ab12-50")
// can NEVER satisfy this — this is the structural guard against ever treating an
// ETag as a sha256 (§K "accept multipart ETag as SHA-256").
const SHA256_RE = /^[0-9a-f]{64}$/;
export function isSha256Hex(v) { return typeof v === 'string' && SHA256_RE.test(v); }

// ============================================================================
// Identity + key derivation (§H)
// ============================================================================

const IDENTITY_FIELDS = ['cycleId', 'runId', 'runAttempt', 'producerMainSha'];

// Every identity component must be a present, non-empty, single-segment token —
// this alone forbids a mutable shared "latest" key, an empty/inferred prefix, and
// any path-injection into the R2 namespace (§H).
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

// Role-specific, distinct staging path (§J step 9 / D-211 §J). Two consumers can
// NEVER share a staging path — the role is a mandatory path segment.
export function consumerStagingDir(stagingRoot, identity, consumerRole) {
  assertIdentity(identity);
  assertConsumerRoleKnown(consumerRole);
  return path.join(stagingRoot, identity.runId, identity.runAttempt, consumerRole);
}

// A consumer_role is a FIXED workflow config value, never caller/user input; it
// must be one of the exact allowed roles (§J step 1).
export function assertConsumerRoleKnown(consumerRole) {
  if (!ALLOWED_CONSUMERS.includes(consumerRole)) {
    fail('UNAUTHORIZED_HANDOFF_CONSUMER', `role "${consumerRole}" is not a configured consumer`);
  }
  return consumerRole;
}

// ============================================================================
// Manifest build + validation (§I)
// ============================================================================

// inventory_sha256 = hash over a canonical sorted payload inventory (§I: NOT a
// circular self-hash of the manifest bytes).
export function inventorySha256(inventory) {
  const canonical = [...inventory]
    .map((e) => [String(e.path), Number(e.size)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function buildManifest({ identity, workflowIdentity, archiveBytes, archiveSha256, inventory, createdAtUtc }) {
  assertIdentity(identity);
  if (!Number.isInteger(archiveBytes) || archiveBytes <= 0) fail('MANIFEST_BUILD_INVALID', 'archiveBytes must be positive int');
  if (!isSha256Hex(archiveSha256)) fail('MANIFEST_BUILD_INVALID', 'archiveSha256 must be sha256 hex');
  return {
    schema_version: SCHEMA_VERSION,
    cycle_id: identity.cycleId,
    github_run_id: identity.runId,
    github_run_attempt: identity.runAttempt,
    producer_main_sha: identity.producerMainSha,
    workflow_identity: String(workflowIdentity || ''),
    archive_key: archiveKeyFor(identity),
    archive_bytes: archiveBytes,
    archive_sha256: archiveSha256,
    inventory_sha256: inventorySha256(inventory),
    created_at_utc: createdAtUtc,
    allowed_consumers: [...ALLOWED_CONSUMERS],
    completion_state: COMPLETION_STATE,
  };
}

// EXACT closed-set equality: same length, same members, SAME ORDER (§I / §J).
function allowedConsumersExact(arr) {
  return Array.isArray(arr)
    && arr.length === ALLOWED_CONSUMERS.length
    && arr.every((v, i) => v === ALLOWED_CONSUMERS[i]);
}

// Full manifest validation shared by the producer re-verify and BOTH consumers.
// Returns the parsed manifest or throws the precise terminal code. Performs ZERO
// side effects (§J: validate before any write).
export function validateManifest(manifest, identity) {
  assertIdentity(identity);
  if (!manifest || typeof manifest !== 'object') fail('HANDOFF_MANIFEST_MALFORMED', 'not an object');
  for (const f of FORBIDDEN_MANIFEST_FIELDS) {
    if (f in manifest) fail('HANDOFF_MANIFEST_MALFORMED', `superseded field "${f}" present`);
  }
  if (manifest.schema_version !== SCHEMA_VERSION) fail('HANDOFF_MANIFEST_MALFORMED', 'schema_version mismatch');
  if (manifest.completion_state !== COMPLETION_STATE) fail('HANDOFF_MANIFEST_INCOMPLETE', `completion_state="${manifest.completion_state}"`);
  if (!allowedConsumersExact(manifest.allowed_consumers)) {
    fail('HANDOFF_MANIFEST_MALFORMED', 'allowed_consumers is not the exact fixed [merge-core-persist, finalize] array');
  }
  // Frozen identity must match the CURRENT attempt exactly — this rejects a
  // prior-attempt, wrong-run, wrong-cycle, cross-cycle or wrong-producer-SHA
  // manifest (§J steps 4-5 / §K).
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
  return manifest;
}

// ============================================================================
// Archive location + payload safety (§D / §J extraction safety)
// ============================================================================

// The archive MUST live OUTSIDE every payload root, else tar would recurse into
// its own growing output (§K "archive created inside output/").
export function assertArchiveOutsidePayloadRoots(archivePath, workspaceDir) {
  const abs = path.resolve(archivePath);
  for (const root of PAYLOAD_ROOTS) {
    const rootAbs = path.resolve(workspaceDir, root) + path.sep;
    if ((abs + path.sep).startsWith(rootAbs)) {
      fail('ARCHIVE_INSIDE_PAYLOAD_ROOT', `archive ${abs} is inside payload root ${root}`);
    }
  }
}

// The archive parent must stay INSIDE the RUNNER_TEMP handoff root before it is
// created/probed (D-217 §F step 2/5). Same confinement style as staging
// (realPrepareCleanStaging): `..` traversal and absolute-outside paths are
// rejected; passing the realpath here also rejects a symlinked escape.
export function assertArchiveParentConfined(archiveParent, handoffTempRoot) {
  const rootAbs = path.resolve(handoffTempRoot);
  const abs = path.resolve(archiveParent);
  if (abs !== rootAbs && !(abs + path.sep).startsWith(rootAbs + path.sep)) {
    fail('HANDOFF_ARCHIVE_PARENT_ESCAPE', `archive parent ${abs} escapes handoff temp root ${rootAbs}`);
  }
  return abs;
}

// Reject absolute members, ".." traversal, and symlink/hardlink escapes BEFORE
// extraction (§J steps 10-12 / D-211 §J). `entries` = [{ name, type, linkTarget }].
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
      // Resolve the link target relative to the member's own directory and forbid
      // any escape above the archive root.
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name.replace(/\\/g, '/')), tgt.replace(/\\/g, '/')));
      if (resolved.startsWith('..')) fail('HANDOFF_UNSAFE_ARCHIVE', `escaping link: ${name} -> ${tgt}`);
    }
  }
  return true;
}

// Every payload root must be present as a top-level member (§J step 13 / §G step 2).
export function assertRequiredRootsPresent(entries) {
  const tops = new Set(
    entries.map((e) => String(e.name).replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0]).filter(Boolean),
  );
  for (const root of PAYLOAD_ROOTS) {
    if (!tops.has(root)) fail('HANDOFF_MISSING_ROOT', `archive is missing required payload root: ${root}/`);
  }
  return true;
}

// ============================================================================
// Producer: establish authoritative handoff (§G / §F)
// ============================================================================
//
// Ordered exactly per §G. ANY failure throws -> the caller makes Compute RED and
// NO manifest exists (it is written LAST), so no consumer can become eligible.
export async function establishHandoff({
  r2, identity, workflowIdentity, workspaceDir, archivePath,
  deps = productionProducerDeps(), clock = Date, logger = console,
  handoffTempRoot = process.env.RUNNER_TEMP || os.tmpdir(),
}) {
  assertIdentity(identity);
  const log = (m) => logger.log?.(`[HANDOFF:establish] ${m}`);

  // 1. resolve the archive parent directory (D-217 §F step 1).
  const archiveParent = path.dirname(archivePath);
  // 2. the archive (hence its parent) MUST live OUTSIDE every payload root, else
  //    we would create/probe a directory inside tar's own growing output (§K).
  assertArchiveOutsidePayloadRoots(archivePath, workspaceDir);
  // 3. path confinement: the parent MUST stay inside the RUNNER_TEMP handoff root
  //    (reject `..` traversal / absolute-outside) BEFORE creating anything (§F.2).
  assertArchiveParentConfined(archiveParent, handoffTempRoot);
  // 4. create the parent (idempotent, recursive) — this MUST happen BEFORE any
  //    disk-free (statfs) probe, or real fs throws ENOENT on a non-existent path
  //    (D-217 root cause: statfs of the not-yet-created parent). (§F.3)
  deps.ensureDir(archiveParent);
  // 5. confirm the created path is a real directory and re-confine after symlink
  //    resolution: a symlinked parent escaping the temp root is rejected (§F.4).
  const realParent = deps.realpathDir(archiveParent);
  assertArchiveParentConfined(realParent, handoffTempRoot);
  // 6. record free disk on the now-existing parent + temp fs (§F.5).
  const destFree = deps.freeBytes(realParent);
  const tempFree = deps.freeBytes(workspaceDir);
  // 7. logical source bytes + confirm all three roots exist (missing = fatal) (§F.6).
  const scan = deps.scanPayload(workspaceDir, PAYLOAD_ROOTS); // throws MISSING_PAYLOAD_ROOT
  log(`logical=${scan.logicalBytes}B destFree=${destFree}B tempFree=${tempFree}B`);
  // 8. enforce FREE_BYTES >= LOGICAL_SOURCE_BYTES + 8 GiB, else Compute RED (§F.7).
  const required = scan.logicalBytes + DISK_HEADROOM_BYTES;
  if (destFree < required) {
    fail('INSUFFICIENT_RUNNER_DISK_FOR_HANDOFF_ARCHIVE', `need ${required}B free, have ${destFree}B`);
  }
  // 9. build deterministic tar+zstd (parent already exists; its own recursive
  //    mkdir is now idempotent), close before hashing (§F.8).
  deps.buildArchive(archivePath, workspaceDir, PAYLOAD_ROOTS); // throws ARCHIVE_BUILD_FAILED
  // 9. compute exact compressed bytes + sha256 locally from the closed archive.
  const { bytes: archiveBytes, sha256: archiveSha256 } = deps.hashFile(archivePath);
  if (!isSha256Hex(archiveSha256)) fail('ARCHIVE_HASH_INVALID', 'local sha256 malformed');
  const archiveKey = archiveKeyFor(identity);
  // 10. upload via multipart R2.
  await r2.uploadFile(archiveKey, archivePath, 'application/octet-stream'); // throws HANDOFF_UPLOAD_FAILED
  // 11. verify uploaded identity WITHOUT treating multipart ETag as sha256:
  //     HeadObject byte-count must equal the locally computed bytes.
  const head = await r2.headObject(archiveKey);
  if (Number(head.size) !== archiveBytes) {
    fail('HANDOFF_UPLOAD_VERIFY_FAILED', `uploaded size ${head.size} != local ${archiveBytes}`);
  }
  // 12. write the immutable manifest LAST.
  const manifest = buildManifest({
    identity, workflowIdentity, archiveBytes, archiveSha256,
    inventory: scan.inventory, createdAtUtc: new Date(clock.now()).toISOString(),
  });
  const manifestKey = manifestKeyFor(identity);
  await r2.putObject(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json'); // HANDOFF_MANIFEST_WRITE_FAILED
  // 13. refetch + verify the manifest.
  const refetched = JSON.parse((await r2.getObjectBuffer(manifestKey)).toString('utf-8'));
  validateManifest(refetched, identity);
  if (refetched.archive_bytes !== archiveBytes || refetched.archive_sha256 !== archiveSha256) {
    fail('MANIFEST_REVERIFY_FAILED', 'refetched manifest archive identity drifted');
  }
  // 14. green ONLY now that R2 authority is fully established + re-verified.
  log(`established ${archiveKey} (${archiveBytes}B) + manifest`);
  return { ok: true, archiveKey, manifestKey, archiveBytes, archiveSha256, manifest };
}

// ============================================================================
// Consumer: verify + extract (§J) — Persist and Finalize each INDEPENDENTLY.
// ============================================================================
//
// Preserves ZERO writes to the exposed tree on EVERY invalid state: `extract` is
// only reached after ALL of manifest/identity/byte/sha/safety verification pass.
export async function consumeHandoff({
  r2, identity, consumerRole, stagingRoot,
  deps = productionConsumerDeps(), clock = Date, logger = console,
}) {
  assertIdentity(identity);
  // 1. fixed workflow-configured consumer role.
  assertConsumerRoleKnown(consumerRole);
  const log = (m) => logger.log?.(`[HANDOFF:consume:${consumerRole}] ${m}`);

  // 2. load the CURRENT-attempt manifest (never a peer/cache/secondary manifest).
  const manifestKey = manifestKeyFor(identity);
  let manifestBuf;
  try {
    manifestBuf = await r2.getObjectBuffer(manifestKey);
  } catch (e) {
    if (e && e.code === 'R2_OBJECT_NOT_FOUND') fail('HANDOFF_MANIFEST_MISSING', `no manifest at ${manifestKey}`);
    throw e;
  }
  let manifest;
  try { manifest = JSON.parse(manifestBuf.toString('utf-8')); }
  catch { fail('HANDOFF_MANIFEST_MALFORMED', 'manifest is not valid JSON'); }
  // 3-5. validate exact consumer array + own role membership + identity.
  validateManifest(manifest, identity);
  if (!manifest.allowed_consumers.includes(consumerRole)) {
    fail('UNAUTHORIZED_HANDOFF_CONSUMER', `role "${consumerRole}" not in allowed_consumers`);
  }

  // 9(prep). clean, role-specific staging path — no shared mutable path.
  const stagingDir = consumerStagingDir(stagingRoot, identity, consumerRole);
  const archiveDest = path.join(stagingDir, ARCHIVE_BASENAME);
  const treeDir = path.join(stagingDir, 'tree');
  deps.prepareCleanStaging(stagingDir, treeDir);

  // 6. download the EXACT archive.
  const archiveKey = manifest.archive_key;
  try {
    await deps.download(r2, archiveKey, archiveDest);
  } catch (e) {
    if (e && e.code === 'R2_OBJECT_NOT_FOUND') fail('HANDOFF_ARCHIVE_MISSING', `no archive at ${archiveKey}`);
    throw e;
  }
  // 7-8. recompute byte count + sha256 and match the manifest.
  const { bytes, sha256 } = deps.hashFile(archiveDest);
  if (bytes !== manifest.archive_bytes) fail('HANDOFF_BYTE_MISMATCH', `downloaded ${bytes}B != manifest ${manifest.archive_bytes}B`);
  if (sha256 !== manifest.archive_sha256) fail('HANDOFF_SHA_MISMATCH', 'downloaded sha256 != manifest sha256');

  // 10-13. extraction safety + required roots, evaluated on the entry list BEFORE
  // any file is written into the exposed tree.
  const entries = deps.listArchiveEntries(archiveDest);
  validateArchiveEntries(entries);
  assertRequiredRootsPresent(entries);

  // 14. expose the verified tree ONLY AFTER verification.
  deps.extract(archiveDest, treeDir);
  deps.verifyExtractedRoots(treeDir, PAYLOAD_ROOTS);
  log(`verified + extracted ${archiveKey} (${bytes}B) -> ${treeDir}`);
  return { ok: true, treeDir, stagingDir, archiveDest, bytes, sha256, manifest };
}

// ============================================================================
// §G producer-graph recovery guidance (NEVER the generic "rerun failed jobs")
// ============================================================================
export function producerGraphRecoveryGuidance({ producerConclusion, missingProducersInFailedSet, rerunLimitConsumed } = {}) {
  let verdict, detail;
  if (rerunLimitConsumed) {
    verdict = 'NO_RERUN';
    detail = 'Deterministic producer failure and the rerun limit is consumed — recompute a fresh cycle; do not re-run.';
  } else if (producerConclusion === 'success') {
    // Producer stayed green but authority is missing => it was FALSELY green or
    // provenance cannot be reconstructed => a partial "failed-jobs" rerun is WRONG.
    verdict = 'RERUN_ALL';
    detail = 'Producer (merge-core-compute) reported success but authoritative R2 handoff is absent — re-run the ENTIRE workflow so the producer re-establishes current-attempt authority.';
  } else if (missingProducersInFailedSet) {
    verdict = 'FAILED_JOBS_RERUN';
    detail = 'Every producer whose authoritative output is missing is in the failed set — re-running the failed producer jobs reconstructs current-attempt authority.';
  } else {
    verdict = 'RERUN_ALL';
    detail = 'Current-attempt authority cannot be reconstructed from the failed set alone — re-run the ENTIRE workflow.';
  }
  const message = `[HANDOFF-RECOVERY] verdict=${verdict}: ${detail}`;
  if (message.includes(FORBIDDEN_RERUN_PHRASE)) throw new HandoffError('RECOVERY_GUIDANCE_INVALID', 'generic rerun phrase leaked');
  return { verdict, detail, message };
}

// ============================================================================
// Production dependency wiring (real fs / tar / R2). NOT exercised by tests —
// tests inject fakes. No network occurs at import time.
// ============================================================================

export function productionProducerDeps() {
  return {
    scanPayload: realScanPayload,
    ensureDir: realEnsureDir,
    realpathDir: realRealpathDir,
    freeBytes: realFreeBytes,
    buildArchive: realBuildArchive,
    hashFile: realHashFile,
  };
}
export function productionConsumerDeps() {
  return {
    prepareCleanStaging: realPrepareCleanStaging,
    download: realDownload,
    hashFile: realHashFile,
    listArchiveEntries: realListArchiveEntries,
    extract: realExtract,
    verifyExtractedRoots: realVerifyExtractedRoots,
  };
}

function realScanPayload(workspaceDir, roots) {
  const inventory = [];
  let logicalBytes = 0;
  for (const root of roots) {
    const rootAbs = path.resolve(workspaceDir, root);
    if (!fs.existsSync(rootAbs)) fail('MISSING_PAYLOAD_ROOT', `required payload root does not exist: ${root}/`);
    const stack = [rootAbs];
    while (stack.length) {
      const cur = stack.pop();
      const st = fs.lstatSync(cur);
      if (st.isDirectory()) { for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name)); }
      else if (st.isFile()) { logicalBytes += st.size; inventory.push({ path: path.relative(workspaceDir, cur).replace(/\\/g, '/'), size: st.size }); }
    }
  }
  return { logicalBytes, inventory };
}

// Create the archive parent recursively BEFORE the disk-free probe (D-217 §F.3).
// Idempotent: a pre-existing directory is left untouched.
function realEnsureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Resolve symlinks and confirm the created path is really a directory (D-217
// §F.4). Callers re-confine the returned realpath so a symlinked escape above the
// handoff temp root is rejected. Throws ENOENT if the path does not exist.
function realRealpathDir(dir) {
  const real = fs.realpathSync(dir);
  if (!fs.statSync(real).isDirectory()) {
    fail('HANDOFF_ARCHIVE_PARENT_NOT_DIR', `archive parent ${real} is not a directory`);
  }
  return real;
}

function realFreeBytes(dir) {
  const st = fs.statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

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
  let bytes = 0, n;
  try { while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { h.update(buf.subarray(0, n)); bytes += n; } }
  finally { fs.closeSync(fd); }
  return { bytes, sha256: h.digest('hex') };
}

function realPrepareCleanStaging(stagingDir, treeDir) {
  const tmpRoot = process.env.RUNNER_TEMP || os.tmpdir();
  const abs = path.resolve(stagingDir);
  if (!(abs + path.sep).startsWith(path.resolve(tmpRoot) + path.sep)) {
    fail('HANDOFF_STAGING_INVALID', `staging ${abs} escapes temp root ${tmpRoot}`);
  }
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
    // Name begins after the "YYYY-MM-DD HH:MM " timestamp field.
    const m = line.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.*)$/);
    let rest = m ? m[1] : line.slice(line.lastIndexOf(' ') + 1);
    let name = rest, linkTarget = '';
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) { name = rest.slice(0, arrow); linkTarget = rest.slice(arrow + 4); }
    entries.push({ name: name.replace(/\/$/, ''), type, linkTarget });
  }
  return entries;
}

function realExtract(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['--use-compress-program=zstd -d', '-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) fail('HANDOFF_EXTRACT_FAILED', `tar extract exited ${r.status}`);
}

function realVerifyExtractedRoots(treeDir, roots) {
  for (const root of roots) {
    if (!fs.existsSync(path.join(treeDir, root))) fail('HANDOFF_MISSING_ROOT', `extracted tree missing ${root}/`);
  }
}

// ============================================================================
// Real R2 adapter + CLI runners (workflow-facing; wired by r2-workflow-cli.js).
// ============================================================================

// Missing credentials fail BEFORE any upload/download and carry a DISTINCT code
// from any content-integrity failure (§L).
export async function createProductionR2Adapter(env = process.env) {
  const { createR2Client } = await import('./lib/r2-helpers.js');
  const s3 = createR2Client();
  const bucket = env.R2_BUCKET;
  if (!s3 || !bucket) fail('MISSING_R2_CREDENTIALS', 'R2 credentials/bucket not projected at step level');
  const sdk = await import('@aws-sdk/client-s3');
  const notFound = (e) => { const err = new HandoffError('R2_OBJECT_NOT_FOUND', e?.name || 'not found'); return err; };
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
  return path.join(tmp, 'free2aitools-aggregate-handoff', identity.runId, identity.runAttempt);
}

export async function runHandoffEstablishCli(env = process.env) {
  const identity = identityFromEnv(env);
  const r2 = await createProductionR2Adapter(env);
  const workspaceDir = env.GITHUB_WORKSPACE || process.cwd();
  const archivePath = path.join(handoffTempBase(env, identity), ARCHIVE_BASENAME);
  const handoffTempRoot = env.RUNNER_TEMP || os.tmpdir();
  try {
    const res = await establishHandoff({ r2, identity, workflowIdentity: env.GITHUB_WORKFLOW || 'Factory 3/4 - Aggregate', workspaceDir, archivePath, handoffTempRoot });
    console.log(`[HANDOFF] authoritative handoff established: ${res.archiveKey}`);
  } catch (e) {
    console.error(`::error::${PRODUCER_TERMINAL} — ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}

export async function runHandoffConsumeCli(env = process.env, argv = []) {
  const roleArg = argv.find((a) => a.startsWith('--role='));
  const consumerRole = roleArg ? roleArg.slice('--role='.length) : '';
  const identity = identityFromEnv(env);
  const r2 = await createProductionR2Adapter(env);
  const stagingRoot = path.join(env.RUNNER_TEMP || os.tmpdir(), 'free2aitools-aggregate-handoff');
  try {
    const res = await consumeHandoff({ r2, identity, consumerRole, stagingRoot });
    // Expose the verified tree at the workspace root for the downstream steps.
    exposeTreeToWorkspace(res.treeDir, env.GITHUB_WORKSPACE || process.cwd());
    // The downloaded archive is a local temp copy; drop it to reclaim disk. This
    // does NOT touch any R2 object (§M: no in-workflow R2 deletion).
    try { fs.rmSync(res.archiveDest, { force: true }); } catch { /* best effort */ }
    console.log(`[HANDOFF] consumed + exposed core for ${consumerRole}`);
  } catch (e) {
    console.error(`::error::${CONSUMER_TERMINAL} — ${e.message}`);
    const g = producerGraphRecoveryGuidance({ producerConclusion: 'success' });
    console.error(g.message);
    process.exitCode = 1;
    throw e;
  }
}

function exposeTreeToWorkspace(treeDir, workspaceDir) {
  for (const root of PAYLOAD_ROOTS) {
    const src = path.join(treeDir, root);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(workspaceDir, root);
    fs.mkdirSync(dest, { recursive: true });
    const r = spawnSync('cp', ['-a', src + '/.', dest + '/'], { stdio: 'inherit' });
    if (r.status !== 0) fail('HANDOFF_EXPOSE_FAILED', `cp of ${root}/ into workspace exited ${r.status}`);
  }
}
