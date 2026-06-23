//! W3-O1 (D-88/D-90) integration tests for `read_binary_shard_with_report`.
//!
//! Crafts MINIMAL in-memory NXVF V4.1 shards (no AES key set, raw-JSON
//! payloads) that exercise each silent drop site, then asserts the structured
//! accounting: conservation, class subset, per-record fields, fingerprint
//! fidelity, no-payload null, and survivor byte+order equality vs the
//! pre-feature reader path.
//!
//! NXVF V4.1 layout (mirrors nxvf-core::parse_header):
//!   [0..4]   magic "NXVF"
//!   [7..11]  offset_table_offset (u32 LE)
//!   [11..15] entity_count (u32 LE)
//!   [15..19] checksum = XOR of offset-table u32 words (u32 LE)
//!   HEADER_SIZE = 29; payloads laid out after the header; offset table last.

use nxvf_core::{read_binary_shard, read_binary_shard_with_report, DropClass};
use std::io::Write;

const HEADER_SIZE: usize = 29;

/// Build a minimal NXVF shard. `entries` = (offset_override, payload_bytes).
/// When `offset_override` is Some, that exact (offset,size) is written into the
/// offset table (used to craft an out-of-bounds offset-boundary drop); the
/// payload bytes are NOT laid into the file for an overridden entry.
fn build_shard(entries: &[(Option<(u32, u32)>, Vec<u8>)]) -> Vec<u8> {
    // Lay payloads right after the header.
    let mut body = Vec::new();
    let mut table: Vec<(u32, u32)> = Vec::new();
    let cursor = HEADER_SIZE as u32;
    for (override_ot, payload) in entries {
        if let Some(ov) = override_ot {
            table.push(*ov);
        } else {
            let off = cursor + body.len() as u32;
            table.push((off, payload.len() as u32));
            body.extend_from_slice(payload);
        }
    }
    let ot_offset = HEADER_SIZE as u32 + body.len() as u32;
    // checksum = XOR of every u32 word in the offset table.
    let mut checksum: u32 = 0;
    for (off, size) in &table {
        checksum ^= *off;
        checksum ^= *size;
    }

    let mut out = Vec::new();
    out.extend_from_slice(&[0x4E, 0x58, 0x56, 0x46]); // "NXVF"
    out.extend_from_slice(&[0u8; 3]); // [4..7] pad
    out.extend_from_slice(&ot_offset.to_le_bytes()); // [7..11]
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes()); // [11..15]
    out.extend_from_slice(&checksum.to_le_bytes()); // [15..19]
    out.extend_from_slice(&[0u8; HEADER_SIZE - 19]); // [19..29] pad
    debug_assert_eq!(out.len(), HEADER_SIZE);
    out.extend_from_slice(&body);
    for (off, size) in &table {
        out.extend_from_slice(&off.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
    }
    out
}

fn write_temp(name: &str, bytes: &[u8]) -> String {
    let mut p = std::env::temp_dir();
    p.push(format!("nxvf-w3o1-{}-{}.bin", name, std::process::id()));
    let mut f = std::fs::File::create(&p).unwrap();
    f.write_all(bytes).unwrap();
    p.to_string_lossy().into_owned()
}

#[test]
fn conservation_and_json_subset_only() {
    // 2 good entities + 1 malformed-JSON drop + 1 offset-boundary drop.
    let good_a = br#"{"id":"a","fni_score":1.0}"#.to_vec();
    let good_b = br#"{"id":"b","fni_score":2.0}"#.to_vec();
    let bad_json = br#"{"id":"c", broken json"#.to_vec();
    let shard = build_shard(&[
        (None, good_a.clone()),
        (None, bad_json.clone()),
        (None, good_b.clone()),
        // offset-boundary: offset far past EOF, nonzero size.
        (Some((9_000_000, 16)), Vec::new()),
    ]);
    let path = write_temp("conserve", &shard);
    let (entities, report) = read_binary_shard_with_report(&path).unwrap();
    std::fs::remove_file(&path).ok();

    assert_eq!(report.declared_entity_count, 4);
    assert_eq!(report.parsed_entity_count, 2);
    assert_eq!(entities.len(), 2);
    assert_eq!(report.dropped_entity_count(), 2);
    // json subset == 1 (the offset-boundary drop is a DISTINCT class).
    assert_eq!(report.parse_error_count(), 1);
    assert!(report.is_conserved(), "declared == parsed + dropped");

    // Distinct classes present, not folded.
    let classes: Vec<DropClass> = report.records.iter().map(|r| r.error_class).collect();
    assert!(classes.contains(&DropClass::JsonParse));
    assert!(classes.contains(&DropClass::OffsetBoundary));
}

#[test]
fn per_record_fields_and_no_payload_null() {
    let bad_json = br#"{not valid"#.to_vec();
    let shard = build_shard(&[(None, bad_json.clone()), (Some((8_000_000, 8)), Vec::new())]);
    let path = write_temp("fields", &shard);
    let (_e, report) = read_binary_shard_with_report(&path).unwrap();
    std::fs::remove_file(&path).ok();

    let json_rec = report
        .records
        .iter()
        .find(|r| r.error_class == DropClass::JsonParse)
        .unwrap();
    assert!(json_rec.part.contains("nxvf-w3o1-fields"));
    assert_eq!(json_rec.entry_index, 0);
    assert_eq!(json_rec.payload_length as usize, bad_json.len());
    assert!(json_rec.payload_fingerprint.is_some());
    assert_eq!(json_rec.payload_fingerprint.as_ref().unwrap().len(), 16);
    assert_eq!(json_rec.fingerprint_status, "ok");
    // serde line/column are real coordinates (>=1 for a single-line payload).
    assert!(json_rec.serde_line >= 1);
    assert!(json_rec.serde_column >= 1);
    // NXVF has no out-of-JSON identity envelope -> always unavailable.
    assert_eq!(json_rec.attribution_status, "unavailable");

    let ob = report
        .records
        .iter()
        .find(|r| r.error_class == DropClass::OffsetBoundary)
        .unwrap();
    assert_eq!(ob.entry_index, 1);
    assert!(ob.payload_fingerprint.is_none(), "no payload -> null fp");
    assert_eq!(ob.fingerprint_status, "unavailable_no_payload");
    assert_eq!(ob.payload_length, 0);
}

#[test]
fn fingerprint_over_raw_bytes_distinguishes_invalid_utf8() {
    // Two malformed-JSON payloads whose ONLY difference is an invalid-UTF-8 byte
    // that collapses to U+FFFD under lossy conversion. Raw-byte SHA-256 must
    // still produce DIFFERENT fingerprints.
    let mut p_a = b"{bad".to_vec();
    p_a.push(0xC0);
    let mut p_b = b"{bad".to_vec();
    p_b.push(0xC1);
    let shard = build_shard(&[(None, p_a.clone()), (None, p_b.clone())]);
    let path = write_temp("utf8", &shard);
    let (_e, report) = read_binary_shard_with_report(&path).unwrap();
    std::fs::remove_file(&path).ok();

    assert_eq!(report.dropped_entity_count(), 2);
    let fp0 = report.records[0].payload_fingerprint.clone().unwrap();
    let fp1 = report.records[1].payload_fingerprint.clone().unwrap();
    assert_ne!(fp0, fp1, "distinct invalid-utf8 -> distinct fingerprint");
}

#[test]
fn survivor_output_byte_and_order_identical_to_legacy_reader() {
    // The thin survivor-only wrapper must return EXACTLY the same Vec (value +
    // order) as the report variant's survivors — the accounting is side-channel.
    let good_a = br#"{"id":"a","x":1}"#.to_vec();
    let good_b = br#"{"id":"b","x":2}"#.to_vec();
    let bad = br#"{nope"#.to_vec();
    let good_c = br#"{"id":"c","x":3}"#.to_vec();
    let shard = build_shard(&[(None, good_a), (None, bad), (None, good_b), (None, good_c)]);
    let path = write_temp("order", &shard);
    let legacy = read_binary_shard(&path).unwrap();
    let (with_report, _r) = read_binary_shard_with_report(&path).unwrap();
    std::fs::remove_file(&path).ok();

    assert_eq!(legacy, with_report, "survivor set identical");
    let ids: Vec<&str> = with_report
        .iter()
        .map(|e| e.get("id").and_then(|v| v.as_str()).unwrap_or(""))
        .collect();
    assert_eq!(ids, vec!["a", "b", "c"], "order preserved, drop excised");
}
