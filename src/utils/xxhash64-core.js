/**
 * V27.95 xxhash64 core — Pure JS implementation via BigInt (node + browser).
 *
 * Single source of truth for the xxhash64 algorithm. Both the browser/SSR
 * reader (src/utils/xxhash64.ts re-exports this) and the Node factory
 * meta-shard fallback (scripts/factory/lib/meta-shard-router.js) import this
 * module so writer == reader byte-for-byte when the Rust shard-router native
 * module is absent.
 *
 * Mirrors rust/shard-router/src/lib.rs (xxhash-rust xxh64, seed=0).
 * Plain .js (not .ts) so the Node packer can import it directly — same reason
 * src/constants/shard-constants.js is plain .js (no native TS execution in
 * the factory).
 *
 * Spec V55.9 §1.2: "xxhash64(UMID) % 4096" is the canonical routing algorithm.
 * For meta-NN.db shard routing we use xxhash64(slug) % META_SHARD_COUNT.
 */

const PRIME64_1 = 0x9E3779B185EBCA87n;
const PRIME64_2 = 0xC2B2AE3D27D4EB4Fn;
const PRIME64_3 = 0x165667B19E3779F9n;
const PRIME64_4 = 0x85EBCA77C2B2AE63n;
const PRIME64_5 = 0x27D4EB2F165667C5n;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;

function rotl64(val, bits) {
    return ((val << BigInt(bits)) | (val >> BigInt(64 - bits))) & MASK64;
}

function round64(acc, input) {
    acc = (acc + input * PRIME64_2) & MASK64;
    acc = rotl64(acc, 31);
    return (acc * PRIME64_1) & MASK64;
}

function mergeRound64(acc, val) {
    val = round64(0n, val);
    acc = (acc ^ val) & MASK64;
    return (acc * PRIME64_1 + PRIME64_4) & MASK64;
}

function readU64(buf, offset) {
    let val = 0n;
    for (let i = 7; i >= 0; i--) {
        val = (val << 8n) | BigInt(buf[offset + i]);
    }
    return val;
}

function readU32(buf, offset) {
    return BigInt(buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | ((buf[offset + 3] << 24) >>> 0));
}

function avalanche(h) {
    h = ((h ^ (h >> 33n)) * PRIME64_2) & MASK64;
    h = ((h ^ (h >> 29n)) * PRIME64_3) & MASK64;
    return (h ^ (h >> 32n)) & MASK64;
}

/** Compute xxhash64 of a UTF-8 string. Matches Rust xxh64(input.as_bytes(), seed). */
export function xxhash64(input, seed = 0n) {
    const encoder = new TextEncoder();
    const buf = encoder.encode(input);
    const len = buf.length;
    let h;
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
export function xxhash64Mod(input, modulus, seed = 0n) {
    if (!modulus || modulus <= 1) return 0;
    return Number(xxhash64(input, seed) % BigInt(modulus));
}
