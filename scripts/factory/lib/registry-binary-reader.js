/**
 * V25.8 Binary Shard Reader — NXVF V4.1 Decoder
 * Reads binary registry shards with Zstd decompression + AES-CTR decryption.
 * Transparent fallback: returns null for non-binary files so caller can use JSON.gz path.
 */

import fs from 'fs';
import path from 'path';
import { initShardCrypto, decryptPayload } from './shard-crypto.js';

const HEADER_SIZE = 29;
const NXVF_MAGIC = Buffer.from([0x4E, 0x58, 0x56, 0x46]);
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

let _zstdDecompress = null;
let _cryptoInitialized = false;

async function ensureDeps() {
    if (_zstdDecompress === null) {
        try {
            const fzstd = await import('fzstd');
            _zstdDecompress = (data) => Buffer.from(fzstd.decompress(data));
        } catch {
            _zstdDecompress = false;
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

        // AES-CTR decryption — check raw first, only decrypt if not already valid
        if (!isValidPayload(payload)) {
            const decrypted = decryptPayload(shardName, payload, offset);
            if (isValidPayload(decrypted)) payload = decrypted;
        }

        // Zstd decompression (detect via magic bytes)
        if (payload.length >= 4 && payload.subarray(0, 4).equals(ZSTD_MAGIC)) {
            if (_zstdDecompress) {
                payload = _zstdDecompress(payload);
            } else {
                console.error(`[BINARY-READER] Zstd payload but fzstd unavailable: ${shardName}`);
                continue;
            }
        }

        try {
            entities.push(JSON.parse(payload.toString('utf-8')));
        } catch (e) {
            // V25.8.3: Retry with forced decryption — handles isValidPayload false positives
            // where encrypted bytes randomly start with 0x7B22 ("{"), ~1/65536 chance per entity
            let recovered = false;
            if (isEncryptionEnabled()) {
                try {
                    let retry = decryptPayload(shardName, Buffer.from(data.subarray(offset, offset + size)), offset);
                    if (retry.length >= 4 && retry.subarray(0, 4).equals(ZSTD_MAGIC) && _zstdDecompress) {
                        retry = _zstdDecompress(retry);
                    }
                    entities.push(JSON.parse(retry.toString('utf-8')));
                    recovered = true;
                } catch { /* forced decrypt also failed */ }
            }
            if (!recovered) {
                console.warn(`[BINARY-READER] Entity parse error in ${shardName}[${i}]: ${e.message}`);
            }
        }
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
