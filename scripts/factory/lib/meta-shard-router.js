/**
 * V55.9 §6 Meta-Shard Router — Canonical slug-based xxhash64 routing.
 * Wraps Rust FFI for deterministic meta-NN.db shard assignment.
 * Aligns with src/utils/xxhash64.ts (browser/SSR reader path) for 100% parity.
 *
 * V27.95: JS fallback now uses the SHARED xxhash64 core (src/utils/xxhash64-core.js)
 * — the identical algorithm the reader uses — NOT the legacy MD5 fallback in
 * umid-generator.js. A hard guard ABORTS the pack if neither Rust nor a
 * verified-xxhash64 JS fallback is available, because silently writing
 * MD5-routed shards while readers look on the xxhash64 shard corrupts the
 * whole corpus (write/read shard mismatch). Honest loud failure > silent loss.
 *
 * Usage: computeMetaShardSlot(slug, 96) -> 0..95
 */

import { computeMetaShardSlotFFI, isShardRouterRustLoaded } from './rust-bridge.js';
import { xxhash64Mod } from '../../../src/utils/xxhash64-core.js';
import { META_SHARD_COUNT } from '../../../src/constants/shard-constants.js';

// Known-answer vector: codec-symmetry self-check that the JS xxhash64 core is
// intact before we route a whole corpus with it. The expected value is a
// frozen constant (NOT recomputed from the same function) so the check catches
// real algorithm corruption/divergence. Verified against the reader path in
// tests/unit/meta-shard-parity.test.ts. Update ONLY in lockstep with a
// deliberate hash change to BOTH Rust and src/utils/xxhash64-core.js.
const SELF_CHECK_SLUG = 'hf-model--meta-llama--llama-3-8b';
const SELF_CHECK_SHARDS = 96;
const SELF_CHECK_EXPECTED = 37; // xxhash64Mod(SELF_CHECK_SLUG, 96)
let _jsModeChecked = false;

/**
 * Hard guard: ensure meta-shard routing can use xxhash64 (Rust OR verified JS).
 * Aborts the process loudly on the first JS-mode call if the JS xxhash64 core
 * disagrees with its known-answer vector (corruption / accidental algorithm
 * divergence). When Rust is absent but JS is verified, emits a loud warning
 * (correct but slower, and signals the Rust build broke).
 */
function assertRoutableOrAbort() {
    if (isShardRouterRustLoaded()) return;
    if (_jsModeChecked) return;
    _jsModeChecked = true;
    const got = xxhash64Mod(SELF_CHECK_SLUG, SELF_CHECK_SHARDS);
    if (got !== SELF_CHECK_EXPECTED) {
        console.error(
            `[META-SHARD] FATAL: JS xxhash64 fallback failed self-check ` +
            `(slug='${SELF_CHECK_SLUG}', got=${got}, expected=${SELF_CHECK_EXPECTED}). ` +
            `Refusing to write MD5/corrupt-routed shards. Aborting pack to ` +
            `preserve the prior cycle's shards.`
        );
        process.exit(1);
    }
    console.warn(
        `[META-SHARD] WARNING: Rust shard-router native module NOT loaded — ` +
        `using verified JS xxhash64 fallback. Routing is CORRECT (writer==reader) ` +
        `but slower; the Rust build/cache likely broke. Investigate.`
    );
}

/**
 * Eager guard for shard-writing entry points. Call once at pack startup
 * (after initRustBridge) so the abort happens BEFORE the packing loop rather
 * than mid-stream. Idempotent with the lazy guard in computeMetaShardSlot.
 */
export function assertMetaShardRoutable() {
    assertRoutableOrAbort();
}

/**
 * Compute meta-shard slot via xxhash64(slug) % totalShards.
 * Rust FFI primary; verified shared-JS xxhash64 fallback. Never MD5.
 * @param {string} slug - Entity slug (canonical routing key)
 * @param {number} totalShards - Number of meta-NN.db shards (single source of truth)
 * @returns {number} Slot index 0..totalShards-1
 */
export function computeMetaShardSlot(slug, totalShards = META_SHARD_COUNT) {
    assertRoutableOrAbort();
    return computeMetaShardSlotFFI(slug, totalShards);
}
