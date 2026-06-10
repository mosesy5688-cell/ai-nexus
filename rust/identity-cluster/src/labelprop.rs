//! Disk message-passing label-propagation (Option B core).
//!
//! GraphChi/PSW gather-apply-scatter, ONE partition resident at a time:
//!   - label store: per-partition `labels-PP` = map node_id -> current_label
//!     (the running lexicographic-min canonical_id). O(N/K) resident — the ONLY
//!     materialised state. NO global node map (gate 1).
//!   - edges: per-partition spill (partition.rs); each local edge carries the
//!     neighbor id, so a resident partition sees all incident edges locally.
//!   - messages: per-partition on-disk inbox of `(target_node, proposed_label)`.
//!     A node's label is min-folded from inbound messages; the NEW label is
//!     scattered to neighbors' partitions. Messages live on disk between passes.
//!
//! A pass = for each partition: load its labels, fold inbound messages (min),
//! scatter min(self, neighbor-seen) along edges. Repeat until a full sweep makes
//! NO change (converged) or MAX_PASSES is hit.
//!
//! GATE 2 (max-pass cap): a pathological long chain is O(L) passes. We hard-cap;
//! exceeding it is an HONEST FAIL with a partial-artifact marker — NEVER a silent
//! truncated/half-propagated cluster set.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};

use crate::diskio::{open_append, read_labels, read_messages, write_labels, write_msg};
use crate::partition::{partition_of, read_partition_edges};

/// Outcome of the label-propagation run.
pub struct PropResult {
    /// canonical_id -> cluster_id (= lexicographic min of its component). Built by
    /// streaming the final per-partition label stores; this map is the ARTIFACT,
    /// not resident working state during propagation.
    pub assignment: HashMap<String, String>,
    pub passes: usize,
    pub converged: bool,
}

/// Run label-propagation over K hash-partitions of edges in `work_dir`.
/// `edge_paths` are the per-partition spill files (partition.rs). Resident memory
/// is bounded by the LARGEST single partition's label map (O(N/K)).
pub fn propagate(
    work_dir: &str,
    edge_paths: &[String],
    k: usize,
    max_passes: usize,
) -> Result<PropResult, String> {
    // Seed labels: every node's label = its own id (lexicographic-min identity).
    // Persisted per-partition so the full id set is never resident at once.
    seed_labels(work_dir, edge_paths, k)?;

    let mut passes = 0usize;
    let mut converged = false;
    while passes < max_passes {
        // A pass emits messages ONLY for nodes whose label moved this pass (all
        // nodes on the seeding pass 0). When a pass emits NOTHING, the frontier is
        // empty and the graph has converged — no further label can change.
        let emitted = run_pass(work_dir, edge_paths, k, passes)?;
        passes += 1;
        if emitted == 0 {
            converged = true;
            break;
        }
    }
    if !converged {
        return Err(format!(
            "MAX_PASSES_EXCEEDED: label-propagation did not converge within {} passes \
             (pathological high-diameter chain). Honest fail — partial cluster artifact \
             would be untrustworthy; the bake must mark this partial, never silently \
             truncate.",
            max_passes
        ));
    }
    let assignment = collect_assignment(work_dir, k)?;
    Ok(PropResult { assignment, passes, converged })
}

/// Seed each partition's label store: node_id -> node_id. Streams edges once to
/// discover the node set per partition (a node belongs to part(node)).
fn seed_labels(work_dir: &str, edge_paths: &[String], _k: usize) -> Result<(), String> {
    for (p, edge_path) in edge_paths.iter().enumerate() {
        // Distinct local nodes of this partition; label seeded to the node's own
        // id (lexicographic-min identity). Resident set is O(N/K), one partition.
        let mut nodes: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (local, _nb) in read_partition_edges(edge_path)? {
            nodes.insert(local);
        }
        let seeded: HashMap<String, String> = nodes.into_iter().map(|n| (n.clone(), n)).collect();
        write_labels(&labels_path(work_dir, p), &seeded)?;
    }
    Ok(())
}

/// One full sweep. For each partition: fold inbound messages (min), then scatter
/// the labels of nodes whose value MOVED this pass (the active frontier) along
/// local edges to neighbor partitions' next inbox. On pass 0 the inboxes are
/// empty, so the WHOLE node set is the seed frontier (every node announces its own
/// id once). Returns the number of messages emitted this sweep; ZERO => converged
/// (empty frontier => no label can change again).
fn run_pass(work_dir: &str, edge_paths: &[String], k: usize, pass: usize) -> Result<usize, String> {
    let mut emitted = 0usize;
    // Fresh outbox set for next pass (idempotent across re-runs).
    for p in 0..k {
        let _ = std::fs::remove_file(outbox_path(work_dir, p, pass + 1));
    }
    for (p, edge_path) in edge_paths.iter().enumerate() {
        let mut labels = read_labels(&labels_path(work_dir, p))?;
        // Gather + apply: fold inbound messages; `moved` = nodes that lowered.
        let moved = fold_inbox(&inbox_path(work_dir, p, pass), &mut labels)?;
        // Scatter ONLY the active frontier (pass 0: all nodes seed once).
        let frontier: Option<&std::collections::HashSet<String>> =
            if pass == 0 { None } else { Some(&moved) };
        emitted += scatter(work_dir, edge_path, &labels, frontier, k, pass + 1)?;
        write_labels(&labels_path(work_dir, p), &labels)?;
    }
    Ok(emitted)
}

/// Min-fold inbound messages into the resident label map. Returns the SET of nodes
/// whose label was lowered (the next-pass scatter frontier for this partition).
fn fold_inbox(
    path: &str,
    labels: &mut HashMap<String, String>,
) -> Result<std::collections::HashSet<String>, String> {
    let mut moved = std::collections::HashSet::new();
    for (target, proposed) in read_messages(path)? {
        if let Some(cur) = labels.get_mut(&target) {
            if proposed < *cur {
                *cur = proposed;
                moved.insert(target);
            }
        }
    }
    Ok(moved)
}

/// Scatter labels to neighbor partition inboxes. `frontier == None` => scatter
/// every local node (pass-0 seeding); `Some(set)` => scatter only nodes that
/// moved this pass. Returns the count of messages written.
fn scatter(
    work_dir: &str,
    edge_path: &str,
    labels: &HashMap<String, String>,
    frontier: Option<&std::collections::HashSet<String>>,
    k: usize,
    next_pass: usize,
) -> Result<usize, String> {
    let mut outs: Vec<Option<BufWriter<File>>> = (0..k).map(|_| None).collect();
    let mut emitted = 0usize;
    for (local, neighbor) in read_partition_edges(edge_path)? {
        if let Some(f) = frontier {
            if !f.contains(&local) {
                continue; // not on the active frontier — nothing new to announce
            }
        }
        let my_label = match labels.get(&local) {
            Some(l) => l,
            None => continue,
        };
        let np = partition_of(&neighbor, k);
        if outs[np].is_none() {
            let f = open_append(&outbox_path(work_dir, np, next_pass))?;
            outs[np] = Some(BufWriter::new(f));
        }
        let w = outs[np].as_mut().unwrap();
        write_msg(w, &neighbor, my_label)?;
        emitted += 1;
    }
    for w in outs.iter_mut().flatten() {
        w.flush().map_err(|e| format!("scatter flush: {}", e))?;
    }
    Ok(emitted)
}

/// Stream all final per-partition label stores into the assignment artifact.
fn collect_assignment(work_dir: &str, k: usize) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    for p in 0..k {
        for (node, label) in read_labels(&labels_path(work_dir, p))? {
            out.insert(node, label);
        }
    }
    Ok(out)
}

// ── path helpers ────────────────────────────────────────────────────────────
fn labels_path(d: &str, p: usize) -> String { format!("{}/labels-{:04}.bin", d, p) }
fn inbox_path(d: &str, p: usize, pass: usize) -> String { outbox_path(d, p, pass) }
fn outbox_path(d: &str, p: usize, pass: usize) -> String {
    format!("{}/msgs-p{:04}-pass{:03}.bin", d, p, pass)
}

// On-disk label/message codecs live in crate::diskio (CES 250 split, gate 6).
