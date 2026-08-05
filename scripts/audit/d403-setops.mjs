// D-403 POST: set algebra, U-classification, per-part origin map and the
// promotion byte-close table. Pure functions over already-recovered evidence.
// No I/O to R2, no mutation; the only writes are artifact members under OUT_DIR.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sha256 } from './d403-r2-read.mjs';

/** Canonical sorted difference / intersection helpers. */
export const diff = (a, b) => [...a].filter((x) => !b.has(x)).sort();
export const inter = (a, b) => [...a].filter((x) => b.has(x)).sort();
export const canonicalHash = (sorted) => sha256(sorted.join('\n'));

/** Write a canonical sorted set as a REAL compressed artifact member. */
export function writeSet(outDir, member, sorted) {
  fs.writeFileSync(path.join(outDir, member), zlib.gzipSync(Buffer.from(JSON.stringify(sorted))));
  return { member, count: sorted.length, canonical_sha256: canonicalHash(sorted) };
}

/**
 * Every required set relation. `sets` maps label -> { ids:Set, complete:bool }.
 * A relation whose inputs are not both COMPLETE is emitted with
 * derived_from_complete_inputs=false so it is never mistaken for authoritative.
 */
export function relations(outDir, sets) {
  const { P, F, H } = sets;
  const out = { cardinalities: {}, relations: {} };
  for (const [k, v] of Object.entries(sets)) {
    out.cardinalities[k] = { size: v.ids.size, set_complete: v.complete };
  }
  const rel = (name, a, b, op) => {
    if (!a || !b) { out.relations[name] = { status: 'EVIDENCE_UNAVAILABLE' }; return null; }
    const sorted = op(a.ids, b.ids);
    out.relations[name] = {
      ...writeSet(outDir, `set-${name.replace(/[^a-z0-9]+/gi, '_')}.json.gz`, sorted),
      derived_from_complete_inputs: Boolean(a.complete && b.complete),
    };
    return sorted;
  };
  const fMinusP = rel('F_minus_P', F, P, diff);
  rel('P_minus_F', P, F, diff);
  rel('H_minus_F', H, F, diff);
  rel('P_minus_H', P, H, diff);
  rel('H_minus_P', H, P, diff);
  // U = F - P, then U vs H.
  if (fMinusP && H) {
    const U = new Set(fMinusP);
    out.relations.U_definition = 'U = F - P';
    out.relations.U_intersect_H = {
      ...writeSet(outDir, 'set-U_intersect_H.json.gz', inter(U, H.ids)),
      derived_from_complete_inputs: Boolean(F.complete && P.complete && H.complete),
    };
    out.relations.U_minus_H = {
      ...writeSet(outDir, 'set-U_minus_H.json.gz', diff(U, H.ids)),
      derived_from_complete_inputs: Boolean(F.complete && P.complete && H.complete),
    };
  }
  return { evidence: out, U: fMinusP };
}

/**
 * Machine-classify EVERY member of U. Rules are stated in the report so a
 * reviewer can re-derive them; anything the available evidence cannot decide is
 * EVIDENCE_UNAVAILABLE rather than a guess.
 */
export const CLASSIFICATION_RULES = Object.freeze({
  EVIDENCE_UNAVAILABLE: 'H (next effective baseline) is not a COMPLETE set, so membership cannot be decided',
  REHARVESTED_AND_MERGED: 'u in H AND u in next-cycle IndexNow delta ids (re-announced as new this cycle)',
  CARRIED_FORWARD_BUT_INCOMPLETE: 'u in H, not re-announced, and the H row has strictly FEWER populated top-level fields than the F row',
  CARRIED_FORWARD_COMPLETE: 'u in H, not re-announced, and the H row has >= the F row populated top-level field count',
  DROPPED_FROM_NEXT_OUTPUT: 'u not in H',
  IDENTITY_CHANGED: 'requires a producer-emitted identity-remap record; no such record exists in this evidence set, so this bucket is never assigned here',
});

export function classifyU(outDir, U, H, nextDeltaIds, fFields, hFields) {
  const buckets = {
    CARRIED_FORWARD_COMPLETE: [], CARRIED_FORWARD_BUT_INCOMPLETE: [], REHARVESTED_AND_MERGED: [],
    DROPPED_FROM_NEXT_OUTPUT: [], IDENTITY_CHANGED: [], EVIDENCE_UNAVAILABLE: [],
  };
  for (const u of U) {
    if (!H || !H.complete) { buckets.EVIDENCE_UNAVAILABLE.push(u); continue; }
    if (!H.ids.has(u)) { buckets.DROPPED_FROM_NEXT_OUTPUT.push(u); continue; }
    if (nextDeltaIds && nextDeltaIds.has(u)) { buckets.REHARVESTED_AND_MERGED.push(u); continue; }
    const fN = fFields ? fFields.get(u) : undefined;
    const hN = hFields ? hFields.get(u) : undefined;
    if (typeof fN === 'number' && typeof hN === 'number' && hN < fN) buckets.CARRIED_FORWARD_BUT_INCOMPLETE.push(u);
    else if (typeof fN === 'number' && typeof hN === 'number') buckets.CARRIED_FORWARD_COMPLETE.push(u);
    else buckets.EVIDENCE_UNAVAILABLE.push(u);
  }
  const summary = { rules: CLASSIFICATION_RULES, total_classified: U.length, buckets: {} };
  for (const [name, list] of Object.entries(buckets)) {
    list.sort();
    summary.buckets[name] = writeSet(outDir, `class-${name}.json.gz`, list);
  }
  const sum = Object.values(summary.buckets).reduce((a, b) => a + b.count, 0);
  summary.every_member_classified_exactly_once = sum === U.length;
  return summary;
}

/**
 * part-N -> CACHE_29963927733 / PUBLICATION_COMMITTED_R2 / OTHER / UNAVAILABLE,
 * decided by exact per-part sha256 identity against each candidate origin.
 */
export function originMap(targetShards, cacheShards, r2ShardsByName) {
  const cacheBy = new Map((cacheShards || []).map((s) => [s.name, s.sha256]));
  const rows = [];
  for (const s of targetShards) {
    const r2 = r2ShardsByName.get(s.name);
    let origin = 'OTHER';
    if (!s.sha256) origin = 'UNAVAILABLE';
    else if (cacheBy.get(s.name) === s.sha256) origin = 'CACHE_29963927733';
    else if (r2 && r2 === s.sha256) origin = 'PUBLICATION_COMMITTED_R2';
    rows.push({ part: s.name, sha256: s.sha256 || null, cache_sha256: cacheBy.get(s.name) || null, r2_sha256: r2 || null, origin });
  }
  const tally = {};
  for (const r of rows) tally[r.origin] = (tally[r.origin] || 0) + 1;
  return { rows, tally };
}

/**
 * Byte-close the promotion finding: meta/backup/registry/part-632..645 sha256
 * vs the SAME part names computed from the F handoff archive in this run.
 * Reports identity only; asserts nothing about how the bytes got there.
 */
export function promotionByteClose(metaBackupShards, fShards, partNames) {
  const fBy = new Map((fShards || []).map((s) => [s.name, s.sha256]));
  const rows = partNames.map((name) => {
    const meta = metaBackupShards.get(name) || null;
    const f = fBy.get(name) || null;
    return { part: name, meta_backup_sha256: meta, F_sha256: f, identical: Boolean(meta && f && meta === f) };
  });
  const decided = rows.filter((r) => r.meta_backup_sha256 && r.F_sha256);
  return {
    scope: 'meta/backup/registry/part-632.bin .. part-645.bin vs F handoff archive same-named shards',
    interpretation_policy: 'byte identity is reported as observed; NO causal claim is made about how these objects reached meta/backup/registry',
    rows,
    parts_examined: rows.length,
    parts_with_both_sides_present: decided.length,
    parts_identical: decided.filter((r) => r.identical).length,
    parts_differing: decided.filter((r) => !r.identical).length,
    verdict: decided.length === 0 ? 'UNDECIDABLE_MISSING_EVIDENCE'
      : decided.length === rows.length && decided.every((r) => r.identical) ? 'BYTE_IDENTICAL_ALL_PARTS'
        : decided.every((r) => r.identical) ? 'BYTE_IDENTICAL_WHERE_BOTH_PRESENT' : 'NOT_BYTE_IDENTICAL',
  };
}
