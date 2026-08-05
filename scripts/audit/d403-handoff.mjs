// D-403 POST: immutable satellite-registry handoff recovery.
// Streams the ~1.17 GB archive to disk, validates identity/bytes/hash against
// the manifest, rejects unsafe archive entries BEFORE extraction, extracts only
// cache/registry, decodes under the fail-closed contract, then frees the disk.
// The only child_process use is a fixed-argv `tar` with shell disabled; `tar` is
// not network capable. No R2 write of any kind occurs here.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listPrefix, getObject, getObjectToFile, strip } from './d403-r2-read.mjs';
import { decodeRegistryDir } from './d403-registry-decode.mjs';

const ARCHIVE_BASENAME = 'registry.tar.zst';
const MANIFEST_BASENAME = 'manifest.json';
const HANDOFF_ROOT = 'internal-handoff/aggregate-satellite/';

/** tar entry listing with a hardcoded argv; shell disabled. */
export function tarList(archive) {
  const r = spawnSync('tar', ['-tvf', archive], { shell: false, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`TAR_LIST_FAILED: status=${r.status}`);
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^(\S)\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
    return m ? { type: m[1], size: Number(m[2]), name: m[3].split(' -> ')[0].trim(), link: l.includes(' -> ') } : { type: '?', size: 0, name: l, link: false };
  });
}

/** Absolute path / traversal / link / out-of-root rejection BEFORE extraction. */
export function assertSafeEntries(entries) {
  for (const e of entries) {
    const n = e.name.replace(/\\/g, '/');
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) throw new Error(`UNSAFE_ARCHIVE_ABSOLUTE_PATH: ${n}`);
    if (n.split('/').includes('..')) throw new Error(`UNSAFE_ARCHIVE_TRAVERSAL: ${n}`);
    if (e.type === 'l' || e.type === 'h' || e.link) throw new Error(`UNSAFE_ARCHIVE_LINK: ${n}`);
    if (!/^(\.\/)?cache\/registry(\/|$)/.test(n)) throw new Error(`UNSAFE_ARCHIVE_OUT_OF_ROOT: ${n}`);
  }
}

/**
 * Recover ONE handoff generation. Returns { evidence, ids, probeHits, fieldCounts }.
 * `keepDisk` retains the extracted shards (needed when a later step must re-read
 * them); otherwise the archive and extraction are removed to bound disk use.
 */
export async function recoverHandoff(s3, label, prefix, workRoot, opts = {}) {
  const ev = { label, prefix, status: 'OK', validations: {}, retrieved_utc: new Date().toISOString() };
  const empty = { evidence: ev, ids: new Set(), probeHits: new Set(), fieldCounts: null };
  ev.listing = await listPrefix(s3, prefix);
  const man = await getObject(s3, `${prefix}${MANIFEST_BASENAME}`);
  ev.manifest_object = strip(man);
  if (!man.present) { ev.status = 'MANIFEST_ABSENT'; return empty; }
  let manifest;
  try {
    manifest = JSON.parse(man.body.toString('utf8'));
  } catch (e) {
    ev.status = 'MANIFEST_UNPARSEABLE';
    ev.validations.manifest_parse_error = e && e.name ? e.name : 'Error';
    return empty;
  }
  const declaredMembers = Array.isArray(manifest.inventory) ? manifest.inventory.length : null;
  ev.manifest = { ...manifest, inventory: undefined, inventory_member_count: declaredMembers };
  const seg = prefix.slice(HANDOFF_ROOT.length).split('/');
  ev.validations.identity_matches_prefix =
    String(manifest.github_run_id) === seg[1] && String(manifest.github_run_attempt) === seg[2] && String(manifest.producer_main_sha) === seg[3];
  ev.validations.completion_state = manifest.completion_state || null;

  const dir = path.join(workRoot, label);
  const archivePath = path.join(dir, ARCHIVE_BASENAME);
  fs.mkdirSync(dir, { recursive: true });
  const arc = await getObjectToFile(s3, `${prefix}${ARCHIVE_BASENAME}`, archivePath);
  ev.archive_object = arc;
  if (!arc.present) { ev.status = 'ARCHIVE_ABSENT'; return empty; }
  ev.validations.archive_bytes_match = arc.size === manifest.archive_bytes;
  ev.validations.archive_sha256_match = arc.sha256 === manifest.archive_sha256;
  if (!ev.validations.archive_bytes_match || !ev.validations.archive_sha256_match) {
    ev.status = 'ARCHIVE_INTEGRITY_MISMATCH';
    fs.rmSync(dir, { recursive: true, force: true });
    return empty;
  }

  let entries;
  try {
    entries = tarList(archivePath);
    assertSafeEntries(entries);
  } catch (e) {
    ev.status = 'UNSAFE_OR_UNREADABLE_ARCHIVE';
    ev.validations.archive_entry_error = e.message;
    fs.rmSync(dir, { recursive: true, force: true });
    return empty;
  }
  ev.validations.archive_entries_safe = true;
  ev.validations.archive_entry_count = entries.length;

  const ex = spawnSync('tar', ['-xf', archivePath, '-C', dir, 'cache/registry'], { shell: false, encoding: 'utf8' });
  fs.rmSync(archivePath, { force: true }); // archive no longer needed; free ~1.17 GB
  if (ex.status !== 0) {
    ev.status = 'EXTRACT_FAILED';
    fs.rmSync(dir, { recursive: true, force: true });
    return empty;
  }
  const shardDir = path.join(dir, 'cache', 'registry');
  const decoded = decodeRegistryDir(label, shardDir, opts);
  ev.decode = decoded.evidence;
  ev.validations.member_count_matches_manifest = declaredMembers === decoded.evidence.shards.length;
  if (!opts.keepDisk) fs.rmSync(dir, { recursive: true, force: true });
  return { evidence: ev, ids: decoded.ids, probeHits: decoded.probeHits, fieldCounts: decoded.fieldCounts };
}
