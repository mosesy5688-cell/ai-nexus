#!/usr/bin/env node
// D-403 read-only registry evidence collector (branch-isolated, evidence-only).
// ZERO mutation by construction. R2: LIST + GET only, enforced by a runtime
// allow-list on the AWS SDK command class name BEFORE the command reaches the
// transport; write commands (put/delete/copy/multipart/upload) are neither
// imported nor built. GHA cache is restore-only (done by the workflow), never
// saved/deleted/reserved. No pointer/manifest write, no workflow dispatch, no
// outbound HTTP POST, no shell fetch tools, no generated code, no dynamic
// import, no CLI mutation tooling. The only child_process use is a fixed-argv `tar`
// (shell: false), which is not network capable, to list then extract the
// immutable handoff archive. All identities (bucket, keys, prefixes, cache
// paths) are HARDCODED below: no CLI argument, no env-supplied object prefix.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { readBinaryShard } from '../factory/lib/registry-binary-reader.js';

export const ALLOWED_R2_COMMANDS = Object.freeze(['ListObjectsV2Command', 'GetObjectCommand', 'HeadObjectCommand']);
const ALLOWED_SET = new Set(ALLOWED_R2_COMMANDS);
/** Runtime allow-list by command class. Throws BEFORE any network transmission. */
export function assertAllowedCommand(cmd) {
  const name = cmd && cmd.constructor ? cmd.constructor.name : String(cmd);
  if (!ALLOWED_SET.has(name)) throw new Error(`R2_COMMAND_DENIED: ${name}`);
  return name;
}
const BUCKET = 'ai-nexus-assets';
const OUT_DIR = 'd403-evidence';
const REPORT = 'report.json';
const PKG_MANIFEST = 'package-manifest.json';
const CYCLE_START_UTC = '2026-08-05T05:32:34Z'; // Factory 1/4 run 30978426411 start
const FIXED_OBJECTS = Object.freeze([
  'state/indexnow-delta.json', 'state/global-registry.json.zst',
  'meta/backup/global-registry.json.zst', 'state/purge-list.json',
  'state/last-upload-manifest.json',
]);
const FIXED_PREFIXES = Object.freeze(['state/registry/', 'meta/backup/registry/']);
const HANDOFF_ROOT = 'internal-handoff/aggregate-satellite/';
const HANDOFFS = Object.freeze([
  { label: 'successful-publication-candidate', prefix: `${HANDOFF_ROOT}30801055822/30802427780/1/f915b8ccacd6d3c596d78ff85ce6edb5d1fcd550/` },
  { label: 'failed-cycle-candidate', prefix: `${HANDOFF_ROOT}30893731560/30895172870/1/f915b8ccacd6d3c596d78ff85ce6edb5d1fcd550/` },
]);
const CACHES = Object.freeze([
  { requested_key: 'global-registry-29963927733', env: 'D403_RESTORED_GLOBAL_REGISTRY', paths: ['cache/global-registry.json.zst', 'cache/registry'], registry_dir: 'cache/registry' },
  { requested_key: 'r2-upload-manifest-30802427780-30815518168', env: 'D403_RESTORED_UPLOAD_MANIFEST', paths: ['output/cache/last-upload-manifest.json'], registry_dir: null },
]);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const setHash = (lines) => sha256([...lines].sort().join('\n'));
const nowUtc = () => new Date().toISOString();
function client() {
  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  return new S3Client({
    region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}
/** Single funnel: every R2 call passes the allow-list before transmission. */
async function send(s3, cmd) {
  assertAllowedCommand(cmd);
  return s3.send(cmd);
}
/** Complete (fully paginated) prefix inventory. */
async function listPrefix(s3, prefix) {
  const members = [];
  let token;
  do {
    const r = await send(s3, new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }));
    for (const o of r.Contents || []) {
      members.push({ key: o.Key, size: o.Size, etag: String(o.ETag || '').replace(/"/g, ''), last_modified: o.LastModified ? new Date(o.LastModified).toISOString() : null });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  members.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { prefix, member_count: members.length, inventory: members, inventory_set_hash: setHash(members.map((m) => `${m.key} ${m.size} ${m.etag}`)), retrieved_utc: nowUtc() };
}
async function getObject(s3, key) {
  const at = nowUtc();
  try {
    const r = await send(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = [];
    for await (const c of r.Body) chunks.push(Buffer.from(c));
    const buf = Buffer.concat(chunks);
    return {
      key, present: true, retrieved_utc: at, size: buf.length, sha256: sha256(buf), body: buf,
      content_length: typeof r.ContentLength === 'number' ? r.ContentLength : null,
      etag: String(r.ETag || '').replace(/"/g, ''), content_type: r.ContentType || null,
      last_modified: r.LastModified ? new Date(r.LastModified).toISOString() : null, metadata: r.Metadata || {},
    };
  } catch (e) {
    return { key, present: false, retrieved_utc: at, error_name: e && e.name ? e.name : 'Error', body: null };
  }
}
const strip = (o) => ({ ...o, body: undefined });
/** NXVF header row count (offset 11, uint32 LE). Needs no decryption key. */
function nxvfRows(buf) {
  if (buf.length < 29 || buf.subarray(0, 4).toString('hex') !== '4e585646') return null;
  return buf.readUInt32LE(11);
}
/** Registry-shard census over a local directory of part-NNN.bin shards. */
async function registryCensus(dir) {
  const out = { shard_dir: dir, present: fs.existsSync(dir), members: [], member_count: 0, row_count: 0, shards_decoded: 0, id_set_complete: false, unique_id_count: null, duplicate_id_count: null, sorted_id_set_hash: null };
  const ids = []; const seen = new Map();
  if (!out.present) return { census: out, ids };
  for (const f of fs.readdirSync(dir).filter((n) => /^part-\d+\.bin$/.test(n)).sort()) {
    const full = path.join(dir, f);
    const buf = fs.readFileSync(full);
    const rows = nxvfRows(buf);
    out.members.push({ name: f, size: buf.length, sha256: sha256(buf), header_rows: rows });
    if (typeof rows === 'number') out.row_count += rows;
    try {
      const shard = await readBinaryShard(full);
      if (!shard || !Array.isArray(shard.entities) || !shard.entities.length) continue;
      out.shards_decoded += 1;
      for (const e of shard.entities) {
        const id = e && (e.canonical_id || e.umid || e.id || e.entity_id);
        if (id) seen.set(String(id), (seen.get(String(id)) || 0) + 1);
      }
    } catch { /* undecodable shard: visible as shards_decoded < member_count */ }
  }
  out.member_count = out.members.length;
  out.inventory_set_hash = setHash(out.members.map((m) => `${m.name} ${m.size} ${m.sha256}`));
  out.id_set_complete = out.member_count > 0 && out.shards_decoded === out.member_count;
  if (seen.size) {
    ids.push(...[...seen.keys()].sort());
    out.unique_id_count = ids.length;
    out.duplicate_id_count = [...seen.values()].filter((n) => n > 1).length;
    out.sorted_id_set_hash = sha256(ids.join('\n'));
  }
  return { census: out, ids };
}
function walkFiles(p, acc) {
  if (!fs.existsSync(p)) return acc;
  if (fs.statSync(p).isDirectory()) { for (const c of fs.readdirSync(p).sort()) walkFiles(path.join(p, c), acc); return acc; }
  const buf = fs.readFileSync(p);
  acc.push({ path: p.replace(/\\/g, '/'), size: buf.length, sha256: sha256(buf) });
  return acc;
}
/** Cache identity: requested vs actually-restored key, hit/miss, member inventory. */
async function cacheIdentity(spec) {
  const actual = process.env[spec.env] || '';
  const members = [];
  for (const p of spec.paths) walkFiles(p, members);
  const reg = spec.registry_dir ? await registryCensus(spec.registry_dir) : { census: null, ids: [] };
  const record = {
    requested_key: spec.requested_key, restored_key: actual || null, cache_hit: Boolean(actual),
    exact_key_match: actual === spec.requested_key, member_count: members.length, members,
    inventory_set_hash: setHash(members.map((m) => `${m.path} ${m.size} ${m.sha256}`)), registry_census: reg.census,
  };
  return { record, ids: reg.ids };
}
/** tar entry listing with a hardcoded argv; shell disabled. */
function tarList(archive) {
  const r = spawnSync('tar', ['-tvf', archive], { shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`TAR_LIST_FAILED: status=${r.status}`);
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^(\S)\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
    return m ? { type: m[1], size: Number(m[2]), name: m[3].split(' -> ')[0].trim(), link: l.includes(' -> ') } : { type: '?', size: 0, name: l, link: false };
  });
}
function assertSafeEntries(entries) {
  for (const e of entries) {
    const n = e.name.replace(/\\/g, '/');
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) throw new Error(`UNSAFE_ARCHIVE_ABSOLUTE_PATH: ${n}`);
    if (n.split('/').includes('..')) throw new Error(`UNSAFE_ARCHIVE_TRAVERSAL: ${n}`);
    if (e.type === 'l' || e.type === 'h' || e.link) throw new Error(`UNSAFE_ARCHIVE_LINK: ${n}`);
    if (!/^(\.\/)?cache\/registry(\/|$)/.test(n)) throw new Error(`UNSAFE_ARCHIVE_OUT_OF_ROOT: ${n}`);
  }
}
async function captureHandoff(s3, spec, workRoot) {
  const rec = { label: spec.label, prefix: spec.prefix, retrieved_utc: nowUtc(), status: 'OK', validations: {} };
  rec.listing = await listPrefix(s3, spec.prefix);
  const man = await getObject(s3, `${spec.prefix}manifest.json`);
  rec.manifest_object = strip(man);
  if (!man.present) { rec.status = 'MANIFEST_ABSENT'; return { rec, ids: [] }; }
  const manifest = JSON.parse(man.body.toString('utf8'));
  const declaredMembers = Array.isArray(manifest.inventory) ? manifest.inventory.length : null;
  rec.manifest = { ...manifest, inventory: undefined, inventory_member_count: declaredMembers };
  const seg = spec.prefix.slice(HANDOFF_ROOT.length).split('/');
  rec.validations.identity_matches_prefix = String(manifest.github_run_id) === seg[1] && String(manifest.github_run_attempt) === seg[2] && String(manifest.producer_main_sha) === seg[3];
  const arc = await getObject(s3, `${spec.prefix}registry.tar.zst`);
  rec.archive_object = strip(arc);
  if (!arc.present) { rec.status = 'ARCHIVE_ABSENT'; return { rec, ids: [] }; }
  rec.validations.archive_bytes_match = arc.size === manifest.archive_bytes;
  rec.validations.archive_sha256_match = arc.sha256 === manifest.archive_sha256;
  const dir = path.join(workRoot, spec.label);
  const archivePath = path.join(dir, 'registry.tar.zst');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(archivePath, arc.body);
  const entries = tarList(archivePath);
  assertSafeEntries(entries);
  rec.validations.archive_entries_safe = true;
  rec.validations.archive_entry_count = entries.length;
  const ex = spawnSync('tar', ['-xf', archivePath, '-C', dir, 'cache/registry'], { shell: false, encoding: 'utf8' });
  if (ex.status !== 0) { rec.status = 'EXTRACT_FAILED'; return { rec, ids: [] }; }
  const reg = await registryCensus(path.join(dir, 'cache', 'registry'));
  rec.registry_census = reg.census;
  rec.validations.member_count_matches_manifest = declaredMembers === reg.census.member_count;
  return { rec, ids: reg.ids };
}
async function main() {
  const s3 = client();
  const work = fs.mkdtempSync(path.join(process.cwd(), '.d403-work-'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const idSets = { caches: [], handoffs: [] };
  const report = {
    schema: 'd403-readonly-registry-evidence/1', collector_mode: 'READ_ONLY_LIST_GET',
    allowed_r2_commands: ALLOWED_R2_COMMANDS, started_utc: nowUtc(),
    run: {
      repository: process.env.GITHUB_REPOSITORY || null, run_id: process.env.GITHUB_RUN_ID || null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT || null, event_name: process.env.GITHUB_EVENT_NAME || null,
      branch_ref: process.env.GITHUB_REF || null, branch_commit_sha: process.env.GITHUB_SHA || null,
      base_sha: process.env.D403_BASE_SHA || null,
    },
    caches: [], prefixes_before: [], objects: [], handoff_generations: null, handoffs: [], prefixes_after: [], torn_capture: [],
  };
  for (const c of CACHES) { const r = await cacheIdentity(c); report.caches.push(r.record); idSets.caches.push({ requested_key: c.requested_key, ids: r.ids }); }
  for (const p of FIXED_PREFIXES) report.prefixes_before.push(await listPrefix(s3, p));
  for (const k of FIXED_OBJECTS) report.objects.push(strip(await getObject(s3, k)));
  report.handoff_generations = { ...(await listPrefix(s3, HANDOFF_ROOT)), note: 'enumeration only; no generation selected by shard count or recency' };
  for (const h of HANDOFFS) { const r = await captureHandoff(s3, h, work); report.handoffs.push(r.rec); idSets.handoffs.push({ label: h.label, ids: r.ids }); }
  for (const p of FIXED_PREFIXES) report.prefixes_after.push(await listPrefix(s3, p));
  FIXED_PREFIXES.forEach((p, i) => {
    const coherent = report.prefixes_before[i].inventory_set_hash === report.prefixes_after[i].inventory_set_hash;
    report.torn_capture.push({ prefix: p, classification: coherent ? 'COHERENT' : 'CONCURRENTLY_MUTATED' });
  });
  const dj = report.objects[FIXED_OBJECTS.indexOf('state/indexnow-delta.json')];
  const missed = !dj.present || !dj.last_modified || Date.parse(dj.last_modified) >= Date.parse(CYCLE_START_UTC);
  report.summary = {
    PRE_FAILURE_CYCLE_INDEXNOW_SNAPSHOT: missed ? 'MISSED' : 'CAPTURED',
    indexnow_attribution: missed ? 'NOT_ATTRIBUTABLE_TO_FAILED_CYCLE' : 'PRE_CYCLE_OBJECT',
    new_cycle_start_utc: CYCLE_START_UTC,
    torn_prefixes: report.torn_capture.filter((t) => t.classification !== 'COHERENT').map((t) => t.prefix),
    cache_hits: report.caches.map((c) => ({ requested_key: c.requested_key, restored_key: c.restored_key, cache_hit: c.cache_hit, exact_key_match: c.exact_key_match })),
    handoff_status: report.handoffs.map((h) => ({ label: h.label, status: h.status, validations: h.validations })),
  };
  report.completed_utc = nowUtc();
  fs.writeFileSync(path.join(OUT_DIR, 'id-sets.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(idSets))));
  fs.writeFileSync(path.join(OUT_DIR, REPORT), JSON.stringify(report, null, 1));
  const files = fs.readdirSync(OUT_DIR).filter((f) => f !== PKG_MANIFEST).sort();
  const pkg = { generated_utc: nowUtc(), files: files.map((f) => ({ name: f, size: fs.statSync(path.join(OUT_DIR, f)).size, sha256: sha256(fs.readFileSync(path.join(OUT_DIR, f))) })) };
  pkg.package_sha256 = sha256(Buffer.from(JSON.stringify(pkg.files)));
  fs.writeFileSync(path.join(OUT_DIR, PKG_MANIFEST), JSON.stringify(pkg, null, 1));
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`[D403] evidence written: ${OUT_DIR}/${REPORT} package_sha256=${pkg.package_sha256}`);
}
if (process.argv[1] && process.argv[1].endsWith('d403-evidence-collector.mjs')) {
  main().catch((e) => { console.error(`[D403] FAILED: ${e.message}`); process.exit(1); });
}
