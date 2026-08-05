#!/usr/bin/env node
// D-403 POST: read-only evidence collection after the natural 1/4 completed.
// LIST/GET only through the shared allow-list; no mutation, no rerun, no
// dispatch. Identities below are HARDCODED - no discovery, no prefix fallback.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getRouteFromId } from '../../src/utils/mesh-routing-core.js';
import { makeClient, listPrefix, getObject, strip, classifyTorn, sha256, nowUtc } from './d403-r2-read.mjs';
import { initCrypto, decodeRegistryDir } from './d403-registry-decode.mjs';
import { recoverHandoff } from './d403-handoff.mjs';
import { relations, classifyU, originMap, promotionByteClose, writeSet, diff, inter } from './d403-setops.mjs';
import { parseUrls, urlCensus } from './d403-indexnow-supplement.mjs';

const OUT_DIR = 'd403-post-evidence';
const REPORT = 'report.json';
const PKG_MANIFEST = 'package-manifest.json';
const NATURAL = Object.freeze({
  run_id: '30978426411', attempt: '1', event: 'schedule',
  head_sha: '096e4b30c2ea9cbe1587868d651aa577762c7b49',
  conclusion: 'success', terminal_utc: '2026-08-05T08:48:17Z',
});
const HARVEST_CACHE_KEY = 'cycle-30978426411-harvest';
const GLOBAL_REGISTRY_CACHE_KEY = 'global-registry-29963927733';
const PRE = Object.freeze({
  delta_sha256: 'f88010602321e4b4bcd24caea3076f49a088b89f9c450dac25956ba97c3c2659',
  urlset_sha256: '3b7aebc087effb013cec75ae34fbdc2f78b31f235480043059918c21b562f24d',
  url_count: 6256, next_delta_r2_write_utc: '2026-08-05T08:45:17.760Z',
});
const P_PREFIX = 'internal-handoff/aggregate-satellite/30801055822/30802427780/1/f915b8ccacd6d3c596d78ff85ce6edb5d1fcd550/';
const F_PREFIX = 'internal-handoff/aggregate-satellite/30893731560/30895172870/1/f915b8ccacd6d3c596d78ff85ce6edb5d1fcd550/';
const DELTA_KEY = 'state/indexnow-delta.json';
const PREFIXES = ['state/registry/', 'meta/backup/registry/'];
const PROMOTION_PARTS = Array.from({ length: 14 }, (_, i) => `part-${632 + i}.bin`);
const H_DIR = 'h-registry';
const C_DIR = 'cache/registry';

// Mirror of the producer's id -> URL mapping, byte-for-byte with
// scripts/factory/lib/indexnow-delta.js:18-20: the route is prefixed with the
// site origin and a '#' route is dropped. getRouteFromId returns a PATH, so the
// origin MUST be prepended before comparing against the delta's absolute URLs.
const ROUTE_ORIGIN = 'https://free2aitools.com';
export function idToDeltaUrl(id, type) {
  const route = getRouteFromId(id, type);
  return route && route !== '#' ? `${ROUTE_ORIGIN}${route}` : null;
}

const write = (name, buf) => fs.writeFileSync(path.join(OUT_DIR, name), buf);
const budgetMs = () => Number(process.env.D403_BUDGET_MINUTES || 44) * 60 * 1000;

function packageUp(report) {
  report.completed_utc = nowUtc();
  write(REPORT, Buffer.from(JSON.stringify(report, null, 1)));
  const files = fs.readdirSync(OUT_DIR).filter((f) => f !== PKG_MANIFEST).sort();
  const pkg = { generated_utc: nowUtc(), files: files.map((f) => ({ name: f, size: fs.statSync(path.join(OUT_DIR, f)).size, sha256: sha256(fs.readFileSync(path.join(OUT_DIR, f))) })) };
  pkg.package_sha256 = sha256(Buffer.from(JSON.stringify(pkg.files)));
  write(PKG_MANIFEST, Buffer.from(JSON.stringify(pkg, null, 1)));
  return pkg.package_sha256;
}

/** Capture the CURRENT delta as real artifact members and compare to PRE. */
function captureIndexNow(obj) {
  const ev = { key: DELTA_KEY, object: strip(obj), pre_reference: PRE };
  if (!obj.present) { ev.status = 'ABSENT'; return { evidence: ev, urlSet: new Set() }; }
  write('indexnow-delta.current.raw.json', obj.body);
  ev.raw_body = { member: 'indexnow-delta.current.raw.json', size: obj.size, sha256: obj.sha256, retrieval_utc: obj.retrieved_utc };
  let parsed;
  try {
    parsed = parseUrls(obj.body);
  } catch (e) {
    ev.status = 'PARSE_FAILED';
    ev.parse_error = e.message;
    return { evidence: ev, urlSet: new Set() };
  }
  const census = urlCensus(parsed.list);
  const { unique, ...fields } = census;
  ev.status = 'CAPTURED';
  ev.authoritative_url_field = parsed.field;
  ev.schema = parsed.schema;
  ev.census = fields;
  ev.url_set_member = writeSet(OUT_DIR, 'indexnow-next-url-set.json.gz', unique);
  ev.comparison_to_pre = {
    body_sha256_identical: obj.sha256 === PRE.delta_sha256,
    url_set_sha256_identical: fields.canonical_url_set_sha256 === PRE.urlset_sha256,
    pre_url_count: PRE.url_count, next_url_count: fields.unique_url_count,
    last_modified_observed: obj.last_modified,
    object_replaced_since_pre: obj.sha256 !== PRE.delta_sha256,
  };
  return { evidence: ev, urlSet: new Set(unique) };
}

function cacheIdentity(key, envName, dir) {
  const restored = process.env[envName] || '';
  const manifestPath = 'data/manifest.json';
  const rec = {
    requested_key: key, restored_key: restored || null, cache_hit: Boolean(restored),
    exact_key_match: restored === key, shard_dir: dir, shard_dir_present: fs.existsSync(dir),
  };
  if (fs.existsSync(manifestPath)) {
    const buf = fs.readFileSync(manifestPath);
    rec.cache_manifest = { path: manifestPath, size: buf.length, sha256: sha256(buf) };
    try {
      const m = JSON.parse(buf.toString('utf8'));
      rec.cache_manifest.run_identity_fields = {
        run_id: m.run_id ?? m.github_run_id ?? null, cycle_id: m.cycle_id ?? null,
        generated_at: m.generated_at ?? m.created_at ?? null, total_entities: m.total_entities ?? null,
      };
    } catch { rec.cache_manifest.parse_error = 'MANIFEST_UNPARSEABLE'; }
  }
  rec.identity_coherent = rec.exact_key_match && rec.shard_dir_present;
  return rec;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const deadlineMs = Date.now() + budgetMs();
  const s3 = makeClient();
  const report = {
    schema: 'd403-post-evidence/1', collector_mode: 'READ_ONLY_LIST_GET', started_utc: nowUtc(),
    natural_1_4: NATURAL, crypto: initCrypto(),
    run: {
      repository: process.env.GITHUB_REPOSITORY || null, run_id: process.env.GITHUB_RUN_ID || null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT || null, event_name: process.env.GITHUB_EVENT_NAME || null,
      branch_ref: process.env.GITHUB_REF || null, branch_commit_sha: process.env.GITHUB_SHA || null,
      base_sha: process.env.D403_BASE_SHA || null,
    },
  };

  const idx = captureIndexNow(await getObject(s3, DELTA_KEY));
  report.indexnow = idx.evidence;
  const probe = { urlSet: idx.urlSet, route: idToDeltaUrl };

  report.caches = {
    H: cacheIdentity(HARVEST_CACHE_KEY, 'D403_RESTORED_HARVEST', H_DIR),
    C: cacheIdentity(GLOBAL_REGISTRY_CACHE_KEY, 'D403_RESTORED_GLOBAL_REGISTRY', C_DIR),
  };
  if (!report.caches.H.identity_coherent) {
    report.summary = {
      status: 'STOPPED_HARVEST_CACHE_IDENTITY_INCOHERENT',
      reason: `exact key ${HARVEST_CACHE_KEY} absent or shard dir missing; NO prefix or other-cycle fallback attempted`,
    };
    const d = packageUp(report);
    console.error(`[D403-POST] STOP: harvest cache identity incoherent package_sha256=${d}`);
    return 1;
  }

  report.prefixes_before = [];
  for (const p of PREFIXES) report.prefixes_before.push(await listPrefix(s3, p));

  const C = decodeRegistryDir('C', C_DIR, { deadlineMs, probe });
  const H = decodeRegistryDir('H', H_DIR, { deadlineMs, probe, trackFieldCount: true });
  const P = await recoverHandoff(s3, 'P', P_PREFIX, 'work', { deadlineMs, probe });
  const F = await recoverHandoff(s3, 'F', F_PREFIX, 'work', { deadlineMs, probe, trackFieldCount: true });
  report.registries = { C: C.evidence, H: H.evidence, P: P.evidence, F: F.evidence };

  // Byte-close the promotion finding against meta/backup/registry.
  const metaBackup = new Map();
  for (const name of PROMOTION_PARTS) {
    const o = await getObject(s3, `meta/backup/registry/${name}`);
    report.registries.meta_backup_parts = report.registries.meta_backup_parts || [];
    report.registries.meta_backup_parts.push(strip(o));
    if (o.present) metaBackup.set(name, o.sha256);
  }
  report.promotion_byte_close = promotionByteClose(metaBackup, F.evidence.decode ? F.evidence.decode.shards : [], PROMOTION_PARTS);

  const nextDeltaIds = new Set([...C.probeHits, ...H.probeHits, ...P.probeHits, ...F.probeHits]);
  report.next_delta_id_resolution = {
    definition: 'ids whose producer URL (site origin + getRouteFromId path, mirroring scripts/factory/lib/indexnow-delta.js:18-20) lands in the CURRENT delta url set',
    resolved_id_count: nextDeltaIds.size,
    next_delta_url_count: idx.urlSet.size,
    unresolved_url_count: Math.max(0, idx.urlSet.size - nextDeltaIds.size),
    ...writeSet(OUT_DIR, 'set-next_delta_ids.json.gz', [...nextDeltaIds].sort()),
  };

  const setsFor = (r) => ({ ids: r.ids, complete: Boolean(r.evidence.status === 'COMPLETE' || (r.evidence.decode && r.evidence.decode.status === 'COMPLETE')) });
  const sets = { P: setsFor(P), F: setsFor(F), H: setsFor(H) };
  const rel = relations(OUT_DIR, sets);
  report.set_algebra = rel.evidence;
  report.set_algebra.cardinalities.C = { size: C.ids.size, set_complete: C.evidence.status === 'COMPLETE' };

  const U = rel.U || [];
  report.u_classification = classifyU(OUT_DIR, U, sets.H, nextDeltaIds, F.fieldCounts, H.fieldCounts);
  report.cross_cuts = {
    F_minus_P_minus_next_delta: writeSet(OUT_DIR, 'set-F_minus_P_minus_next_delta.json.gz', U.filter((x) => !nextDeltaIds.has(x))),
    H_minus_P_minus_next_delta: writeSet(OUT_DIR, 'set-H_minus_P_minus_next_delta.json.gz', diff(H.ids, sets.P.ids).filter((x) => !nextDeltaIds.has(x))),
    P_intersect_next_delta: writeSet(OUT_DIR, 'set-P_intersect_next_delta.json.gz', inter(sets.P.ids, nextDeltaIds)),
    suppressed_from_reharvest_and_absent_from_next_baseline: {
      definition: 'u in U=(F-P) that is NOT re-announced in the next delta AND is NOT in H',
      ...writeSet(OUT_DIR, 'set-suppressed_absent.json.gz', U.filter((x) => !nextDeltaIds.has(x) && !H.ids.has(x))),
    },
    failed_cycle_delta_ids: {
      status: 'EVIDENCE_SPLIT_ACROSS_ARTIFACTS',
      reason: `the pre-failure delta object was overwritten at ${PRE.next_delta_r2_write_utc}; its URL list survives only in the D-403 supplement artifact member url-set.json.gz`,
      join_instruction: 'intersect that member with member indexnow-next-url-set.json.gz here; both are canonical sorted url sets',
      pre_urlset_sha256: PRE.urlset_sha256, pre_url_count: PRE.url_count,
    },
  };

  report.origin_map = originMap(H.evidence.shards, C.evidence.shards, metaBackup);
  report.expanded_model = {
    recovered: { C: C.evidence.status, P: P.evidence.decode ? P.evidence.decode.status : P.evidence.status, F: F.evidence.decode ? F.evidence.decode.status : F.evidence.status, H: H.evidence.status },
    unavailable: {
      R3: 'no surviving carrier for the 3/4-restored baseline', M3: 'no surviving carrier for the 3/4-merged set',
      O3: 'no surviving carrier for the 3/4 output set', R4: 'no surviving carrier for the 4/4-restored baseline',
      M4: 'no surviving carrier for the 4/4-merged set (4/4 Final Upload was SKIPPED, so no committed 4/4 artifact exists)',
    },
  };

  report.prefixes_after = [];
  for (const p of PREFIXES) report.prefixes_after.push(await listPrefix(s3, p));
  report.torn_capture = PREFIXES.map((p, i) => classifyTorn(report.prefixes_before[i], report.prefixes_after[i]));

  const allComplete = ['C', 'H'].every((k) => report.registries[k].status === 'COMPLETE')
    && ['P', 'F'].every((k) => report.registries[k].decode && report.registries[k].decode.status === 'COMPLETE');
  report.summary = {
    status: allComplete ? 'COMPLETE' : 'PARTIAL_OR_FAILED_CLOSED',
    every_set_complete: allComplete,
    set_status: { C: C.evidence.status, H: H.evidence.status, P: P.evidence.decode ? P.evidence.decode.status : P.evidence.status, F: F.evidence.decode ? F.evidence.decode.status : F.evidence.status },
    identity_field: 'id',
    promotion_verdict: report.promotion_byte_close.verdict,
    indexnow_status: report.indexnow.status,
    torn_prefixes: report.torn_capture.filter((t) => t.classification !== 'COHERENT').map((t) => t.prefix),
    time_budget_minutes: Number(process.env.D403_BUDGET_MINUTES || 44),
  };
  const digest = packageUp(report);
  console.log(`[D403-POST] ${report.summary.status} promotion=${report.summary.promotion_verdict} package_sha256=${digest}`);
  return allComplete ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('d403-post-collect.mjs')) {
  main().then((c) => process.exit(c)).catch((e) => {
    try { fs.mkdirSync(OUT_DIR, { recursive: true }); write('collector-failure.json', Buffer.from(JSON.stringify({ failed_utc: nowUtc(), error_name: e && e.name ? e.name : 'Error', message: e && e.message ? e.message : 'unknown' }, null, 1))); } catch { /* artifact guard still fails closed */ }
    console.error(`[D403-POST] FAILED: ${e.message}`);
    process.exit(1);
  });
}
