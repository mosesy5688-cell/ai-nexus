//! PR-C2 — L3 streaming connected-components (identity clusters).
//!
//! Design: IDENTITY_LAYER_DESIGN_v3 §E [D4] = Option B (hash-partition label-
//! propagation, disk message-passing). Consumes PR-C1 SAME_AS assertions
//! (relation == "SAME_AS" edges); MANIFESTATION_OF can NEVER fold (C.3).
//! cluster_id = lexicographic min(canonical_id) over the connected component.
//! Full recompute every 4/4 bake (D2 makes churn cheap). PRODUCER/bake-side only
//! — NO serve, NO identity-graph.bin sharding (PR-C3), NO /identity route.
//!
//! Six acceptance gates, enforced as structural checks (not prose):
//!  1. NO global id-map: partition by hash(canonical_id) directly; one partition's
//!     labels resident (O(N/K)). `max_partition_nodes` falls as K rises — the
//!     K-variation regression (peakNodes_K^ < peakNodes_Kv). A global map would be
//!     K-INVARIANT and fail it (the D4-rollback trigger).
//!  2. max-pass cap: labelprop honest-fails past MAX_PASSES (partial marker), never
//!     silent truncation.
//!  3. partition-skew canary: one partition over share-cap -> fail the bake.
//!  4. memory-slope: peak resident = max_partition_nodes ~ N/K; asserted on a
//!     HIGH distinct-id fixture at two K points.
//!  5. real streaming reader: reader.rs mirrors for_each_raw_entity (no
//!     load_json_file / whole-corpus Vec/HashMap).
//!  6. scope: independent crate; zero serve/shard/endpoint touches; CES <=250/file.

// Explicit napi imports (NOT the glob prelude) so plain `Result<T, String>` in
// this file's internal helpers stays `std::result::Result`, not `napi::Result`.
use napi::Error as NapiError;
use napi_derive::napi;
use std::collections::HashMap;

mod canary;
mod diskio;
mod labelprop;
mod partition;
mod reader;

use partition::{partition_of, EdgeSpill};
use reader::{discover_assertion_shards, for_each_same_as_edge};

/// Bake summary surfaced to JS (NAPI camelCase). A non-empty `error` (or a
/// thrown Result::Err) means the bake MUST fail — never emit partial clusters.
#[napi(object)]
#[derive(Debug)]
pub struct ClusterSummary {
    pub edges: u32,
    pub nodes: u32,
    pub clusters: u32,
    pub non_singleton_clusters: u32,
    pub passes: u32,
    pub converged: bool,
    pub max_partition_nodes: u32,
    pub max_partition_edge_rows: u32,
    pub assignment_rows: u32,
}

/// Build identity clusters from PR-C1 assertion shards.
///
/// `assertion_dir`: dir of `assertions-NN.jsonl.zst` (PR-C1 output).
/// `work_dir`:      scratch dir for on-disk partition/label/message spill.
/// `output_dir`:    where the cluster-assignment artifact is written.
/// `k`:             partition count (D5 router uses 96 for identity-graph.bin;
///                  the CC partitioning K is independent — pass the bake's K).
/// `max_passes`:    label-prop safety cap (gate 2). Exceeding -> honest fail.
#[napi]
pub fn build_identity_clusters(
    assertion_dir: String,
    work_dir: String,
    output_dir: String,
    k: u32,
    max_passes: u32,
) -> napi::Result<ClusterSummary> {
    let k = (k as usize).max(1);
    run(&assertion_dir, &work_dir, &output_dir, k, max_passes as usize, true)
        .map_err(NapiError::from_reason)
}

/// Core (testable; `expect_non_singletons` lets fixtures assert the floor canary).
fn run(
    assertion_dir: &str,
    work_dir: &str,
    output_dir: &str,
    k: usize,
    max_passes: usize,
    expect_non_singletons: bool,
) -> Result<ClusterSummary, String> {
    std::fs::create_dir_all(work_dir).map_err(|e| format!("mkdir work {}: {}", work_dir, e))?;
    std::fs::create_dir_all(output_dir).map_err(|e| format!("mkdir out {}: {}", output_dir, e))?;

    // (1) Stream SAME_AS edges (gate 5 reader) -> hash-partition spill (gate 1).
    let mut spill = EdgeSpill::new(work_dir, k)?;
    let mut edges = 0u64;
    for shard in discover_assertion_shards(assertion_dir)? {
        for_each_same_as_edge(&shard, |e| {
            spill.add_edge(&e.a, &e.b)?;
            edges += 1;
            Ok(())
        })?;
    }
    let (edge_counts, edge_paths) = spill.finish()?;

    // (3) Partition-skew canary BEFORE the heavy pass.
    canary::check_partition_skew(&edge_counts, 0.60, 64)?;

    // Per-partition distinct node counts (gate 4 slope basis; no global map).
    let node_counts = count_partition_nodes(&edge_paths, k)?;
    let max_part_nodes = canary::max_partition_nodes(&node_counts);
    let total_nodes: u64 = node_counts.iter().sum();

    // (2) Label-propagation with max-pass cap.
    let result = labelprop::propagate(work_dir, &edge_paths, k, max_passes)?;

    // Summarise + emit assignment (canonical_id -> cluster_id).
    let (clusters, non_singletons) = cluster_stats(&result.assignment);
    canary::check_non_singleton_floor(non_singletons, expect_non_singletons)?;
    let rows = write_assignment(output_dir, &result.assignment)?;

    Ok(ClusterSummary {
        edges: edges as u32,
        nodes: total_nodes as u32,
        clusters: clusters as u32,
        non_singleton_clusters: non_singletons as u32,
        passes: result.passes as u32,
        converged: result.converged,
        max_partition_nodes: max_part_nodes as u32,
        max_partition_edge_rows: edge_counts.iter().copied().max().unwrap_or(0) as u32,
        assignment_rows: rows as u32,
    })
}

/// Distinct local-node count per partition (each node lives in part(node), so the
/// `local` column of its spill file enumerates exactly that partition's nodes).
fn count_partition_nodes(edge_paths: &[String], k: usize) -> Result<Vec<u64>, String> {
    let mut out = vec![0u64; k];
    for (p, path) in edge_paths.iter().enumerate() {
        let mut seen = std::collections::HashSet::new();
        for (local, _nb) in partition::read_partition_edges(path)? {
            debug_assert_eq!(partition_of(&local, k), p);
            seen.insert(local);
        }
        out[p] = seen.len() as u64;
    }
    Ok(out)
}

/// (clusters, non_singleton_clusters) from the assignment. cluster_id is the
/// component's lexicographic-min id; count distinct cluster_ids and how many have
/// >= 2 members among the edge-bearing nodes.
fn cluster_stats(assignment: &HashMap<String, String>) -> (u64, u64) {
    let mut sizes: HashMap<&str, u64> = HashMap::new();
    for cid in assignment.values() {
        *sizes.entry(cid.as_str()).or_insert(0) += 1;
    }
    let clusters = sizes.len() as u64;
    let non_singletons = sizes.values().filter(|&&n| n >= 2).count() as u64;
    (clusters, non_singletons)
}

/// Write the cluster-assignment artifact: JSONL.zst of {canonical_id, cluster_id}
/// for every edge-bearing node. Singletons (no SAME_AS edge) are implicit: a node
/// absent here is its own cluster. PR-C3 consumes this to build identity-graph.bin
/// (sharding is OUT of PR-C2 scope). Streaming writer — no whole-corpus heap blob.
fn write_assignment(output_dir: &str, assignment: &HashMap<String, String>) -> Result<u64, String> {
    let mut buf = String::new();
    let mut rows = 0u64;
    let mut keys: Vec<&String> = assignment.keys().collect();
    keys.sort(); // deterministic byte-identical output for an unchanged edge set
    for node in keys {
        let cid = &assignment[node];
        buf.push_str(&format!(
            "{{\"canonical_id\":{},\"cluster_id\":{}}}\n",
            serde_json::to_string(node).map_err(|e| e.to_string())?,
            serde_json::to_string(cid).map_err(|e| e.to_string())?
        ));
        rows += 1;
    }
    let comp = zstd::encode_all(buf.as_bytes(), 3).map_err(|e| format!("zstd: {}", e))?;
    let path = format!("{}/cluster-assignment.jsonl.zst", output_dir);
    std::fs::write(&path, comp).map_err(|e| format!("write {}: {}", path, e))?;
    Ok(rows)
}

#[cfg(test)]
mod tests;
