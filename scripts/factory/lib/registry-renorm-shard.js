/**
 * OP-GR-B: NXVF shard access for the one-time registry re-normalisation
 * (FINDING-GR-1, ruling D-2026-0810-418).
 *
 * Uses the pipeline's OWN machinery -- shard-crypto.js for AES-256-CTR and
 * shard-writer.js (ShardWriter) for the NXVF V4.1 container. Neither the format
 * nor the crypto is re-implemented; this module only ADDS two things the
 * ordinary reader does not offer, both required by the ruling:
 *
 *   1. RAW TEXT RETENTION. registry-binary-reader.js returns parsed objects, so
 *      a rewrite through it would re-serialise all 1000 records per shard and
 *      could not promise byte-exactness for records it must not touch. Here an
 *      untouched record's decompressed JSON TEXT is carried through verbatim,
 *      so "only `tags` changed" is a property of the bytes, not a claim.
 *   2. A CHEAP SIZE PROBE. The cohort is defined by record BYTES, and
 *      decompressing ~47 GiB of entity text inside a harvest job is not
 *      acceptable. See zstdContentSize / zstdSizeBound below; correctness never
 *      depends on the optimisation -- the fallback is to decompress and measure.
 *
 * The IV is offset-derived (SHA-256(key || shardName || offset)), so shrinking
 * one record shifts every later offset and the WHOLE shard is re-encrypted.
 * That is why rewriteShard() rewrites end to end and why the output filename
 * must equal the input filename (asserted -- A3).
 */

import fs from 'fs';
import path from 'path';
import { initShardCrypto, decryptPayload, isEncryptionEnabled } from './shard-crypto.js';
import { ShardWriter } from './shard-writer.js';

const HEADER_SIZE = 29;
const NXVF_MAGIC = Buffer.from([0x4e, 0x58, 0x56, 0x46]);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

let _decompress = null;

/** Lazily bind fzstd, exactly as registry-binary-reader.js does. */
async function ensureDecompressor() {
    if (_decompress === null) {
        const fzstd = await import('fzstd');
        _decompress = (data) => Buffer.from(fzstd.decompress(data));
    }
    return _decompress;
}

/** Initialise the shared AES key from AES_CRYPTO_KEY. Value never leaves env. */
export function initCrypto() {
    initShardCrypto();
    return isEncryptionEnabled();
}

/** Parse the NXVF V4.1 header. */
export function parseHeader(data) {
    return {
        version: data.readUInt8(4),
        slotId: data.readUInt16LE(5),
        offsetTableOffset: data.readUInt32LE(7),
        entityCount: data.readUInt32LE(11),
        checksum: data.readUInt32LE(15),
    };
}

/**
 * Read a shard's container structure: whole-file buffer plus the offset table.
 * The file buffer is the COMPRESSED shard (single-digit MB), never the ~10 GiB
 * of decompressed entity text.
 */
export function readShardIndex(filePath) {
    const data = fs.readFileSync(filePath);
    if (data.length < HEADER_SIZE || !data.subarray(0, 4).equals(NXVF_MAGIC)) {
        throw new Error(`OP_GR_B_NOT_NXVF: ${path.basename(filePath)}`);
    }
    const header = parseHeader(data);
    const table = data.subarray(header.offsetTableOffset, header.offsetTableOffset + header.entityCount * 8);
    let computed = 0;
    for (let i = 0; i < table.length; i += 4) computed ^= table.readUInt32LE(i);
    const entries = [];
    for (let i = 0; i < header.entityCount; i++) {
        entries.push({ index: i, offset: table.readUInt32LE(i * 8), size: table.readUInt32LE(i * 8 + 4) });
    }
    return {
        data, header, entries,
        shardName: path.basename(filePath),
        checksumOk: (computed >>> 0) === header.checksum,
    };
}

/** Decrypted (still Zstd-compressed) payload for one entity. */
export function entityPayload(shard, entry) {
    const raw = Buffer.from(shard.data.subarray(entry.offset, entry.offset + entry.size));
    return isEncryptionEnabled() ? decryptPayload(shard.shardName, raw, entry.offset) : raw;
}

/** Zstd Block_Maximum_Size (RFC 8878 s3.1.1.2): min(Window_Size, 128 KiB). */
const BLOCK_MAX_BYTES = 128 * 1024;

/** End offset of the frame header, or -1 when the buffer is not a Zstd frame. */
function frameHeaderEnd(buf) {
    if (buf.length < 5 || !buf.subarray(0, 4).equals(ZSTD_MAGIC)) return -1;
    const fhd = buf.readUInt8(4);
    const singleSegment = (fhd >> 5) & 1;
    const didFieldSize = [0, 1, 2, 4][fhd & 3];
    const fcsFieldSize = [singleSegment ? 1 : 0, 2, 4, 8][fhd >> 6];
    return 5 + (singleSegment ? 0 : 1) + didFieldSize + fcsFieldSize;
}

/**
 * EXACT decompressed size when the frame declares Frame_Content_Size, else null.
 *
 * The declaration is OPTIONAL and this repo's writer omits it for larger
 * inputs: zstd-helper.js routes small buffers to the WASM codec (which pledges
 * the source size) and larger ones to the native zstd binary, whose frames
 * carry FCS_flag=0 with Single_Segment=0 -- no size at all. "Larger" is exactly
 * the class this lane must detect, hence zstdSizeBound() below.
 */
export function zstdContentSize(buf) {
    const fhd = buf.length >= 5 && buf.subarray(0, 4).equals(ZSTD_MAGIC) ? buf.readUInt8(4) : -1;
    if (fhd < 0) return null;
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    if (fcsFlag === 0 && !singleSegment) return null;
    const at = frameHeaderEnd(buf) - [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag];
    if (fcsFlag === 0) return buf.length > at ? buf.readUInt8(at) : null;
    if (fcsFlag === 1) return buf.length >= at + 2 ? buf.readUInt16LE(at) + 256 : null;
    if (fcsFlag === 2) return buf.length >= at + 4 ? buf.readUInt32LE(at) : null;
    if (buf.length < at + 8) return null;
    const big = buf.readBigUInt64LE(at);
    return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : null;
}

/**
 * RIGOROUS UPPER BOUND on a frame's decompressed size, computed by WALKING THE
 * BLOCK HEADERS without decompressing anything.
 *
 * Each block carries a 3-byte header (last-block flag, 2-bit type, 21-bit size).
 * Raw and RLE blocks state their decompressed size; a Compressed block expands
 * to at most Block_Maximum_Size. The sum is never smaller than the truth, so a
 * record can be ruled OUT of the cohort with certainty and never wrongly.
 *
 * This makes the scan affordable: an ordinary ~2 KB record is ONE block bounded
 * at 128 KiB and is dismissed without decompression, while anything that could
 * reach 32 MiB needs >= 256 blocks and is measured exactly. Returns null when
 * the frame cannot be walked or does not span the whole buffer (A1).
 */
export function zstdSizeBound(buf) {
    let at = frameHeaderEnd(buf);
    if (at < 0) return null;
    const hasChecksum = (buf.readUInt8(4) >> 2) & 1;
    let total = 0;
    while (at + 3 <= buf.length) {
        const header = buf.readUIntLE(at, 3);
        const last = header & 1;
        const type = (header >> 1) & 3;
        const size = header >>> 3;
        at += 3;
        if (type === 0) { total += size; at += size; }            // Raw
        else if (type === 1) { total += size; at += 1; }           // RLE
        else if (type === 2) { total += BLOCK_MAX_BYTES; at += size; } // Compressed
        else return null;                                          // Reserved
        if (!last) continue;
        // A1: sound only if this frame IS the whole payload -- a multi-frame buffer
        // decompresses to the SUM of its frames, so one frame alone UNDER-states.
        return at + (hasChecksum ? 4 : 0) === buf.length ? total : null;
    }
    return null;
}

/**
 * Decide whether one entity reaches `threshold` decompressed bytes.
 *
 * Three paths, cheapest first, all exact where it counts:
 *   frame-header  the frame declares its size -- exact, O(1)
 *   block-bound   the bound is below the threshold -- provably not giant, O(blocks)
 *   decompressed  the bound allows a giant -- decompress for the exact size
 */
export async function entityIsGiant(shard, entry, threshold) {
    const payload = entityPayload(shard, entry);
    const declared = zstdContentSize(payload);
    if (declared !== null) return { giant: declared >= threshold, bytes: declared, probed: 'frame-header' };
    const bound = zstdSizeBound(payload);
    if (bound !== null && bound < threshold) return { giant: false, bytes: null, probed: 'block-bound' };
    const dec = await ensureDecompressor();
    const bytes = dec(payload).length;
    return { giant: bytes >= threshold, bytes, probed: 'decompressed' };
}

/** Decompressed JSON TEXT of one entity, as a Buffer (never parsed here). */
export async function entityText(shard, entry) {
    const payload = entityPayload(shard, entry);
    if (!payload.subarray(0, 4).equals(ZSTD_MAGIC)) return payload;
    const dec = await ensureDecompressor();
    return dec(payload);
}

/**
 * Rewrite a shard in place-equivalent form.
 *
 * `replacements` maps entity INDEX -> Buffer of replacement JSON text. Every
 * other entity is carried through as its original decompressed bytes, so the
 * only records whose serialised form can differ are the ones named here.
 *
 * Writes to `tmpDir/<same basename>` -- the filename is load-bearing because it
 * feeds the IV derivation -- and returns the new file's path and stats. The
 * caller performs the swap; this function never deletes the original.
 */
export async function rewriteShard(filePath, tmpDir, replacements) {
    const shard = readShardIndex(filePath);
    const base = path.basename(filePath);
    const m = base.match(/^part-(\d+)\.bin$/);
    if (!m) throw new Error(`OP_GR_B_BAD_SHARD_NAME: ${base}`);

    fs.mkdirSync(tmpDir, { recursive: true });
    const writer = new ShardWriter(tmpDir, 'part');
    await writer.init();
    writer.shardId = parseInt(m[1], 10);
    // A3: filename feeds the IV (SHA-256(key || shardName || offset)); a drift yields a shard nothing can decrypt.
    const produced = writer.open();
    if (produced !== base) throw new Error(`OP_GR_B_SHARD_NAME_MISMATCH: ${produced} != ${base}`);

    let written = 0, replaced = 0, bytesIn = 0, bytesOut = 0;
    for (const entry of shard.entries) {
        const swap = replacements.get(entry.index);
        const original = await entityText(shard, entry);
        bytesIn += original.length;
        const payload = swap || original;
        bytesOut += payload.length;
        if (swap) replaced++;
        writer.writeEntity(payload);
        written++;
    }
    writer.finalize();

    if (written !== shard.header.entityCount) {
        throw new Error(`OP_GR_B_COUNT_DRIFT: ${base} wrote ${written} of ${shard.header.entityCount}`);
    }
    if (replaced !== replacements.size) {
        throw new Error(`OP_GR_B_REPLACEMENT_MISS: ${base} applied ${replaced} of ${replacements.size}`);
    }
    const outPath = path.join(tmpDir, base);
    return {
        outPath, entityCount: written, replaced,
        textBytesBefore: bytesIn, textBytesAfter: bytesOut,
        fileBytesBefore: shard.data.length, fileBytesAfter: fs.statSync(outPath).size,
    };
}

/** Count entities in a shard file (post-write verification helper). */
export function entityCountOf(filePath) {
    return readShardIndex(filePath).header.entityCount;
}
