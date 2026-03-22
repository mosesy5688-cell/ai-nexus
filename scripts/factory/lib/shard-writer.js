/**
 * V25.8 Shard Writer — Binary VFS 4.1 with Neural Header + Zstd Compression
 *
 * Implements Spec §1.1 (Zstandard) and §1.2 (Shard Header V4.1 Neural Extended):
 * Magic(4B) | Version(1B) | SlotID(2B) | OffsetTableOffset(4B) | EntityCount(4B) |
 * Checksum(4B) | EmbeddingOffset(4B) | EmbeddingCount(4B) | EmbeddingDim(2B) = 29 bytes
 *
 * Each entity payload is Zstd-compressed. Client detects via Zstd magic bytes (0x28B52FFD).
 * Trailing Offset Table: [uint32 offset, uint32 size] per entity for O(1) jump-scan.
 */

import fsSync from 'fs';
import path from 'path';
import { initShardCrypto, encryptPayload } from './shard-crypto.js';

// V4.1 Neural Extended Header: 29 bytes (was 19 in V4.0)
const SHARD_HEADER_SIZE = 29;
const SHARD_MAGIC = Buffer.from([0x4E, 0x58, 0x56, 0x46]); // "NXVF" (Nexus VFS)
const SHARD_VERSION = 0x41; // 0x41 = V4.1 (backward compat: V4.0 was 0x04)
const SHARD_WARN_THRESHOLD = 500;

import { zstdCompress, zstdCompressSync } from './zstd-helper.js';

let _compressFn = null;

// V55.9: Zstd-only. No gzip fallback. Build MUST crash if zstd unavailable.
async function loadZstd() {
    if (_compressFn) return _compressFn;
    await zstdCompress(Buffer.from('init')); // warm up codec
    _compressFn = (data) => zstdCompressSync(data, 3);
    console.log('[SHARD-WRITER] Zstd compression enabled (V55.9 compliant)');
    return _compressFn;
}

export class ShardWriter {
    constructor(outputDir, namePrefix = 'fused-shard') {
        this.outputDir = outputDir;
        this.namePrefix = namePrefix;
        this.fd = null;
        this.shardId = 0;
        this.shardSize = 0;
        this.entityOffsets = [];
        this.currentName = null;
        this.compress = null;
        // V4.1 Neural: Embedding metadata (reserved for Phase 2 ANN build)
        this.embeddingOffset = 0;
        this.embeddingCount = 0;
        this.embeddingDim = 0;
    }

    async init() {
        this.compress = await loadZstd();
        this.encrypted = initShardCrypto();
    }

    open() {
        if (this.shardId === SHARD_WARN_THRESHOLD) { console.warn(`[SHARD-WRITER] ⚠️ ${SHARD_WARN_THRESHOLD} shards reached — review MAX_SHARD_SIZE or entity density`); }
        if (this.fd) this.finalize();
        this.currentName = `${this.namePrefix}-${String(this.shardId).padStart(3, '0')}.bin`;
        const fullPath = path.join(this.outputDir, this.currentName);
        this.fd = fsSync.openSync(fullPath, 'w');
        fsSync.writeSync(this.fd, Buffer.alloc(SHARD_HEADER_SIZE, 0));
        this.shardSize = SHARD_HEADER_SIZE;
        this.entityOffsets = [];
        this.embeddingOffset = 0;
        this.embeddingCount = 0;
        return this.currentName;
    }

    writeEntity(bundleJson) {
        let payload = this.compress ? this.compress(bundleJson) : bundleJson;
        const offset = this.shardSize;
        // V5.8 §1.1: AES-CTR sovereign encryption (post-Zstd, per-entity IV)
        if (this.encrypted) {
            payload = encryptPayload(this.currentName, payload, offset);
        }
        const size = payload.length;
        this.entityOffsets.push({ offset, size });
        fsSync.writeSync(this.fd, payload);
        this.shardSize += size;
        return { offset, size };
    }

    writePadding() {
        const padding = (16384 - (this.shardSize % 16384)) % 16384;
        if (padding > 0) {
            fsSync.writeSync(this.fd, Buffer.alloc(padding, 0));
            this.shardSize += padding;
        }
        return padding;
    }

    wouldExceed(dataLength, maxSize) {
        return this.shardSize + dataLength > maxSize;
    }

    /**
     * V25.8.3 P1: Write Int8 quantized embeddings for this shard's entities.
     * Called after all entities are written but BEFORE finalize().
     * @param {Array<Float32Array|number[]>} embeddings - One embedding per entity, same order as writeEntity calls
     * @param {number} dim - Embedding dimension (e.g. 384)
     */
    writeEmbeddings(embeddings, dim = 384) {
        if (!this.fd || !embeddings || embeddings.length === 0) return;

        // Align to 16KB page boundary for clean Range Read
        this.writePadding();
        this.embeddingOffset = this.shardSize;
        this.embeddingDim = dim;
        this.embeddingCount = embeddings.length;

        // Write Int8 quantized vectors (Float32 → Int8: val * 127, clamped)
        const vecBuf = Buffer.alloc(embeddings.length * dim);
        for (let i = 0; i < embeddings.length; i++) {
            const vec = embeddings[i];
            for (let d = 0; d < dim; d++) {
                const val = vec && vec[d] ? Math.round(vec[d] * 127) : 0;
                vecBuf.writeInt8(Math.max(-128, Math.min(127, val)), i * dim + d);
            }
        }
        fsSync.writeSync(this.fd, vecBuf);
        this.shardSize += vecBuf.length;
    }

    finalize() {
        if (!this.fd) return;
        const offsetTableOffset = this.shardSize;
        const offsetTable = Buffer.alloc(this.entityOffsets.length * 8);
        for (let i = 0; i < this.entityOffsets.length; i++) {
            offsetTable.writeUInt32LE(this.entityOffsets[i].offset, i * 8);
            offsetTable.writeUInt32LE(this.entityOffsets[i].size, i * 8 + 4);
        }
        fsSync.writeSync(this.fd, offsetTable);

        // V4.1 Neural Extended Header (29 bytes)
        const header = Buffer.alloc(SHARD_HEADER_SIZE);
        SHARD_MAGIC.copy(header, 0);                          // [0..3]  Magic
        header.writeUInt8(SHARD_VERSION, 4);                   // [4]     Version (0x41 = V4.1)
        header.writeUInt16LE(this.shardId, 5);                 // [5..6]  SlotID
        header.writeUInt32LE(offsetTableOffset, 7);            // [7..10] OffsetTableOffset
        header.writeUInt32LE(this.entityOffsets.length, 11);   // [11..14] EntityCount
        // Checksum: XOR of offset table words
        let checksum = 0;
        for (let i = 0; i < offsetTable.length; i += 4) {
            checksum ^= offsetTable.readUInt32LE(i);
        }
        header.writeUInt32LE(checksum >>> 0, 15);              // [15..18] Checksum
        // V4.1 Neural extension fields
        header.writeUInt32LE(this.embeddingOffset, 19);        // [19..22] EmbeddingOffset
        header.writeUInt32LE(this.embeddingCount, 23);         // [23..26] EmbeddingCount
        header.writeUInt16LE(this.embeddingDim, 27);           // [27..28] EmbeddingDim

        fsSync.writeSync(this.fd, header, 0, SHARD_HEADER_SIZE, 0);
        fsSync.fdatasyncSync(this.fd);
        fsSync.closeSync(this.fd);
        this.fd = null;
    }

    nextShard() {
        this.shardId++;
        return this.open();
    }
}
