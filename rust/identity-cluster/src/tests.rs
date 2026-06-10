//! Integration tests = the 6 acceptance gates DEMONSTRATED on fixtures.
//! Each test below is named for the gate it enforces so CI failures map directly.

use super::*;

/// Write `assertions-00.jsonl.zst` from (a,b,relation) triples into a fresh dir.
fn write_assertions(dir: &str, rows: &[(&str, &str, &str)]) {
    std::fs::create_dir_all(dir).unwrap();
    let mut lines = Vec::new();
    for (a, b, rel) in rows {
        lines.push(format!(
            r#"{{"relation":"{}","member_a":"{}","member_b":"{}","method":"exact_source_url_xref","evidence":[{{"weight":1.0}}]}}"#,
            rel, a, b
        ));
    }
    let body = lines.join("\n") + "\n";
    let comp = zstd::encode_all(body.as_bytes(), 3).unwrap();
    std::fs::write(format!("{}/assertions-00.jsonl.zst", dir), comp).unwrap();
}

fn fresh(name: &str) -> (String, String, String) {
    let base = std::env::temp_dir().join(format!("idc_{}", name));
    let _ = std::fs::remove_dir_all(&base);
    let a = base.join("assert").to_string_lossy().to_string();
    let w = base.join("work").to_string_lossy().to_string();
    let o = base.join("out").to_string_lossy().to_string();
    (a, w, o)
}

/// Read back the assignment artifact as node->cluster_id.
fn read_assignment(output_dir: &str) -> HashMap<String, String> {
    let data = std::fs::read(format!("{}/cluster-assignment.jsonl.zst", output_dir)).unwrap();
    let text = String::from_utf8(zstd::decode_all(&data[..]).unwrap()).unwrap();
    let mut out = HashMap::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        out.insert(
            v["canonical_id"].as_str().unwrap().to_string(),
            v["cluster_id"].as_str().unwrap().to_string(),
        );
    }
    out
}

/// CONFIRM: cluster_id = lexicographic min(canonical_id) on a multi-node component.
/// Chain z-m, m-a, a-q -> one component {a,m,q,z} -> all map to "a".
#[test]
fn cluster_id_is_lexicographic_min_on_multinode_component() {
    let (a, w, o) = fresh("lexmin");
    write_assertions(&a, &[("z", "m", "SAME_AS"), ("m", "a", "SAME_AS"), ("a", "q", "SAME_AS")]);
    let s = run(&a, &w, &o, 16, 50, true).unwrap();
    assert!(s.converged);
    let asg = read_assignment(&o);
    for node in ["a", "m", "q", "z"] {
        assert_eq!(asg.get(node), Some(&"a".to_string()), "{} must fold to min 'a'", node);
    }
    assert_eq!(s.non_singleton_clusters, 1);
}

/// GATE 1 (regression — RETAINED): high-K LOWERS peak resident node count.
/// Many distinct ids; max_partition_nodes must STRICTLY fall as K rises (~N/K).
/// A global id-map would be K-INVARIANT -> this test would fail (D4-rollback).
#[test]
fn gate1_high_k_lowers_peak_resident_nodes() {
    let (a, _w, _o) = fresh("gate1");
    // 4000 distinct ids in 2000 disjoint PAIRS (the real singleton/pair shape):
    // high distinct-id count, tiny diameter -> converges fast, isolating the
    // memory dimension this gate measures.
    let n = 4000usize;
    let mut rows = Vec::new();
    let ids: Vec<String> = (0..n).map(|i| format!("node-{:06}", i)).collect();
    for i in (0..n).step_by(2) {
        rows.push((ids[i].as_str(), ids[i + 1].as_str(), "SAME_AS"));
    }
    write_assertions(&a, &rows);
    let mut peaks = Vec::new();
    for k in [8usize, 32, 128] {
        let (_aa, ww, oo) = fresh(&format!("gate1_k{}", k));
        let s = run(&a, &ww, &oo, k, 200, true).unwrap();
        peaks.push((k, s.max_partition_nodes));
    }
    // STRICT monotone decrease: K=8 > K=32 > K=128 resident peak.
    assert!(peaks[0].1 > peaks[1].1, "K8 peak {} must exceed K32 peak {}", peaks[0].1, peaks[1].1);
    assert!(peaks[1].1 > peaks[2].1, "K32 peak {} must exceed K128 peak {}", peaks[1].1, peaks[2].1);
    // and approximately N/K (within 2x tolerance for hash variance).
    let approx = (n as u32) / 128;
    assert!(peaks[2].1 <= approx * 3, "K128 peak {} ~ N/K {}", peaks[2].1, approx);
}

/// GATE 4 (memory-slope on a HIGH distinct-id fixture): peak resident scales with
/// N/K, not N. Doubling N at FIXED K ~doubles peak; that is the slope. A small
/// fixture is rejected — this uses thousands of distinct ids.
#[test]
fn gate4_peak_scales_with_n_over_k_not_n() {
    fn peak_for(n: usize, k: u32, tag: &str) -> u32 {
        let (a, w, o) = fresh(tag);
        // n distinct ids in n/2 disjoint pairs (singleton/pair shape, fast convergence).
        let ids: Vec<String> = (0..n).map(|i| format!("x-{:07}", i)).collect();
        let rows: Vec<(&str, &str, &str)> =
            (0..n).step_by(2).map(|i| (ids[i].as_str(), ids[i + 1].as_str(), "SAME_AS")).collect();
        write_assertions(&a, &rows);
        run(&a, &w, &o, k as usize, 200, true).unwrap().max_partition_nodes
    }
    let k = 64u32;
    let p_small = peak_for(2000, k, "slope_2k");
    let p_big = peak_for(8000, k, "slope_8k");
    // 4x the nodes at fixed K -> ~4x resident peak (N/K slope). Generous bounds
    // for hash variance: big must be clearly larger and roughly proportional.
    assert!(p_big > p_small * 2, "8k peak {} should be >2x 2k peak {} (N/K slope)", p_big, p_small);
    assert!(p_big < p_small * 8, "8k peak {} should stay < 8x of 2k peak {} (not super-linear)", p_big, p_small);
}

/// GATE 2 (max-pass cap): a long chain needs O(L) passes; a tight cap MUST
/// honest-FAIL with the MAX_PASSES marker, never silently truncate.
#[test]
fn gate2_max_pass_cap_honest_fails_on_long_chain() {
    let (a, w, o) = fresh("gate2");
    // Linear chain of 60 nodes (diameter ~60) but cap passes at 3 -> must fail.
    let ids: Vec<String> = (0..60).map(|i| format!("c-{:03}", i)).collect();
    let rows: Vec<(&str, &str, &str)> =
        (0..59).map(|i| (ids[i].as_str(), ids[i + 1].as_str(), "SAME_AS")).collect();
    write_assertions(&a, &rows);
    let err = run(&a, &w, &o, 16, 3, true).unwrap_err();
    assert!(err.contains("MAX_PASSES_EXCEEDED"), "expected honest cap failure, got: {}", err);
    // And the SAME chain converges (correctly) under an adequate cap.
    let (a2, w2, o2) = fresh("gate2_ok");
    write_assertions(&a2, &rows);
    let s = run(&a2, &w2, &o2, 16, 200, true).unwrap();
    assert!(s.converged);
    let asg = read_assignment(&o2);
    assert_eq!(asg.get("c-059"), Some(&"c-000".to_string()), "chain folds to min 'c-000'");
}

/// GATE 3 (partition-skew canary): a skewed fixture (one mega-hub) trips the
/// share cap -> the bake fails. We force skew with K=1 (all rows in one part).
#[test]
fn gate3_partition_skew_fails_the_bake() {
    let (a, w, o) = fresh("gate3");
    // 200 edges; K=1 routes 100% into one partition -> >60% cap, >=64 rows -> fail.
    let ids: Vec<String> = (0..200).map(|i| format!("s-{:04}", i)).collect();
    let rows: Vec<(&str, &str, &str)> =
        (0..200).map(|i| (ids[i].as_str(), ids[(i + 1) % 200].as_str(), "SAME_AS")).collect();
    write_assertions(&a, &rows);
    let err = run(&a, &w, &o, 1, 500, true).unwrap_err();
    assert!(err.contains("PARTITION_SKEW"), "expected skew canary failure, got: {}", err);
}

/// GATE 5 (real streaming reader): MANIFESTATION_OF rows are NOT edges (C.3),
/// and the assignment is byte-identical across re-runs (deterministic). Implicitly
/// exercises reader.rs (the only ingestion path; load_json_file is never called).
#[test]
fn gate5_manifestation_not_folded_and_deterministic() {
    let (a, w, o) = fresh("gate5");
    write_assertions(
        &a,
        &[
            ("m1", "m2", "SAME_AS"),
            ("m1", "paper-x", "MANIFESTATION_OF"), // must NOT join the cluster
        ],
    );
    let s = run(&a, &w, &o, 16, 50, true).unwrap();
    let asg = read_assignment(&o);
    assert_eq!(asg.get("m1"), Some(&"m1".to_string()));
    assert_eq!(asg.get("m2"), Some(&"m1".to_string()));
    assert!(asg.get("paper-x").is_none(), "MANIFESTATION_OF target must not be folded");
    assert_eq!(s.edges, 1, "only the SAME_AS row is an edge");

    // Determinism: re-run -> byte-identical assignment artifact.
    let (a2, w2, o2) = fresh("gate5_rerun");
    write_assertions(&a2, &[("m1", "m2", "SAME_AS"), ("m1", "paper-x", "MANIFESTATION_OF")]);
    run(&a2, &w2, &o2, 16, 50, true).unwrap();
    let f1 = std::fs::read(format!("{}/cluster-assignment.jsonl.zst", o)).unwrap();
    let f2 = std::fs::read(format!("{}/cluster-assignment.jsonl.zst", o2)).unwrap();
    assert_eq!(f1, f2, "re-bake of an unchanged edge set is byte-identical");
}

/// Two separate components stay separate (no spurious merge across partitions).
#[test]
fn disjoint_components_do_not_merge() {
    let (a, w, o) = fresh("disjoint");
    write_assertions(&a, &[("aa", "ab", "SAME_AS"), ("ya", "yb", "SAME_AS")]);
    run(&a, &w, &o, 16, 50, true).unwrap();
    let asg = read_assignment(&o);
    assert_eq!(asg.get("aa"), Some(&"aa".to_string()));
    assert_eq!(asg.get("ab"), Some(&"aa".to_string()));
    assert_eq!(asg.get("ya"), Some(&"ya".to_string()));
    assert_eq!(asg.get("yb"), Some(&"ya".to_string()));
}
