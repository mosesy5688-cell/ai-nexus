// Read-path P1: canonical warm-tier id-index.bin generator.
//
// Mirrors the hot-shard / vector-core zero-copy binary producers, but covers
// the FULL corpus (~550K entities) instead of the top-30k. Maps every id, slug
// and umid form to the SINGLE meta-shard the packer actually wrote the entity to
// (computeMetaShardSlot on e.slug||e.id, identical to pack-db.js insert routing)
// plus a few core card fields, so the read path can resolve any id to its one
// correct shard WITHOUT sweeping all shards (the per-op-hang failure mode).
//
// ---------------------------------------------------------------------------
// Binary layout (little-endian, version 1) — documented for id-index-reader.ts:
//
//   Header (32 bytes):
//     0  magic            "IDIX" (4 ascii bytes)
//     4  version          UInt16  (= 1)
//     6  reserved         UInt16
//     8  keyCount         UInt32  (number of key-table entries; >= recordCount)
//    12  recordCount      UInt32  (number of records)
//    16  keyTableOffset   UInt32  (byte offset of key table)
//    20  recordTableOffset UInt32 (byte offset of record table)
//    24  strPoolOffset    UInt32  (byte offset of string pool)
//    28  reserved         UInt32
//
//   Key table: keyCount entries x 12 bytes, SORTED ascending by keyHash for
//   binary search. Each entry:
//     +0  keyHash          BigUInt64  (xxhash64 of the lowercased key form)
//     +8  recordIdx        UInt32     (index into the record table)
//
//   Record table: recordCount entries x RECORD_SIZE (=24) bytes. Each entry:
//     +0  shardIdx         UInt16  (meta-NN.db slot; canonical write shard)
//     +2  type             UInt8   (TYPE_ENUM, 255 = unknown)
//     +3  flags            UInt8   (bit0 = is_trending)
//     +4  fniScore         Float32
//     +8  namePoolOff      UInt32  (offset into string pool)
//    +12  nameLen          UInt16
//    +14  summaryPoolOff   UInt32
//    +18  summaryLen       UInt16
//    +20  slugPoolOff      UInt32
//    +24  slugLen          UInt16
//        -> RECORD_SIZE = 26 bytes (fixed, enables O(1) record addressing).
//
//   String pool: raw UTF-8 bytes for name / truncated summary / slug, addressed
//   by (offset, len) from strPoolOffset.
//
// Lookup contract: hash the normalized lowercased query, binary-search the key
// table; on hit read the record -> { shardIdx, type, fniScore, isTrending,
// name, summary, slug }. A hash collision cannot return wrong DATA because the
// caller still runs the real SELECT (id/slug/umid) on the routed shard; a wrong
// route merely degrades to the existing all-shard probe fallback.
// ---------------------------------------------------------------------------

import fsSync from 'fs';
import path from 'path';
import { computeMetaShardSlot } from './meta-shard-router.js';
import { META_SHARD_COUNT } from '../../../src/constants/shard-constants.js';
import { xxhash64 } from '../../../src/utils/xxhash64-core.js';

const ID_INDEX_PATH = './output/data/id-index.bin';
const TYPE_ENUM = { model: 0, dataset: 1, agent: 2, tool: 3, space: 4, paper: 5, prompt: 6 };
const HEADER_SIZE = 32;
const KEY_ENTRY_SIZE = 12;
const RECORD_SIZE = 26;
const SUMMARY_MAX = 160; // truncated card summary

function pushKey(keySet, keys, form, recordIdx) {
    if (!form) return;
    const norm = String(form).toLowerCase();
    if (!norm || keySet.has(norm)) return;
    keySet.add(norm);
    // Reader hashes the identical lowercased key via the same xxhash64 core.
    keys.push({ hash: xxhash64(norm), recordIdx });
}

/**
 * Generate data/id-index.bin from the packed meta shards.
 * @param {Object} metaDbs - map slot_N -> better-sqlite3 Database (open).
 */
export function generateIdIndex(metaDbs) {
    console.log('[IdIndex] Building full-corpus id-index.bin...');
    const encoder = new TextEncoder();

    const records = [];      // { shardIdx, type, flags, fni, name/sum/slug bufs }
    const keys = [];         // { hash, recordIdx }
    const keySet = new Set(); // global de-dup of normalized key forms
    const stringBuffers = [];
    let poolSize = 0;
    let nullSlug = 0;

    for (const db of Object.values(metaDbs)) {
        const rows = db.prepare(
            `SELECT id, slug, umid, name, type, summary, fni_score, is_trending FROM entities`
        ).iterate();
        for (const r of rows) {
            const slug = r.slug || (r.id ? String(r.id).toLowerCase() : '');
            if (!slug) { nullSlug++; continue; }
            // Canonical write shard — IDENTICAL routing to pack-db.js insert.
            const shardIdx = computeMetaShardSlot(slug, META_SHARD_COUNT);

            const nameStr = String(r.name || '');
            let sumStr = String(r.summary || '');
            if (sumStr.length > SUMMARY_MAX) sumStr = sumStr.substring(0, SUMMARY_MAX);

            const nameBuf = encoder.encode(nameStr);
            const sumBuf = encoder.encode(sumStr);
            const slugBuf = encoder.encode(String(r.slug || slug));

            const recordIdx = records.length;
            records.push({
                shardIdx,
                type: TYPE_ENUM[r.type] ?? 255,
                flags: r.is_trending ? 1 : 0,
                fni: Number(r.fni_score) || 0,
                nameOff: poolSize,
                nameLen: nameBuf.byteLength,
                sumOff: poolSize + nameBuf.byteLength,
                sumLen: sumBuf.byteLength,
                slugOff: poolSize + nameBuf.byteLength + sumBuf.byteLength,
                slugLen: slugBuf.byteLength,
            });
            stringBuffers.push(nameBuf, sumBuf, slugBuf);
            poolSize += nameBuf.byteLength + sumBuf.byteLength + slugBuf.byteLength;

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
    const strPoolOffset = recordTableOffset + records.length * RECORD_SIZE;
    const totalSize = strPoolOffset + poolSize;

    const buf = Buffer.alloc(totalSize);
    buf.write('IDIX', 0, 4, 'ascii');
    buf.writeUInt16LE(1, 4);
    buf.writeUInt32LE(keys.length, 8);
    buf.writeUInt32LE(records.length, 12);
    buf.writeUInt32LE(keyTableOffset, 16);
    buf.writeUInt32LE(recordTableOffset, 20);
    buf.writeUInt32LE(strPoolOffset, 24);

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
        buf.writeUInt32LE(rec.nameOff, off + 8);
        buf.writeUInt16LE(Math.min(rec.nameLen, 0xFFFF), off + 12);
        buf.writeUInt32LE(rec.sumOff, off + 14);
        buf.writeUInt16LE(Math.min(rec.sumLen, 0xFFFF), off + 18);
        buf.writeUInt32LE(rec.slugOff, off + 20);
        buf.writeUInt16LE(Math.min(rec.slugLen, 0xFFFF), off + 24);
    }

    let poolPos = strPoolOffset;
    for (const sb of stringBuffers) {
        buf.set(sb, poolPos);
        poolPos += sb.byteLength;
    }

    fsSync.mkdirSync(path.dirname(ID_INDEX_PATH), { recursive: true });
    fsSync.writeFileSync(ID_INDEX_PATH, buf);
    console.log(
        `[IdIndex] Generated ${ID_INDEX_PATH} ` +
        `(${records.length} entities, ${keys.length} keys, ${(totalSize / 1024 / 1024).toFixed(2)} MB)` +
        (nullSlug ? ` [skipped ${nullSlug} slug-less rows]` : '')
    );
}
