/**
 * V25.8 Binary Shard Reader — NXVF V4.1 Decoder
 * Reads binary registry shards with Zstd decompression + AES-CTR decryption.
 * Transparent fallback: returns null for non-binary files so caller can use JSON.gz path.
 */

import fs from 'fs';
import path from 'path';
import { initShardCrypto, decryptPayload, isEncryptionEnabled } from './shard-crypto.js';

const HEADER_SIZE = 29;
const NXVF_MAGIC = Buffer.from([0x4E, 0x58, 0x56, 0x46]);
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
const GZIP_MAGIC = Buffer.from([0x1F, 0x8B]);

let _zstdDecompress = null;
let _gzipDecompress = null;
let _cryptoInitialized = false;

async function ensureDeps() {
    if (_zstdDecompress === null) {
        try {
            const fzstd = await import('fzstd');
            _zstdDecompress = (data) => Buffer.from(fzstd.decompress(data));
        } catch {
            _zstdDecompress = false;
        }
        // Gzip decompression via Node.js built-in zlib (always available)
        try {
            const zlib = await import('zlib');
            _gzipDecompress = (data) => Buffer.from(zlib.gunzipSync(data));
        } catch {
            _gzipDecompress = false;
        }
    }
    if (!_cryptoInitialized) {
        initShardCrypto();
        _cryptoInitialized = true;
    }
}

/** Detect if decrypted payload is valid (2-byte JSON signature or Zstd magic). */
function isValidPayload(buf) {
    if (!buf || buf.length < 2) return false;
    const b0 = buf[0], b1 = buf[1];
    // JSON object: must start with {"  (0x7B 0x22)
    if (b0 === 0x7B && b1 === 0x22) return true;
    // JSON array: must start with [{ or [[ or [" or [] (valid JSON array starts)
    if (b0 === 0x5B && (b1 === 0x7B || b1 === 0x5B || b1 === 0x22 || b1 === 0x5D)) return true;
    // Zstd magic (4 bytes: 28 B5 2F FD)
    if (buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) return true;
    // NOTE: Gzip magic (0x1F 0x8B) is NOT checked here — its 2-byte signature
    // has a 1/65536 false positive rate on encrypted data, causing decryption
    // to be skipped. Gzip is detected AFTER decryption in the decompression stage.
    return false;
}

/**
 * Check if a file has NXVF magic bytes (non-destructive probe)
 */
export function isBinaryShard(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        return buf.equals(NXVF_MAGIC);
    } catch { return false; }
}

/**
 * Parse NXVF V4.1 header from buffer
 */
function parseHeader(data) {
    return {
        magic: data.subarray(0, 4),
        version: data.readUInt8(4),
        slotId: data.readUInt16LE(5),
        offsetTableOffset: data.readUInt32LE(7),
        entityCount: data.readUInt32LE(11),
        checksum: data.readUInt32LE(15),
        embeddingOffset: data.readUInt32LE(19),
        embeddingCount: data.readUInt32LE(23),
        embeddingDim: data.readUInt16LE(27)
    };
}

/**
 * Read and decode a binary NXVF shard file.
 * @param {string} filePath - Path to .bin shard
 * @returns {Promise<{entities: Object[], count: number, slotId: number}|null>}
 */
export async function readBinaryShard(filePath) {
    await ensureDeps();

    const data = fs.readFileSync(filePath);
    if (data.length < HEADER_SIZE || !data.subarray(0, 4).equals(NXVF_MAGIC)) {
        return null;
    }

    const header = parseHeader(data);
    const { offsetTableOffset, entityCount, checksum } = header;

    // Read offset table
    const offsetTable = data.subarray(offsetTableOffset, offsetTableOffset + entityCount * 8);

    // Verify checksum (XOR of offset table uint32 words)
    let computed = 0;
    for (let i = 0; i < offsetTable.length; i += 4) {
        computed ^= offsetTable.readUInt32LE(i);
    }
    if ((computed >>> 0) !== checksum) {
        console.warn(`[BINARY-READER] Checksum mismatch: ${path.basename(filePath)}`);
    }

    const shardName = path.basename(filePath);
    const entities = [];

    for (let i = 0; i < entityCount; i++) {
        const offset = offsetTable.readUInt32LE(i * 8);
        const size = offsetTable.readUInt32LE(i * 8 + 4);
        let payload = Buffer.from(data.subarray(offset, offset + size));

        // V27.31: when AES is enabled, always decrypt first.
        // Prior "check raw first, decrypt if invalid" path had a 1/2^32 false-positive
        // per entity: encrypted bytes occasionally start with Zstd magic (28 b5 2f fd),
        // isValidPayload returned true, decryption was skipped, fzstd then EOF'd on
        // garbage. At ~527K entities/cron that's ~1/cron silent failure (V27.30
        // instrumentation confirmed exactly this — single hit on part-182 ent 148,
        // FHD descriptor 0x63 with bogus Dictionary_ID encoded in random bytes).
        // AES-CTR is symmetric; if a legacy unencrypted shard ever appears, the
        // line 190 fail-fast (95% threshold) still fires loud rather than silently
        // skipping. isValidPayload remains as the magic-bytes router for zstd vs gzip
        // vs raw JSON downstream.
        if (isEncryptionEnabled()) {
            payload = decryptPayload(shardName, payload, offset);
        }

        // Zstd decompression (detect via magic bytes)
        if (payload.length >= 4 && payload.subarray(0, 4).equals(ZSTD_MAGIC)) {
            if (_zstdDecompress) {
                // V27.30 DIAG: wrap fzstd to capture EOF context (was uncaught → killed whole shard load)
                try {
                    payload = _zstdDecompress(payload);
                } catch (err) {
                    const head = payload.subarray(0, Math.min(16, payload.length)).toString('hex');
                    const tail = payload.subarray(Math.max(0, payload.length - 4)).toString('hex');
                    console.warn(`[BINARY-READER-DIAG] fzstd FAIL shard=${shardName} ent=${i}/${entityCount} ofs=${offset} sz=${size} head16=${head} tail4=${tail} err=${err.message}`);
                    continue;
                }
            } else {
                console.error(`[BINARY-READER] Zstd payload but fzstd unavailable: ${shardName}`);
                continue;
            }
        }
        // Gzip decompression (detect via magic bytes 1F 8B)
        // Note: encrypted payloads may randomly start with 0x1F8B (1/65536 chance),
        // so wrap in try/catch to survive false-positive gzip detection.
        else if (payload.length >= 2 && payload.subarray(0, 2).equals(GZIP_MAGIC)) {
            if (_gzipDecompress) {
                try {
                    payload = _gzipDecompress(payload);
                } catch {
                    // False positive: encrypted data starting with gzip magic bytes
                    // Fall through to JSON parse (will fail) → retry with forced decrypt
                }
            } else {
                console.error(`[BINARY-READER] Gzip payload but zlib unavailable: ${shardName}`);
                continue;
            }
        }

        try {
            entities.push(JSON.parse(payload.toString('utf-8')));
        } catch (e) {
            // V27.31: removed V25.8.3 "forced-decrypt retry" path — it was a workaround
            // for the same isValidPayload false-positive that always-decrypt-first above
            // now prevents at source. Also removed the orphaned `entityBuf` repair branch
            // (entityBuf was undefined → ReferenceError on every miss, masking the real
            // parse error).
            console.warn(`[BINARY-READER] Entity parse error in ${shardName}[${i}]: ${e.message}`);
        }
    }

    // V25.8.4 / V27.31: fail-fast on mass-decode failure. The 95% threshold survives
    // from the pre-V27.31 era when isValidPayload false-positives could lose a small
    // fraction per shard; with always-decrypt-first that false-positive is gone, so
    // a mass miss now most likely means an AES_CRYPTO_KEY mismatch between writer and
    // reader (or a genuinely unencrypted legacy shard reaching an encryption-on reader).
    if (entityCount >= 100 && entities.length / entityCount < 0.05) {
        throw new Error(`[BINARY-READER] ${entityCount - entities.length}/${entityCount} entities failed to decode in ${shardName}. ` +
            `Likely AES_CRYPTO_KEY missing or invalid (encryption enabled=${isEncryptionEnabled()}). ` +
            `Caller must supply the same key used to encrypt the shard.`);
    }

    return { entities, count: entityCount, slotId: header.slotId, version: header.version };
}

/**
 * Validate NXVF header integrity (for verify-db.js)
 */
export function validateBinaryHeader(filePath) {
    const data = fs.readFileSync(filePath);
    if (data.length < HEADER_SIZE) return { valid: false, error: 'File too small' };
    if (!data.subarray(0, 4).equals(NXVF_MAGIC)) return { valid: false, error: 'Bad magic' };

    const header = parseHeader(data);
    const offsetTable = data.subarray(header.offsetTableOffset, header.offsetTableOffset + header.entityCount * 8);

    let computed = 0;
    for (let i = 0; i < offsetTable.length; i += 4) {
        computed ^= offsetTable.readUInt32LE(i);
    }
    const checksumOk = (computed >>> 0) === header.checksum;

    return {
        valid: checksumOk,
        version: header.version,
        entityCount: header.entityCount,
        slotId: header.slotId,
        checksumOk,
        error: checksumOk ? null : 'Checksum mismatch'
    };
}
