/**
 * V27.28 Native zstd subprocess fallback.
 *
 * Used by zstd-helper.js as a middle tier between Rust FFI and WASM:
 *   Rust FFI  → native `zstd` binary (this file)  → WASM ZstdCodec
 *
 * Why this tier exists: WASM allocator caps around 2 GB and OOM's much
 * earlier on real workloads (V27.23 README cache hit OOM at ~50-150 MB
 * NDJSON input, run 26145811258). The OS-installed `zstd` binary on
 * GHA `ubuntu-latest` runners is stream-native and has no JS-side heap
 * ceiling, so the cron path gets predictable behavior on large buffers
 * without forcing Rust FFI compilation.
 *
 * Probe is cached after first call; subsequent invocations are
 * branch-free. Returns `null` (not throw) on any failure so callers
 * cleanly fall through to the next tier.
 */

import { spawn, spawnSync } from 'child_process';

let _probed = false;
let _available = false;

// V27.29: small inputs go to WASM path (downstream fzstd readers can't always
// parse native zstd CLI frame headers — V27.28 regression caused 3/4 EOF when
// shard-writer.js wrote per-entity payloads via native and registry-binary-
// reader.js read via fzstd directly). 16 KiB threshold: above this, native's
// OOM-avoidance benefit dominates; below, WASM is fine and reader-symmetric.
const NATIVE_MIN_BYTES = 16 * 1024;

export function probeNativeAvailable() {
    if (_probed) return _available;
    _probed = true;
    try {
        const r = spawnSync('zstd', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        _available = r.status === 0;
        if (_available) console.log('[ZSTD] Using native zstd binary');
    } catch {
        _available = false;
    }
    return _available;
}

export function getNativeProbeResult() {
    return _available;
}

function runNative(args, input) {
    return new Promise((resolve) => {
        try {
            const proc = spawn('zstd', args, { stdio: ['pipe', 'pipe', 'pipe'] });
            const chunks = [];
            let failed = false;
            proc.stdout.on('data', (c) => chunks.push(c));
            proc.stderr.on('data', () => { /* discarded — `-q` keeps it minimal */ });
            proc.on('error', () => { failed = true; resolve(null); });
            proc.on('close', (code) => {
                if (failed) return;
                if (code === 0) resolve(Buffer.concat(chunks));
                else resolve(null);
            });
            proc.stdin.on('error', () => { /* swallow EPIPE — `close` handles it */ });
            proc.stdin.end(input);
        } catch {
            resolve(null);
        }
    });
}

function runNativeSync(args, input) {
    try {
        const r = spawnSync('zstd', args, { input, maxBuffer: 1024 * 1024 * 1024 });
        if (r.status === 0) return r.stdout;
        return null;
    } catch {
        return null;
    }
}

export async function tryNativeCompress(buffer, level = 3) {
    if (!buffer || buffer.length < NATIVE_MIN_BYTES) return null;
    if (!probeNativeAvailable()) return null;
    return runNative([`-${level}`, '-q'], buffer);
}

export function tryNativeCompressSync(buffer, level = 3) {
    if (!buffer || buffer.length < NATIVE_MIN_BYTES) return null;
    if (!probeNativeAvailable()) return null;
    return runNativeSync([`-${level}`, '-q'], buffer);
}

export async function tryNativeDecompress(buffer) {
    if (!probeNativeAvailable()) return null;
    return runNative(['-d', '-q'], buffer);
}

export function tryNativeDecompressSync(buffer) {
    if (!probeNativeAvailable()) return null;
    return runNativeSync(['-d', '-q'], buffer);
}
