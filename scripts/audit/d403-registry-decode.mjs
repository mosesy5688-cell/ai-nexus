// D-403 POST: STRICT registry-shard decoder with a fail-closed contract.
//
// Successful decryption alone is NOT sufficient. A registry is COMPLETE only if
// every expected shard decoded, decoded rows == NXVF header rows FOR EVERY
// SHARD, the totals agree, and every row carries the authoritative identity.
// Anything else is reported as FAILED_CLOSED / PARTIAL with explicit reasons.
// A missing or wrong key can therefore never yield an empty set presented as
// valid: zero decoded rows against non-zero header rows is a hard failure.
//
// AUTHORITATIVE IDENTITY FIELD = `id`. Single field, NO fallback chain.
// Established by the production producer/consumer contract:
//   scripts/factory/lib/registry-manager.js:66  `id TEXT PRIMARY KEY`
//   scripts/factory/lib/registry-manager.js:132 `const id = normalizeId(e.id, ...)`
//   scripts/factory/lib/registry-manager.js:144 `sessionAddedIds.push({ id, ... })`
// The row is written as `{ ...e, id, ... }`, so `id` is the normalized primary
// key of every registry row. `canonical_id` / `umid` / `entity_id` are NOT part
// of that contract and are deliberately not consulted.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decompress as zstdDecompress } from 'fzstd';
import { initShardCrypto, decryptPayload, isEncryptionEnabled } from '../factory/lib/shard-crypto.js';
import { sha256 } from './d403-r2-read.mjs';

export const IDENTITY_FIELD = 'id';
export const IDENTITY_CITATION =
  'scripts/factory/lib/registry-manager.js:66 (id TEXT PRIMARY KEY); :132 (normalizeId -> id); :144 (sessionAddedIds)';

const HEADER_SIZE = 29;
const NXVF_MAGIC = '4e585646';
const ZSTD_MAGIC = '28b52ffd';
const GZIP_MAGIC = '1f8b';
const SHARD_RE = /^part-(\d+)\.bin$/;

/** Validate key PRESENCE and FORMAT without printing or returning any part of it. */
export function initCrypto() {
  const raw = process.env.AES_CRYPTO_KEY;
  const present = typeof raw === 'string' && raw.length > 0;
  const formatValid = present && raw.length >= 64 && /^[0-9a-fA-F]{64}/.test(raw);
  if (formatValid) initShardCrypto();
  return { key_present: present, key_format_production_compatible: Boolean(formatValid), encryption_active: isEncryptionEnabled() };
}

export function parseHeader(buf) {
  if (buf.length < HEADER_SIZE || buf.subarray(0, 4).toString('hex') !== NXVF_MAGIC) return null;
  return { offsetTableOffset: buf.readUInt32LE(7), entityCount: buf.readUInt32LE(11) };
}

function inflate(payload) {
  const head4 = payload.subarray(0, 4).toString('hex');
  if (head4 === ZSTD_MAGIC) return Buffer.from(zstdDecompress(payload));
  if (payload.subarray(0, 2).toString('hex') === GZIP_MAGIC) {
    try { return zlib.gunzipSync(payload); } catch { return payload; }
  }
  return payload;
}

/** Decode ONE shard strictly. Never swallows a row: any loss shows up as
 *  decoded_rows < header_rows, which fails the shard. */
function decodeShard(dir, name, onRow) {
  const full = path.join(dir, name);
  const buf = fs.readFileSync(full);
  const rec = { name, size: buf.length, sha256: sha256(buf), header_rows: null, decoded_rows: 0, missing_identity_rows: 0, error: null };
  const header = parseHeader(buf);
  if (!header) { rec.error = 'NOT_AN_NXVF_SHARD'; return rec; }
  rec.header_rows = header.entityCount;
  const table = buf.subarray(header.offsetTableOffset, header.offsetTableOffset + header.entityCount * 8);
  for (let i = 0; i < header.entityCount; i++) {
    const offset = table.readUInt32LE(i * 8);
    const size = table.readUInt32LE(i * 8 + 4);
    try {
      let payload = Buffer.from(buf.subarray(offset, offset + size));
      if (isEncryptionEnabled()) payload = decryptPayload(name, payload, offset);
      const row = JSON.parse(inflate(payload).toString('utf-8'));
      const id = row ? row[IDENTITY_FIELD] : undefined;
      if (typeof id !== 'string' || id.length === 0) { rec.missing_identity_rows += 1; continue; }
      rec.decoded_rows += 1;
      onRow(id, row);
    } catch (e) {
      if (!rec.error) rec.error = `ROW_DECODE_FAILED: ${e && e.name ? e.name : 'Error'}`;
    }
  }
  return rec;
}

/**
 * Decode a whole registry directory under the fail-closed contract.
 * `probe` (optional) = { urlSet:Set, route:(id,type)=>string|null } records which
 * rows map onto a URL of interest, without materialising URLs for every row.
 */
export function countPopulatedFields(row) {
  let n = 0;
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    n += 1;
  }
  return n;
}

export function decodeRegistryDir(label, dir, { deadlineMs = Infinity, probe = null, expectedShards = null, trackFieldCount = false } = {}) {
  const out = {
    label, shard_dir: dir, identity_field: IDENTITY_FIELD, identity_citation: IDENTITY_CITATION,
    status: 'UNKNOWN', reasons: [], shards: [], expected_shard_count: null, decoded_shard_count: 0,
    total_header_rows: 0, total_decoded_rows: 0, missing_identity_rows: 0,
    unique_identity_cardinality: 0, repeated_distinct_identity_count: 0, excess_duplicate_row_count: 0,
  };
  const ids = new Set();
  const repeated = new Set();
  const probeHits = new Set();
  const fieldCounts = trackFieldCount ? new Map() : null;
  if (!fs.existsSync(dir)) {
    out.status = 'EVIDENCE_UNAVAILABLE';
    out.reasons.push('SHARD_DIR_ABSENT');
    return { evidence: out, ids, probeHits, fieldCounts };
  }
  const names = fs.readdirSync(dir).filter((n) => SHARD_RE.test(n)).sort();
  out.expected_shard_count = expectedShards === null ? names.length : expectedShards;
  let excess = 0;
  const onRow = (id, row) => {
    if (ids.has(id)) { repeated.add(id); excess += 1; } else { ids.add(id); }
    if (fieldCounts) fieldCounts.set(id, countPopulatedFields(row));
    // The probe is auxiliary: a routing error must never corrupt the decode
    // contract for the row, so it is isolated and counted, not thrown.
    if (probe) {
      try {
        const url = probe.route(id, row.type);
        if (url && probe.urlSet.has(url)) probeHits.add(id);
      } catch { out.probe_route_errors = (out.probe_route_errors || 0) + 1; }
    }
  };
  for (const name of names) {
    if (Date.now() > deadlineMs) {
      out.status = 'PARTIAL_TIME_BUDGET';
      out.reasons.push(`TIME_BUDGET_EXCEEDED_AFTER_${out.decoded_shard_count}_OF_${names.length}_SHARDS`);
      break;
    }
    let rec;
    try {
      rec = decodeShard(dir, name, onRow);
    } catch (e) {
      rec = { name, error: `SHARD_READ_FAILED: ${e && e.message ? e.message : 'Error'}`, header_rows: null, decoded_rows: 0, missing_identity_rows: 0 };
    }
    rec.rows_match = rec.header_rows !== null && rec.decoded_rows === rec.header_rows;
    out.shards.push(rec);
    out.decoded_shard_count += 1;
    out.total_header_rows += rec.header_rows || 0;
    out.total_decoded_rows += rec.decoded_rows;
    out.missing_identity_rows += rec.missing_identity_rows;
  }
  out.unique_identity_cardinality = ids.size;
  out.repeated_distinct_identity_count = repeated.size;
  out.excess_duplicate_row_count = excess;
  finalise(out, names.length);
  return { evidence: out, ids, probeHits, fieldCounts };
}

/** Apply the fail-closed contract. COMPLETE requires ALL conditions. */
function finalise(out, presentShardCount) {
  if (out.status === 'PARTIAL_TIME_BUDGET') return;
  if (out.expected_shard_count !== null && presentShardCount !== out.expected_shard_count) {
    out.reasons.push(`SHARD_COUNT_MISMATCH_present=${presentShardCount}_expected=${out.expected_shard_count}`);
  }
  if (out.decoded_shard_count !== presentShardCount) out.reasons.push('NOT_EVERY_SHARD_PROCESSED');
  const badShards = out.shards.filter((s) => !s.rows_match);
  if (badShards.length) {
    out.reasons.push(`PER_SHARD_ROW_MISMATCH_count=${badShards.length}`);
    out.per_shard_mismatches = badShards.slice(0, 50).map((s) => ({ name: s.name, header_rows: s.header_rows, decoded_rows: s.decoded_rows, error: s.error }));
    out.per_shard_mismatch_total = badShards.length;
  }
  if (out.total_decoded_rows !== out.total_header_rows) out.reasons.push('TOTAL_ROW_MISMATCH');
  if (out.missing_identity_rows > 0) out.reasons.push(`ROWS_WITHOUT_IDENTITY_FIELD=${out.missing_identity_rows}`);
  if (out.total_header_rows > 0 && out.total_decoded_rows === 0) out.reasons.push('ZERO_ROWS_DECODED_AGAINST_NONZERO_HEADER_ROWS');
  out.status = out.reasons.length === 0 && out.total_header_rows > 0 ? 'COMPLETE' : 'FAILED_CLOSED';
  out.usable_as_complete_set = out.status === 'COMPLETE';
}
