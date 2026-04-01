/**
 * V55.9 xxhash64 — Pure JS implementation via BigInt.
 * Mirrors rust/shard-router/src/lib.rs (xxhash-rust xxh64, seed=0).
 * Browser-compatible: no Node.js crypto, no WASM dependency.
 *
 * Spec §1.2: "xxhash64(UMID) % 4096" is the canonical routing algorithm.
 * For meta-NN.db shard routing, we use xxhash64(slug) % META_SHARD_COUNT.
 */

const PRIME64_1 = 0x9E3779B185EBCA87n;
const PRIME64_2 = 0xC2B2AE3D27D4EB4Fn;
const PRIME64_3 = 0x165667B19E3779F9n;
const PRIME64_4 = 0x85EBCA77C2B2AE63n;
const PRIME64_5 = 0x27D4EB2F165667C5n;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;

function rotl64(val: bigint, bits: number): bigint {
    return ((val << BigInt(bits)) | (val >> BigInt(64 - bits))) & MASK64;
}

function round64(acc: bigint, input: bigint): bigint {
    acc = (acc + input * PRIME64_2) & MASK64;
    acc = rotl64(acc, 31);
    return (acc * PRIME64_1) & MASK64;
}

function mergeRound64(acc: bigint, val: bigint): bigint {
    val = round64(0n, val);
    acc = (acc ^ val) & MASK64;
    return (acc * PRIME64_1 + PRIME64_4) & MASK64;
}

function readU64(buf: Uint8Array, offset: number): bigint {
    let val = 0n;
    for (let i = 7; i >= 0; i--) {
        val = (val << 8n) | BigInt(buf[offset + i]);
    }
    return val;
}

function readU32(buf: Uint8Array, offset: number): bigint {
    return BigInt(buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | ((buf[offset + 3] << 24) >>> 0));
}

function avalanche(h: bigint): bigint {
    h = ((h ^ (h >> 33n)) * PRIME64_2) & MASK64;
    h = ((h ^ (h >> 29n)) * PRIME64_3) & MASK64;
    return (h ^ (h >> 32n)) & MASK64;
}

/** Compute xxhash64 of a UTF-8 string. Matches Rust xxh64(input.as_bytes(), seed). */
export function xxhash64(input: string, seed: bigint = 0n): bigint {
    const encoder = new TextEncoder();
    const buf = encoder.encode(input);
    const len = buf.length;
    let h: bigint;
    let pos = 0;

    if (len >= 32) {
        let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK64;
        let v2 = (seed + PRIME64_2) & MASK64;
        let v3 = seed & MASK64;
        let v4 = (seed - PRIME64_1) & MASK64;

        while (pos + 32 <= len) {
            v1 = round64(v1, readU64(buf, pos)); pos += 8;
            v2 = round64(v2, readU64(buf, pos)); pos += 8;
            v3 = round64(v3, readU64(buf, pos)); pos += 8;
            v4 = round64(v4, readU64(buf, pos)); pos += 8;
        }

        h = (rotl64(v1, 1) + rotl64(v2, 7) + rotl64(v3, 12) + rotl64(v4, 18)) & MASK64;
        h = mergeRound64(h, v1);
        h = mergeRound64(h, v2);
        h = mergeRound64(h, v3);
        h = mergeRound64(h, v4);
    } else {
        h = (seed + PRIME64_5) & MASK64;
    }

    h = (h + BigInt(len)) & MASK64;

    while (pos + 8 <= len) {
        const k1 = round64(0n, readU64(buf, pos));
        h = (rotl64(h ^ k1, 27) * PRIME64_1 + PRIME64_4) & MASK64;
        pos += 8;
    }

    while (pos + 4 <= len) {
        h = (h ^ ((readU32(buf, pos) * PRIME64_1) & MASK64)) & MASK64;
        h = (rotl64(h, 23) * PRIME64_2 + PRIME64_3) & MASK64;
        pos += 4;
    }

    while (pos < len) {
        h = (h ^ ((BigInt(buf[pos]) * PRIME64_5) & MASK64)) & MASK64;
        h = (rotl64(h, 11) * PRIME64_1) & MASK64;
        pos++;
    }

    return avalanche(h);
}

/** Compute xxhash64(input) % modulus. Returns a JS number (safe for mod < 2^53). */
export function xxhash64Mod(input: string, modulus: number, seed: bigint = 0n): number {
    if (!modulus || modulus <= 1) return 0;
    return Number(xxhash64(input, seed) % BigInt(modulus));
}
