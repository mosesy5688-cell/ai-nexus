//! Streaming SAME_AS edge reader over PR-C1 assertion shards.
//!
//! GATE 5 (real streaming reader): mirrors `nxvf-core::for_each_raw_entity`'s
//! decompress -> fixed-chunk -> incremental-scan -> raw &[u8] callback discipline
//! (O(1)/record, no full-file Vec, no whole-corpus HashMap). FORBIDDEN by design:
//! `load_json_file`, `serde_json::from_reader` over the whole file, any `Vec` /
//! `HashMap` holding the entire corpus.
//!
//! PR-C1 on-disk format (assertion-generator.js:133-135): each shard is
//! `assertions-NN.jsonl.zst` = Zstd-compressed JSONL — one assertion OBJECT per
//! line (NOT wrapped in a JSON array). So this is a LINE-delimited equivalent of
//! for_each_raw_entity (which brace-matches at depth==1, i.e. needs an outer `[`).
//! We consume ONLY the SAME_AS edges: `relation == "SAME_AS"` -> (member_a, member_b).
//! MANIFESTATION_OF rows are skipped (C.3: can never enter a SAME_AS fold).

use std::fs::File;
use std::io::{BufReader, Read};

const CHUNK: usize = 65536;

/// One streamed SAME_AS edge: an undirected identity equivalence between two
/// distinct canonical_ids (already sorted member_a < member_b by the producer).
pub struct SameAsEdge {
    pub a: String,
    pub b: String,
}

/// Stream SAME_AS edges from ONE `assertions-NN.jsonl.zst` shard, invoking
/// `on_edge` per edge. O(1 line) memory: a Zstd streaming decoder feeds fixed
/// 64KB chunks into a single reusable line buffer; each completed line is parsed,
/// filtered to SAME_AS, and dropped. Returns the number of SAME_AS edges emitted.
pub fn for_each_same_as_edge<F>(path: &str, mut on_edge: F) -> Result<usize, String>
where
    F: FnMut(SameAsEdge) -> Result<(), String>,
{
    let file = File::open(path).map_err(|e| format!("open {}: {}", path, e))?;
    let mut reader: Box<dyn Read> = if path.ends_with(".zst") {
        Box::new(zstd::Decoder::new(BufReader::new(file)).map_err(|e| format!("zstd {}: {}", path, e))?)
    } else {
        Box::new(BufReader::new(file))
    };

    let mut line = Vec::<u8>::new();
    let mut chunk = vec![0u8; CHUNK];
    let mut emitted = 0usize;

    loop {
        let n = reader.read(&mut chunk).map_err(|e| format!("read {}: {}", path, e))?;
        if n == 0 {
            break;
        }
        for &c in &chunk[..n] {
            if c == b'\n' {
                if parse_line(&line, &mut on_edge)? {
                    emitted += 1;
                }
                line.clear();
            } else {
                line.push(c);
            }
        }
    }
    // Trailing line without newline (defensive; producer always appends '\n').
    if !line.is_empty() && parse_line(&line, &mut on_edge)? {
        emitted += 1;
    }
    Ok(emitted)
}

/// Parse one JSONL line; emit an edge IFF it is a well-formed SAME_AS assertion
/// with two distinct string members. Returns true when an edge was emitted.
/// Non-SAME_AS / malformed lines are skipped (returns false), never silently
/// corrupting the graph. Per-line serde over a SMALL slice — never the whole file.
fn parse_line<F>(line: &[u8], on_edge: &mut F) -> Result<bool, String>
where
    F: FnMut(SameAsEdge) -> Result<(), String>,
{
    if line.is_empty() {
        return Ok(false);
    }
    let v: serde_json::Value = match serde_json::from_slice(line) {
        Ok(v) => v,
        Err(_) => return Ok(false), // tolerate a stray non-JSON line; do not abort the sweep
    };
    if v.get("relation").and_then(|r| r.as_str()) != Some("SAME_AS") {
        return Ok(false);
    }
    let a = v.get("member_a").and_then(|m| m.as_str());
    let b = v.get("member_b").and_then(|m| m.as_str());
    match (a, b) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() && a != b => {
            on_edge(SameAsEdge { a: a.to_string(), b: b.to_string() })?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Discover assertion shards in a directory, in deterministic name order.
/// Matches the PR-C1 producer naming `assertions-NN.jsonl.zst`.
pub fn discover_assertion_shards(dir: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let rd = std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {}", dir, e))?;
    for entry in rd {
        let entry = entry.map_err(|e| format!("dir entry: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("assertions-") && name.ends_with(".jsonl.zst") {
            out.push(entry.path().to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_jsonl_zst(path: &str, lines: &[&str]) {
        let body = lines.join("\n") + "\n";
        let comp = zstd::encode_all(body.as_bytes(), 3).unwrap();
        std::fs::write(path, comp).unwrap();
    }

    #[test]
    fn reads_only_same_as_edges() {
        let dir = std::env::temp_dir().join("idc_reader_test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("assertions-00.jsonl.zst");
        let pp = p.to_string_lossy().to_string();
        write_jsonl_zst(
            &pp,
            &[
                r#"{"relation":"SAME_AS","member_a":"a","member_b":"b","method":"exact_source_url_xref"}"#,
                r#"{"relation":"MANIFESTATION_OF","member_a":"a","member_b":"c","method":"uses_xref"}"#,
                r#"{"relation":"SAME_AS","member_a":"b","member_b":"d","method":"exact_source_url_xref"}"#,
            ],
        );
        let mut edges = Vec::new();
        let n = for_each_same_as_edge(&pp, |e| {
            edges.push((e.a, e.b));
            Ok(())
        })
        .unwrap();
        assert_eq!(n, 2, "only the 2 SAME_AS rows are edges; MANIFESTATION_OF skipped");
        assert!(edges.contains(&("a".into(), "b".into())));
        assert!(edges.contains(&("b".into(), "d".into())));
    }

    #[test]
    fn tolerates_malformed_line_without_aborting() {
        let dir = std::env::temp_dir().join("idc_reader_test2");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("assertions-00.jsonl.zst").to_string_lossy().to_string();
        write_jsonl_zst(
            &p,
            &[
                "not json at all",
                r#"{"relation":"SAME_AS","member_a":"x","member_b":"y"}"#,
            ],
        );
        let mut c = 0;
        for_each_same_as_edge(&p, |_| {
            c += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(c, 1, "the valid SAME_AS line still emits despite the junk line");
    }
}
