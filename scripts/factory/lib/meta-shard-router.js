/**
 * V55.9 §6 Meta-Shard Router — Canonical slug-based xxhash64 routing.
 * Wraps Rust FFI for deterministic meta-NN.db shard assignment.
 * Aligns with src/utils/xxhash64.ts (browser path) for 100% parity.
 *
 * Usage: computeMetaShardSlot(slug, 32) → 0..31
 */

import { computeShardSlotFFI } from './rust-bridge.js';

/**
 * Compute meta-shard slot via xxhash64(slug) % totalShards.
 * @param {string} slug - Entity slug (canonical routing key)
 * @param {number} totalShards - Number of meta-NN.db shards (e.g., 32)
 * @returns {number} Slot index 0..totalShards-1
 */
export function computeMetaShardSlot(slug, totalShards = 32) {
    return computeShardSlotFFI(slug, totalShards);
}
