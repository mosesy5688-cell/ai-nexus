//! W3-O1 hermetic tests: build tiny in-memory NXVF V4.1 shards (mirrors
//! shard-writer.js's 29-byte header + trailing [offset,size] table) with known
//! good + known-malformed entries, then assert the structured parse accounting.
//!
//! Payloads are written as RAW JSON bytes (no Zstd/AES) so the tests are
//! deterministic without an AES key — `is_valid_payload` accepts `{"` / `[{`
//! and the reader skips decrypt+decompress, exercising the pure parse path.
//! The healthy path here is byte-identical to production for valid JSON entries.

use std::io::Write;

use nxvf_core::{read_binary_shard, read_binary_shard_accounted};

const HEADER_SIZE: usize = 29;
const NXVF_MAGIC: [u8; 4] = [0x4E, 0x58, 0x56, 0x46];

/// Build an NXVF V4.1 shard from raw payload byte-slices and write it to a temp
/// file; returns the path. `declared_count` lets a test DECLARE more entries
/// than payloads to force an offset_boundary drop (the trailing slots point past
/// EOF). Layout: [header][payload0..N][offset table], header.offset_table_offset
/// points at the table, header.entity_count = declared_count.
fn build_shard(dir: &std::path::Path, name: &str, payloads: &[&[u8]], declared_count: u32) -> String {
    let mut body = Vec::new();
    let mut offsets: Vec<(u32, u32)> = Vec::new();
    let mut cursor = HEADER_SIZE as u32;
    for p in payloads {
        offsets.push((cursor, p.len() as u32));
        body.extend_from_slice(p);
        cursor += p.len() as u32;
    }
    // Declared but unwritten slots -> point PAST EOF (forces offset_boundary).
    for _ in payloads.len()..declared_count as usize {
        offsets.push((cursor + 10_000_000, 64));
    }

    let ot_offset = HEADER_SIZE as u32 + body.len() as u32;
    let mut offset_table = Vec::new();
    for (off, size) in &offsets {
        offset_table.extend_from_slice(&off.to_le_bytes());
        offset_table.extend_from_slice(&size.to_le_bytes());
    }
    let mut checksum: u32 = 0;
    for chunk in offset_table.chunks_exact(4) {
        checksum ^= u32::from_le_bytes(chunk.try_into().unwrap());
    }

    let mut header = vec![0u8; HEADER_SIZE];
    header[0..4].copy_from_slice(&NXVF_MAGIC);
    header[4] = 0x41;
    header[7..11].copy_from_slice(&ot_offset.to_le_bytes());
    header[11..15].copy_from_slice(&declared_count.to_le_bytes());
    header[15..19].copy_from_slice(&checksum.to_le_bytes());

    let mut file = Vec::new();
    file.extend_from_slice(&header);
    file.extend_from_slice(&body);
    file.extend_from_slice(&offset_table);

    let path = dir.join(name);
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(&file).unwrap();
    path.to_str().unwrap().to_string()
}

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let mut d = std::env::temp_dir();
    d.push(format!("w3o1-{}-{}", tag, std::process::id()));
    let _ = std::fs::create_dir_all(&d);
    d
}

const GOOD_A: &[u8] = br#"{"id":"good-a","umid":"aaaa","v":1}"#;
const GOOD_B: &[u8] = br#"{"id":"good-b","umid":"bbbb","v":2}"#;
// Malformed JSON that ALSO fails sanitize (unterminated object). Starts with `{"`
// so is_valid_payload passes -> reaches the serde drop site (the W3 case).
const BAD_SHORT: &[u8] = br#"{"id":"x","#;
// Malformed in a LONG text field: a big value but an unterminated string.
fn bad_long() -> Vec<u8> {
    let big = "Z".repeat(4000);
    format!(r#"{{"id":"y","readme":"{}"#, big).into_bytes() // unterminated string
}

// Gate 1: healthy shard — declared == parsed, dropped == 0.
#[test]
fn gate1_healthy_shard() {
    let dir = tmpdir("g1");
    let p = build_shard(&dir, "g1.bin", &[GOOD_A, GOOD_B], 2);
    let (entities, r) = read_binary_shard_accounted(&p).unwrap();
    assert_eq!(entities.len(), 2);
    assert_eq!(r.declared_entity_count, 2);
    assert_eq!(r.parsed_entity_count, 2);
    assert_eq!(r.dropped_entity_count, 0);
    assert!(r.conserved());
}

// Gate 2: single malformed-JSON -> dropped == 1 exact.
#[test]
fn gate2_single_malformed() {
    let dir = tmpdir("g2");
    let p = build_shard(&dir, "g2.bin", &[GOOD_A, BAD_SHORT, GOOD_B], 3);
    let (entities, r) = read_binary_shard_accounted(&p).unwrap();
    assert_eq!(entities.len(), 2);
    assert_eq!(r.dropped_entity_count, 1);
    assert_eq!(r.parse_error_count, 1);
    assert_eq!(r.drops[0].error_class.as_str(), "json_parse_error");
    assert_eq!(r.drops[0].entry_index, 1);
    assert!(r.conserved());
}

// Gate 3: multiple malformed -> exact counts.
#[test]
fn gate3_multiple_malformed() {
    let dir = tmpdir("g3");
    let bl = bad_long();
    let p = build_shard(&dir, "g3.bin", &[BAD_SHORT, GOOD_A, &bl, GOOD_B], 4);
    let (entities, r) = read_binary_shard_accounted(&p).unwrap();
    assert_eq!(entities.len(), 2);
    assert_eq!(r.dropped_entity_count, 2);
    assert_eq!(r.parse_error_count, 2);
    assert!(r.conserved());
}

// Gate 4: malformed in a SHORT field -> recorded with coords.
#[test]
fn gate4_malformed_short_field() {
    let dir = tmpdir("g4");
    let p = build_shard(&dir, "g4.bin", &[BAD_SHORT], 1);
    let (_e, r) = read_binary_shard_accounted(&p).unwrap();
    assert_eq!(r.dropped_entity_count, 1);
    // serde reports a line/column for the truncation.
    assert!(r.drops[0].serde_column > 0 || r.drops[0].serde_line > 0);
}

// Gate 5: malformed in a LONG text field -> still exactly one drop, no payload leak.
#[test]
fn gate5_malformed_long_field() {
    let dir = tmpdir("g5");
    let bl = bad_long();
    let p = build_shard(&dir, "g5.bin", &[&bl], 1);
    let (_e, r) = read_binary_shard_accounted(&p).unwrap();
    assert_eq!(r.dropped_entity_count, 1);
    assert_eq!(r.drops[0].payload_length, bl.len()); // length captured, bytes not
}

// Gate 6: every drop has a stable 16-hex fingerprint.
#[test]
fn gate6_stable_fingerprint_shape() {
    let dir = tmpdir("g6");
    let p = build_shard(&dir, "g6.bin", &[BAD_SHORT], 1);
    let (_e, r) = read_binary_shard_accounted(&p).unwrap();
    let fp = &r.drops[0].payload_fingerprint;
    assert_eq!(fp.len(), 16);
    assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
}

// Gate 7: same payload across two reads -> identical fingerprint.
#[test]
fn gate7_fingerprint_deterministic() {
    let dir = tmpdir("g7");
    let p = build_shard(&dir, "g7.bin", &[BAD_SHORT], 1);
    let (_e1, r1) = read_binary_shard_accounted(&p).unwrap();
    let (_e2, r2) = read_binary_shard_accounted(&p).unwrap();
    assert_eq!(r1.drops[0].payload_fingerprint, r2.drops[0].payload_fingerprint);
}

// Gate 8: different payloads -> different fingerprints.
#[test]
fn gate8_fingerprint_distinct() {
    let dir = tmpdir("g8");
    let bl = bad_long();
    let p = build_shard(&dir, "g8.bin", &[BAD_SHORT, &bl], 2);
    let (_e, r) = read_binary_shard_accounted(&p).unwrap();
    assert_eq!(r.drops.len(), 2);
    assert_ne!(r.drops[0].payload_fingerprint, r.drops[1].payload_fingerprint);
}

// Gate 9: raw source text never appears in the report. The malformed payload
// embeds a sentinel; assert it is NOWHERE in the serialized record.
#[test]
fn gate9_no_raw_source_in_report() {
    let dir = tmpdir("g9");
    let secret = br#"{"id":"s","token":"SUPERSECRET_TOKEN_DO_NOT_LEAK","#;
    let p = build_shard(&dir, "g9.bin", &[secret.as_slice()], 1);
    let (_e, r) = read_binary_shard_accounted(&p).unwrap();
    let d = &r.drops[0];
    let dump = format!(
        "{} {} {} {} {} {} {} {}",
        d.part, d.entry_index, d.error_class.as_str(), d.serde_line,
        d.serde_column, d.payload_length, d.payload_fingerprint, d.attribution_status
    );
    assert!(!dump.contains("SUPERSECRET_TOKEN_DO_NOT_LEAK"));
    assert!(!dump.contains("token"));
}

// Gate 10: identity unavailable -> "unavailable", never fabricated.
#[test]
fn gate10_identity_unavailable() {
    let dir = tmpdir("g10");
    let p = build_shard(&dir, "g10.bin", &[BAD_SHORT], 1);
    let (_e, r) = read_binary_shard_accounted(&p).unwrap();
    assert_eq!(r.drops[0].attribution_status, "unavailable");
}

// Gate 11: best-effort extraction is never marked authoritative. The reader does
// NOT scan malformed bytes for an id, so no drop is ever "authoritative" or
// "best_effort" — proving best-effort cannot reach an authority chain.
#[test]
fn gate11_best_effort_never_authoritative() {
    let dir = tmpdir("g11");
    // payload literally contains a well-formed-looking id, but it's malformed JSON.
    let withid = br#"{"id":"real-looking-id","#;
    let p = build_shard(&dir, "g11.bin", &[withid.as_slice()], 1);
    let (_e, r) = read_binary_shard_accounted(&p).unwrap();
    assert_ne!(r.drops[0].attribution_status, "authoritative");
    assert_ne!(r.drops[0].attribution_status, "best_effort");
}

// Gate 15: healthy-path entity OUTPUT unchanged — the thin wrapper returns the
// same Vec as the accounted worker.
#[test]
fn gate15_healthy_output_unchanged() {
    let dir = tmpdir("g15");
    let p = build_shard(&dir, "g15.bin", &[GOOD_A, GOOD_B], 2);
    let via_wrapper = read_binary_shard(&p).unwrap();
    let (via_worker, _r) = read_binary_shard_accounted(&p).unwrap();
    assert_eq!(via_wrapper, via_worker);
    assert_eq!(via_wrapper[0]["id"], "good-a");
    assert_eq!(via_wrapper[1]["id"], "good-b");
}

// Gate 16: drops do NOT alter surviving entity fields (no payload/field mutation).
#[test]
fn gate16_survivors_unmutated_amid_drops() {
    let dir = tmpdir("g16");
    let p = build_shard(&dir, "g16.bin", &[GOOD_A, BAD_SHORT, GOOD_B], 3);
    let e = read_binary_shard(&p).unwrap();
    assert_eq!(e.len(), 2);
    assert_eq!(e[0], serde_json::json!({"id":"good-a","umid":"aaaa","v":1}));
    assert_eq!(e[1], serde_json::json!({"id":"good-b","umid":"bbbb","v":2}));
}

// Conservation under offset_boundary drops (supports gate 12/17 reasoning): a
// declared count exceeding written payloads yields offset_boundary drops that
// still conserve, and the json-parse subset stays correct.
#[test]
fn offset_boundary_conserved_and_classified() {
    let dir = tmpdir("ob");
    // 2 written (1 good, 1 bad-json) but declare 4 -> 2 offset_boundary drops.
    let p = build_shard(&dir, "ob.bin", &[GOOD_A, BAD_SHORT], 4);
    let (entities, r) = read_binary_shard_accounted(&p).unwrap();
    assert_eq!(entities.len(), 1);
    assert_eq!(r.declared_entity_count, 4);
    assert_eq!(r.parsed_entity_count, 1);
    assert_eq!(r.dropped_entity_count, 3); // 1 json + 2 offset_boundary
    assert_eq!(r.parse_error_count, 1);    // json subset only
    assert!(r.conserved());
    let mut classes = r.distinct_error_classes();
    classes.sort_unstable();
    assert_eq!(classes, vec!["json_parse_error", "offset_boundary"]);
    // offset_boundary drops carry empty-payload length 0.
    let ob = r.drops.iter().find(|d| d.error_class.as_str() == "offset_boundary").unwrap();
    assert_eq!(ob.payload_length, 0);
}
