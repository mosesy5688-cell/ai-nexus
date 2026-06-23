//! W3-O1 parse-attrition observability — structured accounting for the NXVF
//! binary-shard reader. OBSERVE-ONLY: this module NEVER mutates payloads, entity
//! fields, the AES/Zstd/offset-table codec, or the publication floor. It only
//! COUNTS, CLASSIFIES, and FINGERPRINTS entries the reader drops, so the silent
//! ~0.005%/cycle attrition (~31 entities) becomes observable downstream.
//!
//! HONEST ATTRIBUTION (Part 3): the NXVF V4.1 format (see shard-writer.js) stores
//! ONLY `[uint32 offset, uint32 size]` per entity in the trailing offset table —
//! identity (`id`/`umid`) lives EXCLUSIVELY inside the encrypted+compressed JSON
//! payload. For a dropped entry the JSON is precisely the malformed thing, and
//! the per-shard `v4-manifest.json` is aggregate-only (no entry_index→id map).
//! There is therefore NO out-of-JSON authoritative identity envelope for these
//! shards, so every drop is recorded `attribution_status = "unavailable"`. We do
//! NOT regex-scan the malformed bytes for a best-effort id: that could only be
//! "best_effort" (never authoritative) AND risks surfacing raw source — both
//! forbidden here. No ids are fabricated; we deliver part + entry_index +
//! serde_column + fingerprint and stop.

use crate::sha256_hex16;

/// Classification of a single dropped binary-shard entry. Kept as a stable
/// string in the record so the Node side never re-derives it from console text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// Offset+size exceeds file bounds — the entry was skipped before decode.
    OffsetBoundary,
    /// Zstd decompression failed.
    ZstdError,
    /// Gzip decompression failed.
    GzipError,
    /// serde_json rejected the (decoded) payload after sanitize + forced-decrypt.
    JsonParseError,
}

impl ErrorClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorClass::OffsetBoundary => "offset_boundary",
            ErrorClass::ZstdError => "zstd_error",
            ErrorClass::GzipError => "gzip_error",
            ErrorClass::JsonParseError => "json_parse_error",
        }
    }
}

/// One structured record per dropped entry. Carries ONLY irreversible coordinates
/// — never the failed payload, README/abstract text, tokens, or keys.
#[derive(Debug, Clone)]
pub struct DropRecord {
    /// Shard file name (e.g. "fused-shard-007.bin").
    pub part: String,
    /// Entity index `i` within the shard's offset table.
    pub entry_index: usize,
    pub error_class: ErrorClass,
    /// serde "line" coordinate (json_parse_error only; 0 for non-serde classes).
    pub serde_line: usize,
    /// serde "column" coordinate (json_parse_error only; 0 for non-serde classes).
    pub serde_column: usize,
    /// Decoded payload byte length available at the drop site (0 if undecodable).
    pub payload_length: usize,
    /// IRREVERSIBLE fingerprint: first 16 hex of sha256 of the payload bytes.
    pub payload_fingerprint: String,
    /// Always "unavailable" for NXVF .bin (no out-of-JSON identity envelope).
    pub attribution_status: &'static str,
}

impl DropRecord {
    /// Build a drop record. `payload` is the bytes available at the drop site
    /// (may be empty for offset_boundary, where nothing was read). Only its
    /// LENGTH and irreversible FINGERPRINT are retained — the bytes are dropped.
    pub fn new(
        part: &str,
        entry_index: usize,
        error_class: ErrorClass,
        serde_line: usize,
        serde_column: usize,
        payload: &[u8],
    ) -> Self {
        DropRecord {
            part: part.to_string(),
            entry_index,
            error_class,
            serde_line,
            serde_column,
            payload_length: payload.len(),
            payload_fingerprint: fingerprint(payload),
            attribution_status: "unavailable",
        }
    }
}

/// Irreversible short fingerprint of arbitrary bytes: first 16 hex of sha256.
/// Reuses the crate's existing `sha256_hex16` so the hash is consistent and
/// stable across reads (test gates 6/7/8). Lossy by construction — the input
/// bytes cannot be recovered, so no raw source/token/key can leak through it.
pub fn fingerprint(payload: &[u8]) -> String {
    // sha256_hex16 hashes a &str; bytes are mapped 1:1 to a lossy UTF-8 view
    // ONLY to feed the hasher. Two identical byte payloads -> identical view ->
    // identical digest (gate 7); different payloads -> different view w.h.p.
    // (gate 8). The fingerprint is never reversed back to text.
    sha256_hex16(&String::from_utf8_lossy(payload))
}

/// Parse serde "... at line L column C" coordinates from a serde_json error.
/// Returns (line, column); (0, 0) when the message has no coordinates.
pub fn parse_serde_coords(msg: &str) -> (usize, usize) {
    let line = scan_after(msg, "line ");
    let column = scan_after(msg, "column ");
    (line, column)
}

fn scan_after(haystack: &str, marker: &str) -> usize {
    if let Some(pos) = haystack.find(marker) {
        let tail = &haystack[pos + marker.len()..];
        let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
        return digits.parse().unwrap_or(0);
    }
    0
}

/// W3-O1 capability-handshake protocol version (Finding B / D-89). A summary that
/// self-declares this constant PROVES a protocol-v1-capable reader produced it; a
/// default-zero / absent field can NEVER be inferred as v1, so a stale `.node` (no
/// protocol export) is classified NOT_ACTIVE (WARN) rather than masquerading as an
/// integrity FAIL. Mirrored across the NAPI surface as `nxvfParseAccountingProtocol()`.
pub const NXVF_PARSE_ACCOUNTING_PROTOCOL: u32 = 1;

/// Aggregate accounting for a single binary-shard read. INVARIANT (unit-tested):
/// `declared_entity_count == parsed_entity_count + dropped_entity_count`.
#[derive(Debug, Clone)]
pub struct ShardParseReport {
    /// W3-O1 self-declared protocol version (always `NXVF_PARSE_ACCOUNTING_PROTOCOL`
    /// for a report this reader produced). Carried into the NAPI summary so the JS
    /// canary's capability handshake can PROVE v1 was live (Finding B / D-89).
    pub protocol_version: u32,
    /// From the NXVF header (`entity_count`).
    pub declared_entity_count: usize,
    /// Entities successfully pushed to the output Vec.
    pub parsed_entity_count: usize,
    /// ALL dropped entries (offset_boundary + zstd + gzip + json_parse).
    pub dropped_entity_count: usize,
    /// The json_parse subset of `dropped_entity_count`.
    pub parse_error_count: usize,
    /// One structured record per dropped entry.
    pub drops: Vec<DropRecord>,
}

impl ShardParseReport {
    pub fn new(declared: usize) -> Self {
        ShardParseReport {
            protocol_version: NXVF_PARSE_ACCOUNTING_PROTOCOL,
            declared_entity_count: declared,
            parsed_entity_count: 0,
            dropped_entity_count: 0,
            parse_error_count: 0,
            drops: Vec::new(),
        }
    }

    /// Record a successful parse (no payload retained).
    pub fn record_parsed(&mut self) {
        self.parsed_entity_count += 1;
    }

    /// Record a dropped entry, classifying it and storing its structured record.
    pub fn record_drop(&mut self, record: DropRecord) {
        self.dropped_entity_count += 1;
        if record.error_class == ErrorClass::JsonParseError {
            self.parse_error_count += 1;
        }
        self.drops.push(record);
    }

    /// Conservation invariant: declared == parsed + dropped.
    pub fn conserved(&self) -> bool {
        self.declared_entity_count == self.parsed_entity_count + self.dropped_entity_count
    }

    /// Distinct error_class strings present in this shard's drops (sorted, unique).
    pub fn distinct_error_classes(&self) -> Vec<&'static str> {
        let mut classes: Vec<&'static str> =
            self.drops.iter().map(|d| d.error_class.as_str()).collect();
        classes.sort_unstable();
        classes.dedup();
        classes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conservation_holds_and_subset_counts() {
        let mut r = ShardParseReport::new(3);
        r.record_parsed();
        r.record_drop(DropRecord::new("p.bin", 1, ErrorClass::JsonParseError, 1, 5, b"{bad"));
        r.record_drop(DropRecord::new("p.bin", 2, ErrorClass::ZstdError, 0, 0, b"\x28zz"));
        assert_eq!(r.parsed_entity_count, 1);
        assert_eq!(r.dropped_entity_count, 2);
        assert_eq!(r.parse_error_count, 1); // json subset only
        assert!(r.conserved());
        assert_eq!(r.distinct_error_classes(), vec!["json_parse_error", "zstd_error"]);
    }

    #[test]
    fn fingerprint_stable_and_distinct() {
        assert_eq!(fingerprint(b"payload-A"), fingerprint(b"payload-A")); // gate 7
        assert_ne!(fingerprint(b"payload-A"), fingerprint(b"payload-B")); // gate 8
        assert_eq!(fingerprint(b"x").len(), 16); // gate 6 shape
    }

    #[test]
    fn serde_coords_parse() {
        assert_eq!(parse_serde_coords("expected `,` at line 4 column 17"), (4, 17));
        assert_eq!(parse_serde_coords("no coordinates here"), (0, 0));
    }

    #[test]
    fn attribution_is_unavailable_never_fabricated() {
        let d = DropRecord::new("p.bin", 0, ErrorClass::JsonParseError, 1, 1, b"{");
        assert_eq!(d.attribution_status, "unavailable"); // gate 10
    }

    #[test]
    fn report_self_declares_protocol_v1() {
        // Finding B: every report this reader produces self-declares protocol v1,
        // so the JS canary can PROVE a v1-capable reader ran. A zero/absent field
        // must never be inferable as v1 — this asserts the producer side of that.
        let r = ShardParseReport::new(0);
        assert_eq!(r.protocol_version, 1);
        assert_eq!(NXVF_PARSE_ACCOUNTING_PROTOCOL, 1);
    }
}
