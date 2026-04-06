/**
 * V55.9 Zstd Helper — Unified Compression (Rust FFI → WASM fallback)
 * Streaming: temp-file + Rust FFI for O(1) memory. No buffer-all-then-compress.
 */

import { Transform } from 'stream';
import { createRequire } from 'module';
import { createReadStream, createWriteStream, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import zlib from 'zlib';

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

let _simple = null;

async function getCodec() {
    if (_simple) return _simple;
    const { ZstdCodec } = await import('zstd-codec');
    const zstd = await new Promise(resolve => ZstdCodec.run(z => resolve(z)));
    _simple = new zstd.Simple();
    console.log('[ZSTD] Using WASM fallback');
    return _simple;
}

let _tmpDir = null;
function getTmpPath(suffix) {
    if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), 'zstd-'));
    return join(_tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}

function safeUnlink(p) { try { unlinkSync(p); } catch {} }

/** Compress data with Zstd. Rust FFI → WASM fallback. */
export async function zstdCompress(data, level = 3) {
    const input = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const rust = probeRust();
    if (rust?.zstdCompressBuffer) {
        return Buffer.from(rust.zstdCompressBuffer(input, level));
    }
    const codec = await getCodec();
    return Buffer.from(codec.compress(input, level));
}

/** Synchronous compress. Rust FFI → WASM fallback. */
export function zstdCompressSync(data, level = 3) {
    const input = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const rust = probeRust();
    if (rust?.zstdCompressBuffer) {
        return Buffer.from(rust.zstdCompressBuffer(input, level));
    }
    if (!_simple) throw new Error('[ZSTD] Codec not initialized. Call zstdCompress() first.');
    return Buffer.from(_simple.compress(input, level));
}

/** Decompress Zstd data. Rust FFI → WASM fallback (handles non-standard frames). */
export async function zstdDecompress(data) {
    const rust = probeRust();
    if (rust?.zstdDecompressBuffer) {
        try { return Buffer.from(rust.zstdDecompressBuffer(data)); } catch { /* fall through to WASM */ }
    }
    const codec = await getCodec();
    const result = codec.decompress(data);
    if (!result) throw new Error(`[ZSTD] WASM decompress returned null (input: ${data.length} bytes). Rust FFI required for large files.`);
    return Buffer.from(result);
}

/** Detect compression format from magic bytes. */
export function detectCompression(data) {
    if (!data || data.length < 4) return 'none';
    if (data[0] === 0x28 && data[1] === 0xB5 && data[2] === 0x2F && data[3] === 0xFD) return 'zstd';
    if (data[0] === 0x1F && data[1] === 0x8B) return 'gzip';
    return 'none';
}

/** Auto-decompress: detects format and decompresses accordingly. */
export async function autoDecompress(data) {
    const format = detectCompression(data);
    if (format === 'zstd') return zstdDecompress(data);
    if (format === 'gzip') return zlib.gunzipSync(data);
    return Buffer.from(data);
}

/** V55.9: True streaming Zstd compress Transform via temp-file + Rust FFI. O(1) memory. */
export function createZstdCompressStream(level = 3) {
    const rust = probeRust();
    if (!rust?.zstdCompressFile) {
        console.warn('[ZSTD] ⚠️ Rust zstdCompressFile unavailable — WASM fallback produces non-standard frames');
    }

    if (rust?.zstdCompressFile) {
        const tmpIn = getTmpPath('.json');
        const tmpOut = getTmpPath('.json.zst');
        const ws = createWriteStream(tmpIn);

        return new Transform({
            transform(chunk, encoding, callback) {
                const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                if (!ws.write(buf)) {
                    ws.once('drain', callback);
                } else {
                    callback();
                }
            },
            flush(callback) {
                ws.end(() => {
                    try {
                        rust.zstdCompressFile(tmpIn, tmpOut, level);
                        // Stream compressed output (O(1) memory)
                        const rs = createReadStream(tmpOut);
                        rs.on('data', (d) => this.push(d));
                        rs.on('end', () => {
                            safeUnlink(tmpOut);
                            callback();
                        });
                        rs.on('error', (e) => {
                            safeUnlink(tmpOut);
                            callback(e);
                        });
                    } catch (e) {
                        safeUnlink(tmpIn);
                        safeUnlink(tmpOut);
                        callback(e);
                    }
                });
            }
        });
    }

    // WASM fallback: buffer then compress (OOM risk on large data)
    const chunks = [];
    return new Transform({
        transform(chunk, encoding, callback) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            callback();
        },
        flush(callback) {
            getCodec().then(codec => {
                this.push(Buffer.from(codec.compress(Buffer.concat(chunks), level)));
                callback();
            }).catch(callback);
        }
    });
}

/** V55.9: True streaming auto-detect decompress Transform. O(1) memory with Rust FFI. */
export function createAutoDecompressStream() {
    let mode = null;
    let gunzip = null;
    let tmpIn = null;
    let tmpWs = null;

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
                    const rust = probeRust();
                    if (rust?.zstdDecompressFile) {
                        mode = 'zstd-rust';
                        tmpIn = getTmpPath('.zst');
                        tmpWs = createWriteStream(tmpIn);
                        tmpWs.write(chunk);
                    } else {
                        mode = 'zstd-wasm';
                        this._chunks = [chunk];
                    }
                } else {
                    mode = 'raw';
                    this.push(chunk);
                }
            } else if (mode === 'gzip') {
                gunzip.write(chunk);
            } else if (mode === 'zstd-rust') {
                if (!tmpWs.write(chunk)) {
                    tmpWs.once('drain', callback);
                    return;
                }
            } else if (mode === 'zstd-wasm') {
                this._chunks.push(chunk);
            } else {
                this.push(chunk);
            }
            callback();
        },
        flush(callback) {
            if (mode === 'zstd-rust') {
                tmpWs.end(() => {
                    const tmpOut = getTmpPath('.json');
                    try {
                        const rust = probeRust();
                        rust.zstdDecompressFile(tmpIn, tmpOut);
                        safeUnlink(tmpIn);
                        const rs = createReadStream(tmpOut);
                        rs.on('data', (d) => this.push(d));
                        rs.on('end', () => {
                            safeUnlink(tmpOut);
                            callback();
                        });
                        rs.on('error', (e) => {
                            safeUnlink(tmpOut);
                            callback(e);
                        });
                    } catch (e) {
                        safeUnlink(tmpIn);
                        safeUnlink(tmpOut);
                        callback(e);
                    }
                });
            } else if (mode === 'zstd-wasm') {
                try {
                    const combined = Buffer.concat(this._chunks);
                    if (_simple) {
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
