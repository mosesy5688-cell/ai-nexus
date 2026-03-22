/**
 * V25.9 Zstd Helper — Unified Compression Utility
 *
 * V55.9 §73/§75: "100% Zstd" mandate. This module is the SOLE compression
 * entry point for all factory writers. Gzip production is abolished.
 *
 * Dependencies: zstd-codec (WASM, devDependency)
 * Readers still accept both formats via magic byte detection (backward compat).
 */

import { Transform } from 'stream';
import zlib from 'zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
const GZIP_MAGIC = Buffer.from([0x1F, 0x8B]);

let _simple = null;

/**
 * Initialize zstd-codec WASM runtime (lazy singleton).
 * Throws hard if unavailable — V55.9 mandates no gzip fallback.
 */
async function getCodec() {
    if (_simple) return _simple;
    const { ZstdCodec } = await import('zstd-codec');
    const zstd = await new Promise(resolve => ZstdCodec.run(z => resolve(z)));
    _simple = new zstd.Simple();
    return _simple;
}

/**
 * Compress data with Zstd.
 * @param {Buffer|Uint8Array|string} data - Input data
 * @param {number} level - Compression level (1-22, default 3)
 * @returns {Promise<Buffer>} Zstd-compressed buffer
 */
export async function zstdCompress(data, level = 3) {
    const codec = await getCodec();
    const input = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    return Buffer.from(codec.compress(input, level));
}

/**
 * Synchronous compress (for hot paths after init).
 * Must call zstdCompress() at least once first to initialize the codec.
 */
export function zstdCompressSync(data, level = 3) {
    if (!_simple) throw new Error('[ZSTD] Codec not initialized. Call zstdCompress() first.');
    const input = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    return Buffer.from(_simple.compress(input, level));
}

/**
 * Decompress Zstd data.
 * @param {Buffer|Uint8Array} data - Zstd-compressed buffer
 * @returns {Promise<Buffer>} Decompressed buffer
 */
export async function zstdDecompress(data) {
    const codec = await getCodec();
    return Buffer.from(codec.decompress(data));
}

/**
 * Detect compression format from magic bytes.
 * @param {Buffer|Uint8Array} data
 * @returns {'zstd'|'gzip'|'none'}
 */
export function detectCompression(data) {
    if (!data || data.length < 4) return 'none';
    if (data[0] === 0x28 && data[1] === 0xB5 && data[2] === 0x2F && data[3] === 0xFD) return 'zstd';
    if (data[0] === 0x1F && data[1] === 0x8B) return 'gzip';
    return 'none';
}

/**
 * Auto-decompress: detects format and decompresses accordingly.
 * Supports both Zstd (V55.9) and Gzip (legacy backward compat).
 * @param {Buffer|Uint8Array} data - Compressed or raw buffer
 * @returns {Promise<Buffer>} Decompressed buffer
 */
export async function autoDecompress(data) {
    const format = detectCompression(data);
    if (format === 'zstd') return zstdDecompress(data);
    if (format === 'gzip') {
        return zlib.gunzipSync(data);
    }
    return Buffer.from(data);
}

/**
 * V25.9: Zstd compress Transform stream (replaces zlib.createGzip).
 * Buffers all input and compresses on flush. Suitable for CI builds
 * where peak memory (~200-500MB) is acceptable for streaming writers.
 * Must call zstdCompress() at least once first to initialize the codec.
 * @param {number} level - Compression level (1-22, default 3)
 * @returns {Transform} Node.js Transform stream
 */
export function createZstdCompressStream(level = 3) {
    if (!_simple) throw new Error('[ZSTD] Codec not initialized. Call zstdCompress() first.');
    const chunks = [];
    return new Transform({
        transform(chunk, encoding, callback) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            callback();
        },
        flush(callback) {
            try {
                const combined = Buffer.concat(chunks);
                this.push(Buffer.from(_simple.compress(combined, level)));
            } catch (e) { return callback(e); }
            callback();
        }
    });
}

/**
 * V25.9: Auto-detect decompress Transform stream (replaces zlib.createGunzip).
 * Handles both Zstd and Gzip via magic byte detection.
 * Buffers entire input for Zstd; delegates to createGunzip for Gzip.
 * @returns {Transform} Node.js Transform stream
 */
export function createAutoDecompressStream() {
    let mode = null; // 'zstd' | 'gzip' | 'raw'
    let gunzip = null;
    const chunks = [];

    return new Transform({
        transform(chunk, encoding, callback) {
            if (mode === null && chunk.length >= 4) {
                const fmt = detectCompression(chunk);
                if (fmt === 'gzip') {
                    mode = 'gzip';
                    gunzip = zlib.createGunzip();
                    gunzip.on('data', (d) => this.push(d));
                    gunzip.on('error', (e) => this.destroy(e));
                    gunzip.write(chunk);
                } else if (fmt === 'zstd') {
                    mode = 'zstd';
                    chunks.push(chunk);
                } else {
                    mode = 'raw';
                    this.push(chunk);
                }
            } else if (mode === 'gzip') {
                gunzip.write(chunk);
            } else if (mode === 'zstd') {
                chunks.push(chunk);
            } else {
                this.push(chunk);
            }
            callback();
        },
        flush(callback) {
            if (mode === 'zstd') {
                try {
                    const combined = Buffer.concat(chunks);
                    this.push(Buffer.from(_simple.decompress(combined)));
                } catch (e) { return callback(e); }
                callback();
            } else if (mode === 'gzip' && gunzip) {
                gunzip.end();
                gunzip.on('end', () => callback());
            } else {
                callback();
            }
        }
    });
}
