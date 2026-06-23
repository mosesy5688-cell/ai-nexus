//! W3-O1 parse-attrition observability (Founder D-88 / D-90).
//!
//! A pure side-channel accounting structure for the NXVF binary-shard reader.
//! It COUNTS, CLASSIFIES, and FINGERPRINTS entries the reader silently drops,
//! WITHOUT touching the codec, the offset table, the payload bytes, the entity
//! fields, or the survivor set/order. Records carry ONLY irreversible
//! coordinates — never the raw payload, source text, tokens, keys, or any
//! README/abstract/description.
//!
//! Conservation invariant (unit-tested): declared == parsed + dropped.
//! `parse_error_count` is the json-parse SUBSET of `dropped` only; offset-boundary,
//! zstd, and gzip drops are DISTINCT classes and are NOT folded into it.

use sha2::{Digest, Sha256};

/// Fixed hex length of a payload fingerprint = SHA-256(raw bytes)[:8] -> 16 hex.
const FINGERPRINT_HEX_LEN: usize = 16;

/// Why a single entry was dropped. These are DISTINCT classes; only
/// `JsonParse` is folded into `parse_error_count`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropClass {
    /// offset+size exceeded the file bounds — NOTHING was read.
    OffsetBoundary,
    /// zstd magic present but `zstd::decode_all` failed.
    Zstd,
    /// gzip magic present but the gzip reader failed.
    Gzip,
    /// `serde_json` rejected the payload AFTER sanitize + forced-decrypt retries.
    JsonParse,
}

impl DropClass {
    pub fn as_str(self) -> &'static str {
        match self {
            DropClass::OffsetBoundary => "offset_boundary",
            DropClass::Zstd => "zstd_decompress",
            DropClass::Gzip => "gzip_decompress",
            DropClass::JsonParse => "json_parse",
        }
    }
}

/// One irreversible-coordinate record per dropped entry. NEVER carries payload
/// bytes, decoded text, tokens, keys, or any human-readable content.
#[derive(Debug, Clone)]
pub struct DropRecord {
    /// shard file name (e.g. "part-001.bin").
    pub part: String,
    /// position in the offset table (0-based).
    pub entry_index: u32,
    pub error_class: DropClass,
    /// serde error 1-based line (json-parse only; 0 otherwise).
    pub serde_line: u32,
    /// serde error 1-based column (json-parse only; 0 otherwise).
    pub serde_column: u32,
    /// length in BYTES of the payload that was hashed (0 when no payload).
    pub payload_length: u32,
    /// SHA-256(raw payload bytes)[:16 hex], or None when nothing was read.
    pub payload_fingerprint: Option<String>,
    /// "ok" | "unavailable_no_payload".
    pub fingerprint_status: &'static str,
    /// best-effort identity status. The NXVF format has NO out-of-JSON identity
    /// envelope (the offset table is [u32 offset, u32 size] only; no per-entry
    /// id manifest), so this is ALWAYS "unavailable" — we do NOT fabricate or
    /// regex-scan the malformed bytes for an id.
    pub attribution_status: &'static str,
}

impl DropRecord {
    /// Build a record for an entry where payload bytes WERE read (zstd/gzip/json
    /// classes). Fingerprints the RAW bytes — no UTF-8/lossy/JSON projection, so
    /// two distinct invalid-UTF-8 byte sequences never collapse to one fingerprint.
    pub fn with_payload(
        part: &str,
        entry_index: usize,
        error_class: DropClass,
        payload: &[u8],
        serde_line: u32,
        serde_column: u32,
    ) -> Self {
        DropRecord {
            part: part.to_string(),
            entry_index: entry_index as u32,
            error_class,
            serde_line,
            serde_column,
            payload_length: payload.len() as u32,
            payload_fingerprint: Some(fingerprint_bytes(payload)),
            fingerprint_status: "ok",
            attribution_status: "unavailable",
        }
    }

    /// Build a record for an offset-boundary drop where NOTHING was read.
    /// payload_fingerprint = None; we do NOT hash empty bytes and present it as
    /// a payload identity.
    pub fn no_payload(part: &str, entry_index: usize) -> Self {
        DropRecord {
            part: part.to_string(),
            entry_index: entry_index as u32,
            error_class: DropClass::OffsetBoundary,
            serde_line: 0,
            serde_column: 0,
            payload_length: 0,
            payload_fingerprint: None,
            fingerprint_status: "unavailable_no_payload",
            attribution_status: "unavailable",
        }
    }
}

/// SHA-256 over the RAW payload bytes, truncated to 16 hex chars.
pub fn fingerprint_bytes(payload: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload);
    let digest = hasher.finalize();
    hex::encode(&digest[..FINGERPRINT_HEX_LEN / 2])
}

/// Structured shard accounting. `records` holds ALL dropped entries.
#[derive(Debug, Clone, Default)]
pub struct ShardParseReport {
    pub part: String,
    /// declared count from the NXVF header.
    pub declared_entity_count: u32,
    /// entries the reader kept (survivors).
    pub parsed_entity_count: u32,
    pub records: Vec<DropRecord>,
}

impl ShardParseReport {
    pub fn new(part: &str, declared: u32) -> Self {
        ShardParseReport {
            part: part.to_string(),
            declared_entity_count: declared,
            parsed_entity_count: 0,
            records: Vec::new(),
        }
    }

    pub fn record_parsed(&mut self) {
        self.parsed_entity_count += 1;
    }

    pub fn record_drop(&mut self, rec: DropRecord) {
        self.records.push(rec);
    }

    /// ALL dropped entries (every class).
    pub fn dropped_entity_count(&self) -> u32 {
        self.records.len() as u32
    }

    /// json-parse SUBSET only — NOT offset-boundary/zstd/gzip.
    pub fn parse_error_count(&self) -> u32 {
        self.records
            .iter()
            .filter(|r| r.error_class == DropClass::JsonParse)
            .count() as u32
    }

    /// Conservation: declared == parsed + dropped. The single integrity check.
    pub fn is_conserved(&self) -> bool {
        self.declared_entity_count == self.parsed_entity_count + self.dropped_entity_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_16_hex_over_raw_bytes() {
        let fp = fingerprint_bytes(b"hello");
        assert_eq!(fp.len(), FINGERPRINT_HEX_LEN);
        // sha256("hello") = 2cf24dba5fb0a30e... -> first 8 bytes hex.
        assert_eq!(fp, "2cf24dba5fb0a30e");
    }

    #[test]
    fn distinct_invalid_utf8_sequences_differ() {
        // Both collapse to U+FFFD under lossy conversion, but raw bytes differ,
        // so fingerprints MUST differ.
        let a = fingerprint_bytes(&[0xC0]);
        let b = fingerprint_bytes(&[0xC1]);
        let c = fingerprint_bytes(&[0xFF, 0xFE]);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(b, c);
    }

    #[test]
    fn same_bytes_same_fingerprint() {
        assert_eq!(fingerprint_bytes(b"abc"), fingerprint_bytes(b"abc"));
    }

    #[test]
    fn no_payload_record_has_null_fingerprint() {
        let r = DropRecord::no_payload("part-000.bin", 3);
        assert!(r.payload_fingerprint.is_none());
        assert_eq!(r.fingerprint_status, "unavailable_no_payload");
        assert_eq!(r.payload_length, 0);
        assert_eq!(r.error_class, DropClass::OffsetBoundary);
    }

    #[test]
    fn conservation_and_subset_counts() {
        let mut rep = ShardParseReport::new("part-000.bin", 4);
        rep.record_parsed();
        rep.record_parsed();
        rep.record_drop(DropRecord::no_payload("part-000.bin", 2));
        rep.record_drop(DropRecord::with_payload(
            "part-000.bin",
            3,
            DropClass::JsonParse,
            b"{bad",
            1,
            2,
        ));
        assert_eq!(rep.declared_entity_count, 4);
        assert_eq!(rep.parsed_entity_count, 2);
        assert_eq!(rep.dropped_entity_count(), 2);
        // json subset is 1 (the offset-boundary drop is NOT folded in).
        assert_eq!(rep.parse_error_count(), 1);
        assert!(rep.is_conserved());
    }
}
