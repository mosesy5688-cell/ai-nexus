#!/usr/bin/env node
// D-403 STEP 2: TARGET-ISOLATED handoff completion carrier.
//
// One run completes exactly ONE target (P or F) with its own FRESH 44-minute
// budget measured from this process start. There is no shared P/F deadline, no
// matrix, no loop and no second-target fallthrough. The previous full-POST path
// (C/H cache restore, IndexNow recapture, complete POST collector) is not
// invoked from here and is no longer wired in the workflow.
//
// Access is LIST + GET only, through the shared allow-list funnel that rejects
// any other command class before transmission. Every identity below is
// immutable and hardcoded: no prefix fallback, no latest-object discovery, no
// alternative run/attempt/producer-head/generation, no alternative identity
// field. Authoritative identity is `id` only (see d403-registry-decode.mjs).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { makeClient, listPrefix, getObject, getObjectToFile, strip, sha256, nowUtc } from './d403-r2-read.mjs';
import { initCrypto, decodeRegistryDir, IDENTITY_FIELD, IDENTITY_CITATION } from './d403-registry-decode.mjs';
import { tarList, assertSafeEntries } from './d403-handoff.mjs';

export const BUDGET_MINUTES = 44;
export const OUT_DIR = 'd403-target-evidence';
const REPORT = 'report.json';
const PKG_MANIFEST = 'package-manifest.json';
const MANIFEST_BASENAME = 'manifest.json';
const ARCHIVE_BASENAME = 'registry.tar.zst';
const ROOT = 'internal-handoff/aggregate-satellite/';

export const TARGETS = Object.freeze({
  P: Object.freeze({
    label: 'P', prefix: `${ROOT}30801055822/30802427780/1/f915b8ccacd6d3c596d78ff85ce6edb5d1fcd550/`,
    manifest_bytes: 52263, manifest_sha256: '3ce8dfbdd47684f45da9d7a31bfcd67564d67f694b69510d6b66e89f11edb20b',
    archive_bytes: 1173145727, archive_sha256: '8b9538757dfe6eb80c2d3f9aad1935659d093a7d315e658b02d45c13e5d72593',
    expected_shards: 643, expected_rows: 642695,
  }),
  F: Object.freeze({
    label: 'F', prefix: `${ROOT}30893731560/30895172870/1/f915b8ccacd6d3c596d78ff85ce6edb5d1fcd550/`,
    manifest_bytes: 52499, manifest_sha256: 'e8feb129a890a3f6a05eedd02adae8a9d659b3923842969ed1a6972e7d43b4eb',
    archive_bytes: 1177150243, archive_sha256: '8e8243221f4c14e486dc5024106205135c673130fb996bdd99481eca4534f1b8',
    expected_shards: 646, expected_rows: 645006,
  }),
});

/** Exact uppercase P or F only. Missing, lowercase, padded or anything else
 *  fails closed. No trimming, no coercion, no default. */
export function selectTarget(raw) {
  if (raw === 'P' || raw === 'F') return TARGETS[raw];
  throw new Error('TARGET_INVALID: workflow input `target` must be exactly "P" or "F"');
}

const write = (dir, name, buf) => fs.writeFileSync(path.join(dir, name), buf);

export function writePackage(dir, report) {
  // Stamped once so the package digest is idempotent: re-running the packager
  // over the same evidence MUST reproduce the same package sha256.
  if (!report.completed_utc) report.completed_utc = nowUtc();
  write(dir, REPORT, Buffer.from(JSON.stringify(report, null, 1)));
  const files = fs.readdirSync(dir).filter((f) => f !== PKG_MANIFEST).sort();
  const pkg = { generated_utc: nowUtc(), files: files.map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size, sha256: sha256(fs.readFileSync(path.join(dir, f))) })) };
  pkg.package_sha256 = sha256(Buffer.from(JSON.stringify(pkg.files)));
  write(dir, PKG_MANIFEST, Buffer.from(JSON.stringify(pkg, null, 1)));
  return pkg.package_sha256;
}

/**
 * Complete ONE target. `io` is injected so tests can prove, behaviourally, that
 * a run touches ONLY the selected target's keys and that an invalid target
 * performs zero network and zero crypto work.
 */
export async function runTarget(rawTarget, io) {
  const report = {
    schema: 'd403-target-completion/1', collector_mode: 'READ_ONLY_LIST_GET',
    budget_minutes: BUDGET_MINUTES, deadline_origin: 'SELECTED_TARGET_PROCESS_START',
    shared_pf_deadline: false, started_utc: nowUtc(), failure_reasons: [],
    identity: { field: IDENTITY_FIELD, citation: IDENTITY_CITATION, fallback_chain_used: false },
    layer_comparison_policy:
      'prefix_object_count (2 R2 objects) and archive_registry_member_count (643/646 shards inside the archive) are DIFFERENT LAYERS and are NEVER compared with each other',
  };
  let target;
  try {
    target = selectTarget(rawTarget);
  } catch (e) {
    report.target = null;
    report.target_status = 'FAILED_CLOSED';
    report.usable_as_complete_set = false;
    report.derived_conclusions_suppressed = true;
    report.failure_reasons.push('TARGET_INVALID_REJECTED_BEFORE_NETWORK_AND_CRYPTO');
    report.rejection_detail = e.message;
    return { report, code: 1 };
  }
  report.target = target.label;
  report.target_constants = target;
  const deadlineMs = io.now() + BUDGET_MINUTES * 60 * 1000;
  report.deadline_utc = new Date(deadlineMs).toISOString();
  report.crypto = io.initCrypto();

  const fail = (reason) => { report.failure_reasons.push(reason); };
  const finish = () => {
    const ok = report.failure_reasons.length === 0;
    report.target_status = ok ? 'COMPLETE' : 'FAILED_CLOSED';
    report.usable_as_complete_set = ok;
    report.derived_conclusions_suppressed = !ok;
    report.end_to_end_status_policy =
      'object retrieval success alone is NEVER sufficient: a partial, timed-out, decryption-empty or row-incoherent decode yields FAILED_CLOSED and a non-zero exit';
    return { report, code: ok ? 0 : 1 };
  };

  // LAYER 1: the exact prefix must hold PRECISELY the two expected objects.
  const listing = await io.listPrefix(target.prefix);
  const wantKeys = [`${target.prefix}${MANIFEST_BASENAME}`, `${target.prefix}${ARCHIVE_BASENAME}`].sort();
  const gotKeys = listing.inventory.map((m) => m.key).sort();
  report.prefix_listing = listing;
  report.prefix_object_count = { observed: listing.member_count, expected: 2, exact_key_set_match: JSON.stringify(gotKeys) === JSON.stringify(wantKeys) };
  if (listing.member_count !== 2 || !report.prefix_object_count.exact_key_set_match) {
    fail(`PREFIX_OBJECT_SET_INCOHERENT_observed=${listing.member_count}_expected=2`);
    return finish();
  }

  // Manifest: exact bytes + exact sha256.
  const man = await io.getObject(`${target.prefix}${MANIFEST_BASENAME}`);
  report.manifest_object = strip(man);
  if (!man.present) { fail('MANIFEST_ABSENT'); return finish(); }
  report.manifest_integrity = { bytes_match: man.size === target.manifest_bytes, sha256_match: man.sha256 === target.manifest_sha256 };
  if (!report.manifest_integrity.bytes_match || !report.manifest_integrity.sha256_match) {
    fail('MANIFEST_INTEGRITY_MISMATCH');
    return finish();
  }
  let manifest;
  try { manifest = JSON.parse(man.body.toString('utf8')); } catch { fail('MANIFEST_UNPARSEABLE'); return finish(); }
  const seg = target.prefix.slice(ROOT.length).split('/');
  report.manifest_identity = {
    matches_prefix: String(manifest.github_run_id) === seg[1] && String(manifest.github_run_attempt) === seg[2] && String(manifest.producer_main_sha) === seg[3],
    completion_state: manifest.completion_state || null,
  };
  if (!report.manifest_identity.matches_prefix) { fail('MANIFEST_IDENTITY_MISMATCH'); return finish(); }
  // LAYER 2 (manifest inventory), never compared against LAYER 1.
  report.manifest_inventory_member_count = Array.isArray(manifest.inventory) ? manifest.inventory.length : null;

  // Archive: streamed to disk, exact bytes + exact sha256.
  const dir = io.workDir(target.label);
  const archivePath = path.join(dir, ARCHIVE_BASENAME);
  const arc = await io.getObjectToFile(`${target.prefix}${ARCHIVE_BASENAME}`, archivePath);
  report.archive_object = arc;
  if (!arc.present) { fail('ARCHIVE_ABSENT'); return finish(); }
  report.archive_integrity = { bytes_match: arc.size === target.archive_bytes, sha256_match: arc.sha256 === target.archive_sha256 };
  if (!report.archive_integrity.bytes_match || !report.archive_integrity.sha256_match) {
    fail('ARCHIVE_INTEGRITY_MISMATCH');
    return finish();
  }

  // Membership safety is validated BEFORE any extraction.
  let entries;
  try { entries = io.listArchive(archivePath); assertSafeEntries(entries); } catch (e) {
    report.archive_membership = { safe: false, error: e.message };
    fail('UNSAFE_OR_UNREADABLE_ARCHIVE');
    return finish();
  }
  report.archive_membership = { safe: true, entry_count: entries.length };
  if (!io.extract(archivePath, dir)) { fail('EXTRACT_FAILED'); return finish(); }

  const decoded = io.decode(target.label, path.join(dir, 'cache', 'registry'), { deadlineMs, expectedShards: target.expected_shards });
  const ev = decoded.evidence;
  report.decode = ev;
  // LAYER 3 (archive registry members), never compared against LAYER 1.
  report.archive_registry_member_count = { observed: ev.shards.length, expected: target.expected_shards, match: ev.shards.length === target.expected_shards };
  report.totals = {
    total_decoded_rows: ev.total_decoded_rows, expected_rows: target.expected_rows,
    total_header_rows: ev.total_header_rows, unique_identity_cardinality: ev.unique_identity_cardinality,
    repeated_distinct_identity_count: ev.repeated_distinct_identity_count, excess_duplicate_row_count: ev.excess_duplicate_row_count,
    rows_without_identity_field: ev.missing_identity_rows,
  };
  if (ev.status !== 'COMPLETE') fail(`DECODE_NOT_COMPLETE_status=${ev.status}`);
  if (!report.archive_registry_member_count.match) fail('ARCHIVE_REGISTRY_MEMBER_COUNT_MISMATCH');
  if (ev.total_decoded_rows !== target.expected_rows) fail('TOTAL_DECODED_ROWS_MISMATCH');
  if (ev.missing_identity_rows !== 0) fail('ROWS_WITHOUT_IDENTITY_FIELD');
  if (ev.shards.some((s) => !s.rows_match)) fail('PER_SHARD_ROW_MISMATCH');

  const sorted = [...decoded.ids].sort();
  const complete = report.failure_reasons.length === 0;
  const member = complete ? 'canonical-id-set.json.gz' : 'partial-id-set-NOT-COMPLETE.json.gz';
  io.writeMember(member, zlib.gzipSync(Buffer.from(JSON.stringify(sorted))));
  report.canonical_id_set = {
    member, count: sorted.length, canonical_sha256: sha256(sorted.join('\n')),
    is_complete_set: complete,
    note: complete ? 'canonical sorted unique id set for the target' : 'PARTIAL set retained as evidence only; it is NOT a complete set and must not be used as one',
  };
  return finish();
}

function realIo(s3) {
  return {
    now: () => Date.now(),
    initCrypto,
    listPrefix: (prefix) => listPrefix(s3, prefix),
    getObject: (key) => getObject(s3, key),
    getObjectToFile: (key, dest) => getObjectToFile(s3, key, dest),
    workDir: (label) => { const d = path.join('work', label); fs.mkdirSync(d, { recursive: true }); return d; },
    listArchive: (p) => tarList(p),
    extract: (archive, dir) => {
      const ex = spawnSync('tar', ['-xf', archive, '-C', dir, 'cache/registry'], { shell: false, encoding: 'utf8' });
      fs.rmSync(archive, { force: true });
      return ex.status === 0;
    },
    decode: (label, d, opts) => decodeRegistryDir(label, d, opts),
    writeMember: (name, buf) => write(OUT_DIR, name, buf),
  };
}

// Using the io on the invalid-target path is a contract breach, so this
// placeholder throws rather than behaving like a real client.
const UNREACHABLE_IO = new Proxy({}, { get(_t, p) { throw new Error(`IO_UNREACHABLE_AFTER_INVALID_TARGET: ${String(p)}`); } });

/**
 * DEPLOYED entry ordering. The target is validated FIRST; `buildIo` - which is
 * what constructs the R2 client and therefore what reads credential values out
 * of the environment - runs ONLY after validation succeeds. runTarget validates
 * again (defence in depth), so both layers reject an invalid target.
 */
export async function mainWithDeps(rawTarget, buildIo) {
  try {
    selectTarget(rawTarget);
  } catch {
    return runTarget(rawTarget, UNREACHABLE_IO);
  }
  return runTarget(rawTarget, buildIo());
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { report, code } = await mainWithDeps(process.env.D403_TARGET, () => realIo(makeClient()));
  report.run = {
    repository: process.env.GITHUB_REPOSITORY || null, run_id: process.env.GITHUB_RUN_ID || null,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT || null, event_name: process.env.GITHUB_EVENT_NAME || null,
    branch_ref: process.env.GITHUB_REF || null, branch_commit_sha: process.env.GITHUB_SHA || null,
    base_sha: process.env.D403_BASE_SHA || null,
  };
  const digest = writePackage(OUT_DIR, report);
  console.log(`[D403-TARGET] target=${report.target} status=${report.target_status} package_sha256=${digest}`);
  return code;
}

if (process.argv[1] && process.argv[1].endsWith('d403-target-complete.mjs')) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(`[D403-TARGET] FAILED: ${e.message}`);
    process.exit(1);
  });
}
