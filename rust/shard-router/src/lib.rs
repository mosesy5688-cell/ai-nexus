//! V25.8 Shard Router — xxhash64(UMID) % 4096 with full 64-bit precision.
//!
//! Spec §1.2: "Due to JS Number precision limits (53-bit), 64-bit hashing is
//! performed EXCLUSIVELY by the Rust FFI module, passing the resulting SlotID
//! back to JS as a uint32."

use napi::bindgen_prelude::*;
use napi_derive::napi;
use xxhash_rust::xxh64::xxh64;

const DEFAULT_SEED: u64 = 0;

/// Compute the shard slot for a single UMID.
/// Returns `xxhash64(umid) % total_slots` as u32.
#[napi]
pub fn compute_shard_slot(umid: String, total_slots: Option<u32>) -> u32 {
    let slots = total_slots.unwrap_or(4096) as u64;
    let hash = xxh64(umid.as_bytes(), DEFAULT_SEED);
    (hash % slots) as u32
}

/// Batch-compute shard slots for a buffer of UMIDs (newline-delimited).
/// Spec §5.1: "JS must pass continuous memory Buffers (10k entities per batch)
/// to Rust hooks to eliminate context-switching overhead."
///
/// Returns a Vec<u32> of slot IDs in the same order as input UMIDs.
#[napi]
pub fn batch_compute_shard_slots(umids_buffer: Buffer, total_slots: Option<u32>) -> Vec<u32> {
    let slots = total_slots.unwrap_or(4096) as u64;
    let data = std::str::from_utf8(&umids_buffer).unwrap_or("");
    data.lines()
        .map(|umid| {
            let hash = xxh64(umid.as_bytes(), DEFAULT_SEED);
            (hash % slots) as u32
        })
        .collect()
}

/// Compute raw xxhash64 of a string, returned as hex string.
/// Used for UMID generation verification and shard header checksums.
#[napi]
pub fn xxhash64_hex(input: String, seed: Option<i64>) -> String {
    let s = seed.map(|v| v as u64).unwrap_or(DEFAULT_SEED);
    let hash = xxh64(input.as_bytes(), s);
    format!("{:016x}", hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slot_determinism() {
        let slot1 = compute_shard_slot("a1b2c3d4e5f6a7b8".to_string(), Some(4096));
        let slot2 = compute_shard_slot("a1b2c3d4e5f6a7b8".to_string(), Some(4096));
        assert_eq!(slot1, slot2);
        assert!(slot1 < 4096);
    }

    #[test]
    fn test_batch_routing() {
        let input = b"umid_aaa\numid_bbb\numid_ccc";
        let buffer = Buffer::from(input.to_vec());
        let results = batch_compute_shard_slots(buffer, Some(4096));
        assert_eq!(results.len(), 3);
        for slot in &results {
            assert!(*slot < 4096);
        }
    }

    #[test]
    fn test_xxhash64_hex_output() {
        let hex = xxhash64_hex("test".to_string(), None);
        assert_eq!(hex.len(), 16);
    }
}
