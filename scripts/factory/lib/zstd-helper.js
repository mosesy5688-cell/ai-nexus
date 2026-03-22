/**
 * V55.9 Zstd Helper — Unified Compression Utility
 *
 * Priority: Rust FFI (native, zero-leak) → WASM zstd-codec (fallback)
 * V55.9 §73/§75: "100% Zstd" mandate. This module is the SOLE compression
 * entry point for all factory writers. Gzip production is abolished.
 * Readers still accept both formats via magic byte detection (backward compat).
 */

import { Transform } from 'stream';
import { createRequire } from 'module';
import zlib from 'zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

// --- Rust FFI Layer (preferred, zero memory leak) ---
let _rust = null;
let _rustProbed = false;

function probeRust() {
    if (_rustProbed) return _rust;
    _rustProbed = true;
    try {
        const req = createRequire(import.meta.url);
        _rust = req('../../../rust/stream-aggregator/stream-aggregator-rust.node');
        console.log('[ZSTD] Using Rust FFI (native)');
    } catch {
        _rust = null;
    }
    return _rust;
}

// --- WASM Fallback Layer ---
let _simple = null;

async function getCodec() {
    if (_simple) return _simple;
    const { ZstdCodec } = await import('zstd-codec');
    const zstd = await new Promise(resolve => ZstdCodec.run(z => resolve(z)));
    _simple = new zstd.Simple();
    console.log('[ZSTD] Using WASM fallback');
    return _simple;
}

/**
 * Compress data with Zstd. Rust FFI → WASM fallback.
 * @param {Buffer|Uint8Array|string} data - Input data
 * @param {number} level - Compression level (1-22, default 3)
 * @returns {Promise<Buffer>} Zstd-compressed buffer
 */
export async function zstdCompress(data, level = 3) {
    const input = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const rust = probeRust();
    if (rust?.zstdCompressBuffer) {
        return Buffer.from(rust.zstdCompressBuffer(input, level));
    }
    const codec = await getCodec();
    return Buffer.from(codec.compress(input, level));
}

/**
 * Synchronous compress. Rust FFI → WASM fallback.
 * For WASM path, must call zstdCompress() at least once first to initialize.
 */
export function zstdCompressSync(data, level = 3) {
    const input = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const rust = probeRust();
    if (rust?.zstdCompressBuffer) {
        return Buffer.from(rust.zstdCompressBuffer(input, level));
    }
    if (!_simple) throw new Error('[ZSTD] Codec not initialized. Call zstdCompress() first.');
    return Buffer.from(_simple.compress(input, level));
}

/**
 * Decompress Zstd data. Rust FFI → WASM fallback.
 * @param {Buffer|Uint8Array} data - Zstd-compressed buffer
 * @returns {Promise<Buffer>} Decompressed buffer
 */
export async function zstdDecompress(data) {
    const rust = probeRust();
    if (rust?.zstdDecompressBuffer) {
        return Buffer.from(rust.zstdDecompressBuffer(data));
    }
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
 */
export async function autoDecompress(data) {
    const format = detectCompression(data);
    if (format === 'zstd') return zstdDecompress(data);
    if (format === 'gzip') return zlib.gunzipSync(data);
    return Buffer.from(data);
}

/**
 * Zstd compress Transform stream. Buffers all input, compresses on flush.
 * Uses Rust FFI when available. For WASM path, call zstdCompress() first.
 * @param {number} level - Compression level (1-22, default 3)
 * @returns {Transform} Node.js Transform stream
 */
export function createZstdCompressStream(level = 3) {
    const chunks = [];
    return new Transform({
        transform(chunk, encoding, callback) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            callback();
        },
        flush(callback) {
            try {
                const combined = Buffer.concat(chunks);
                const rust = probeRust();
                if (rust?.zstdCompressBuffer) {
                    this.push(Buffer.from(rust.zstdCompressBuffer(combined, level)));
                } else if (_simple) {
                    this.push(Buffer.from(_simple.compress(combined, level)));
                } else {
                    return callback(new Error('[ZSTD] No codec available'));
                }
            } catch (e) { return callback(e); }
            callback();
        }
    });
}

/**
 * Auto-detect decompress Transform stream.
 * Handles both Zstd and Gzip via magic byte detection.
 */
export function createAutoDecompressStream() {
    let mode = null;
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
                    const rust = probeRust();
                    if (rust?.zstdDecompressBuffer) {
                        this.push(Buffer.from(rust.zstdDecompressBuffer(combined)));
                    } else if (_simple) {
                        this.push(Buffer.from(_simple.decompress(combined)));
                    } else {
                        return callback(new Error('[ZSTD] No codec available'));
                    }
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
