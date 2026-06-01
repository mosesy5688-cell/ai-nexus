/**
 * V55.9 xxhash64 — canonical slug/UMID routing hash.
 *
 * V27.95: algorithm moved to ./xxhash64-core.js (plain JS, single source of
 * truth) so the Node factory meta-shard fallback can import the identical
 * implementation that browser/SSR readers use — guaranteeing writer == reader
 * even when the Rust shard-router native module is absent. This .ts wrapper
 * preserves the existing typed import surface (readers import './xxhash64.js').
 *
 * Mirrors rust/shard-router/src/lib.rs (xxhash-rust xxh64, seed=0).
 * Browser-compatible: no Node.js crypto, no WASM dependency.
 *
 * Spec §1.2: "xxhash64(UMID) % 4096" is the canonical routing algorithm.
 * For meta-NN.db shard routing, we use xxhash64(slug) % META_SHARD_COUNT.
 */

import { xxhash64 as _xxhash64, xxhash64Mod as _xxhash64Mod } from './xxhash64-core.js';

/** Compute xxhash64 of a UTF-8 string. Matches Rust xxh64(input.as_bytes(), seed). */
export function xxhash64(input: string, seed: bigint = 0n): bigint {
    return _xxhash64(input, seed);
}

/** Compute xxhash64(input) % modulus. Returns a JS number (safe for mod < 2^53). */
export function xxhash64Mod(input: string, modulus: number, seed: bigint = 0n): number {
    return _xxhash64Mod(input, modulus, seed);
}
