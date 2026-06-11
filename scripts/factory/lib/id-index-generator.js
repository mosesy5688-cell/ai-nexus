// Read-path P1: canonical warm-tier id-index.bin generator (slim v2).
//
// Mirrors the hot-shard / vector-core zero-copy binary producers, but covers
// the FULL corpus (~550K entities) instead of the top-30k. Maps every id, slug
// and umid form to the SINGLE meta-shard the packer actually wrote the entity to
// (computeMetaShardSlot on e.slug||e.id, identical to pack-db.js insert routing)
// so the read path can resolve any id to its one correct shard WITHOUT sweeping
// all shards (the per-op-hang failure mode).
//
// v2 is POINTER-ONLY: the consumer (resolveShardsForCandidates in
// src/lib/entity-absence-oracle.ts) uses hit.shardIdx to BOTH shrink the
// candidate fan-out to the resolved shard AND prove absence when no candidate
// resolves; it never reads name/summary/slug. The v1 string pool (name + 160-char summary
// + slug per entity) bloated the file to ~117 MB (~10x), forcing the reader to
// pull the whole blob into the 128 MB CF Worker isolate (OOM-fragile, latent
// 1102). Dropping the string pool shrinks the file to ~10-15 MB for ~551K
// entities. type / fniScore are retained (cheap, fixed-width) for future routing
// heuristics without re-baking the format.
//
// ---------------------------------------------------------------------------
// Binary layout (little-endian, version 2) — documented for id-index-reader.ts:
//
//   Header (32 bytes):
//     0  magic            "IDIX" (4 ascii bytes)
//     4  version          UInt16  (= 2)
//     6  reserved         UInt16
//     8  keyCount         UInt32  (number of key-table entries; >= recordCount)
//    12  recordCount      UInt32  (number of records)
//    16  keyTableOffset   UInt32  (byte offset of key table)
//    20  recordTableOffset UInt32 (byte offset of record table)
//    24  reserved         UInt32  (was strPoolOffset in v1; always 0 in v2)
//    28  reserved         UInt32
//
//   Key table: keyCount entries x 12 bytes, SORTED ascending by keyHash for
//   binary search. Each entry:
//     +0  keyHash          BigUInt64  (xxhash64 of the lowercased key form)
//     +8  recordIdx        UInt32     (index into the record table)
//
//   Record table: recordCount entries x RECORD_SIZE (=8) bytes. Each entry:
//     +0  shardIdx         UInt16  (meta-NN.db slot; canonical write shard)
//     +2  type             UInt8   (TYPE_ENUM, 255 = unknown)
//     +3  flags            UInt8   (bit0 = is_trending)
//     +4  fniScore         Float32
//        -> RECORD_SIZE = 8 bytes (fixed, enables O(1) record addressing).
//
//   No string pool (v1's name/summary/slug bytes are gone).
//
// Lookup contract: hash the normalized lowercased query, binary-search the key
// table; on hit read the record -> { shardIdx, type, fniScore, isTrending }. A
// hash collision cannot return wrong DATA because the caller still runs the real
// SELECT (id/slug/umid) on the routed shard; a wrong route merely degrades to
// the existing all-shard probe fallback.
// ---------------------------------------------------------------------------

import fsSync from 'fs';
import path from 'path';
import { computeMetaShardSlot } from './meta-shard-router.js';
import { META_SHARD_COUNT } from '../../../src/constants/shard-constants.js';
import { xxhash64 } from '../../../src/utils/xxhash64-core.js';

const ID_INDEX_PATH = './output/data/id-index.bin';
// Live 5-type set (agent/space/prompt were cancelled; benchmark is the 5th type).
// Stable int values for the long-lived types (model/dataset/tool/paper) are kept
// so any future routing heuristic that hardcodes them stays valid; benchmark takes
// a fresh slot (6). The record `type` byte is written but NOT yet read by any
// consumer (entity-absence-oracle.ts uses only shardIdx), and id-index.bin is
// rebaked every cycle (never persisted across format), so the reassignment is
// format- and consumer-safe — it only stops benchmark rows mapping to 255/unknown.
const TYPE_ENUM = { model: 0, dataset: 1, tool: 3, paper: 5, benchmark: 6 };
const FORMAT_VERSION = 2;
const HEADER_SIZE = 32;
const KEY_ENTRY_SIZE = 12;
const RECORD_SIZE = 8; // slim: shardIdx(2) + type(1) + flags(1) + fniScore(4)

function pushKey(keySet, keys, form, recordIdx) {
    if (!form) return;
    const norm = String(form).toLowerCase();
    if (!norm || keySet.has(norm)) return;
    keySet.add(norm);
    // Reader hashes the identical lowercased key via the same xxhash64 core.
    keys.push({ hash: xxhash64(norm), recordIdx });
}

/**
 * Generate data/id-index.bin (slim v2) from the packed meta shards.
 * @param {Object} metaDbs - map slot_N -> better-sqlite3 Database (open).
 */
export function generateIdIndex(metaDbs) {
    console.log('[IdIndex] Building full-corpus id-index.bin (slim v2)...');

    const records = [];      // { shardIdx, type, flags, fni }
    const keys = [];         // { hash, recordIdx }
    const keySet = new Set(); // global de-dup of normalized key forms
    let nullSlug = 0;

    for (const db of Object.values(metaDbs)) {
        const rows = db.prepare(
            `SELECT id, slug, umid, type, fni_score, is_trending FROM entities`
        ).iterate();
        for (const r of rows) {
            const slug = r.slug || (r.id ? String(r.id).toLowerCase() : '');
            if (!slug) { nullSlug++; continue; }
            // Canonical write shard — IDENTICAL routing to pack-db.js insert.
            const shardIdx = computeMetaShardSlot(slug, META_SHARD_COUNT);

            const recordIdx = records.length;
            records.push({
                shardIdx,
                type: TYPE_ENUM[r.type] ?? 255,
                flags: r.is_trending ? 1 : 0,
                fni: Number(r.fni_score) || 0,
            });

            // Every resolvable form -> this record (de-duped, lowercased).
            pushKey(keySet, keys, r.slug, recordIdx);
            pushKey(keySet, keys, r.id, recordIdx);
            pushKey(keySet, keys, r.umid, recordIdx);
        }
    }

    if (records.length === 0) {
        console.warn('[IdIndex] No entities found — skipping id-index.bin.');
        return;
    }

    // Sort keys ascending by hash so the reader can binary-search.
    keys.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

    const keyTableOffset = HEADER_SIZE;
    const recordTableOffset = keyTableOffset + keys.length * KEY_ENTRY_SIZE;
    const totalSize = recordTableOffset + records.length * RECORD_SIZE;

    const buf = Buffer.alloc(totalSize);
    buf.write('IDIX', 0, 4, 'ascii');
    buf.writeUInt16LE(FORMAT_VERSION, 4);
    buf.writeUInt32LE(keys.length, 8);
    buf.writeUInt32LE(records.length, 12);
    buf.writeUInt32LE(keyTableOffset, 16);
    buf.writeUInt32LE(recordTableOffset, 20);
    // Offset 24 (v1 strPoolOffset) is reserved/0 in v2; Buffer.alloc zero-fills.

    for (let i = 0; i < keys.length; i++) {
        const off = keyTableOffset + i * KEY_ENTRY_SIZE;
        buf.writeBigUInt64LE(BigInt.asUintN(64, keys[i].hash), off);
        buf.writeUInt32LE(keys[i].recordIdx, off + 8);
    }

    for (let i = 0; i < records.length; i++) {
        const off = recordTableOffset + i * RECORD_SIZE;
        const rec = records[i];
        buf.writeUInt16LE(rec.shardIdx, off + 0);
        buf.writeUInt8(rec.type, off + 2);
        buf.writeUInt8(rec.flags, off + 3);
        buf.writeFloatLE(rec.fni, off + 4);
    }

    fsSync.mkdirSync(path.dirname(ID_INDEX_PATH), { recursive: true });
    fsSync.writeFileSync(ID_INDEX_PATH, buf);
    console.log(
        `[IdIndex] Generated ${ID_INDEX_PATH} (slim v2) ` +
        `(${records.length} entities, ${keys.length} keys, ${(totalSize / 1024 / 1024).toFixed(2)} MB)` +
        (nullSlug ? ` [skipped ${nullSlug} slug-less rows]` : '')
    );
}
