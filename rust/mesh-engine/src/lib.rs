//! V25.8 Mesh Engine — PageRank centrality scoring and adjacency listing.
//!
//! Hub Score = 0.35 * FNI + 0.25 * Citations + 0.25 * Mesh_Degree + 0.15 * Recency
//! Spec §2.2: Relation Weights synced with Ks coefficients.
//! Spec §2.3: MAX_RELATIONS_PER_NODE = 20, TF-IDF threshold > 0.4.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;
use std::collections::HashMap;

const DAMPING: f64 = 0.85;
const MAX_ITERATIONS: usize = 50;
const CONVERGENCE_THRESHOLD: f64 = 1e-6;
const MAX_RELATIONS_PER_NODE: usize = 20;
/// V5.8 §3: Hub degree limit — top weight only for high-degree nodes
const HUB_DEGREE_LIMIT: usize = 200;

// Relation weights (synced with Source Coefficients)
const WEIGHT_ARXIV: f64 = 30.0;
const WEIGHT_GH: f64 = 5.0;
const WEIGHT_HF: f64 = 1.0;
const WEIGHT_COLLECTION: f64 = 10.0;
const WEIGHT_DEFAULT: f64 = 1.0;

#[derive(Deserialize)]
struct EdgeInput {
    from: String,
    to: String,
    #[serde(default)]
    source_type: String,
}

#[napi(object)]
pub struct HubScoreResult {
    pub id: String,
    pub hub_score: f64,
    pub pagerank: f64,
    pub in_degree: u32,
    pub out_degree: u32,
    pub weighted_citations: f64,
}

/// Compute mesh gravity points for a node based on its inbound edges.
fn compute_mesh_points(in_edges: &[&EdgeInput]) -> f64 {
    let mut points = 0.0;
    for edge in in_edges.iter().take(MAX_RELATIONS_PER_NODE) {
        let w = match edge.source_type.as_str() {
            "arxiv" | "s2" => WEIGHT_ARXIV,
            "gh" => WEIGHT_GH,
            "hf" => WEIGHT_HF,
            "collection" => WEIGHT_COLLECTION,
            _ => WEIGHT_DEFAULT,
        };
        points += w;
    }
    points
}

/// Run PageRank on the edge graph.
/// Returns a map of node_id -> pagerank_score.
fn pagerank(
    nodes: &[String],
    adjacency: &HashMap<String, Vec<String>>,
) -> HashMap<String, f64> {
    let n = nodes.len() as f64;
    if n == 0.0 {
        return HashMap::new();
    }

    let init = 1.0 / n;
    let mut scores: HashMap<String, f64> = nodes.iter().map(|id| (id.clone(), init)).collect();
    let mut new_scores: HashMap<String, f64> = HashMap::with_capacity(nodes.len());

    // Reverse adjacency (who points to me)
    let mut in_links: HashMap<String, Vec<String>> = HashMap::new();
    for (from, tos) in adjacency {
        for to in tos {
            in_links.entry(to.clone()).or_default().push(from.clone());
        }
    }

    // Out-degree cache
    let out_degree: HashMap<String, usize> =
        adjacency.iter().map(|(k, v)| (k.clone(), v.len())).collect();

    for _ in 0..MAX_ITERATIONS {
        let mut max_diff: f64 = 0.0;

        for node in nodes {
            let mut rank = (1.0 - DAMPING) / n;

            if let Some(inbound) = in_links.get(node) {
                for source in inbound {
                    let source_rank = scores.get(source).copied().unwrap_or(init);
                    let source_out = *out_degree.get(source).unwrap_or(&1) as f64;
                    rank += DAMPING * (source_rank / source_out);
                }
            }

            let diff = (rank - scores.get(node).copied().unwrap_or(init)).abs();
            if diff > max_diff {
                max_diff = diff;
            }
            new_scores.insert(node.clone(), rank);
        }

        std::mem::swap(&mut scores, &mut new_scores);
        new_scores.clear();

        if max_diff < CONVERGENCE_THRESHOLD {
            break;
        }
    }

    scores
}

#[derive(Deserialize)]
struct NodeInput {
    id: String,
    #[serde(default)]
    fni_score: f64,
    #[serde(default)]
    days_since_update: f64,
}

/// V26.5: Compute hub scores by reading edges/nodes from files.
#[napi]
pub fn compute_hub_scores_from_files(
    edges_path: String,
    nodes_path: String,
) -> Result<Vec<HubScoreResult>> {
    let edges_data = nxvf_core::load_json_file(&edges_path)
        .map_err(|e| Error::from_reason(e))?;
    let nodes_data = nxvf_core::load_json_file(&nodes_path)
        .map_err(|e| Error::from_reason(e))?;
    let edges: Vec<EdgeInput> = serde_json::from_value(edges_data)
        .map_err(|e| Error::from_reason(format!("Edges parse error: {}", e)))?;
    let nodes: Vec<NodeInput> = serde_json::from_value(nodes_data)
        .map_err(|e| Error::from_reason(format!("Nodes parse error: {}", e)))?;
    eprintln!("[RUST-MESH] compute_hub_scores_from_files: {} edges, {} nodes", edges.len(), nodes.len());
    compute_hub_scores_inner(edges, nodes)
}

/// Compute hub scores for all nodes given an edge list (legacy Buffer API).
#[napi]
pub fn compute_hub_scores(
    edges_json: Buffer,
    nodes_json: Buffer,
) -> Result<Vec<HubScoreResult>> {
    let edges_raw = String::from_utf8_lossy(&edges_json);
    let edges_str = nxvf_core::sanitize_json_escapes(&edges_raw);
    let edges: Vec<EdgeInput> = serde_json::from_str(&edges_str)
        .map_err(|e| Error::from_reason(format!("Edges JSON error: {}", e)))?;

    let nodes_raw = String::from_utf8_lossy(&nodes_json);
    let nodes_str = nxvf_core::sanitize_json_escapes(&nodes_raw);
    let nodes: Vec<NodeInput> = serde_json::from_str(&nodes_str)
        .map_err(|e| Error::from_reason(format!("Nodes JSON error: {}", e)))?;

    compute_hub_scores_inner(edges, nodes)
}

fn compute_hub_scores_inner(edges: Vec<EdgeInput>, nodes: Vec<NodeInput>) -> Result<Vec<HubScoreResult>> {

    // Build adjacency and in-edge maps
    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
    let mut in_edges: HashMap<String, Vec<usize>> = HashMap::new();
    let mut in_degree: HashMap<String, u32> = HashMap::new();
    let mut out_degree: HashMap<String, u32> = HashMap::new();

    for (i, edge) in edges.iter().enumerate() {
        let adj = adjacency.entry(edge.from.clone()).or_default();
        // V5.8 §3: Hub Degree Limit — skip edges beyond HUB_DEGREE_LIMIT for high-degree nodes
        if adj.len() < HUB_DEGREE_LIMIT {
            adj.push(edge.to.clone());
        }
        let ie = in_edges.entry(edge.to.clone()).or_default();
        if ie.len() < HUB_DEGREE_LIMIT {
            ie.push(i);
        }
        *in_degree.entry(edge.to.clone()).or_default() += 1;
        *out_degree.entry(edge.from.clone()).or_default() += 1;
    }

    // PageRank
    let node_ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    let pr_scores = pagerank(&node_ids, &adjacency);

    // Build node lookup
    let _node_map: HashMap<&str, &NodeInput> =
        nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    // Compute hub scores
    let mut results = Vec::with_capacity(nodes.len());

    for node in &nodes {
        let fni = f64::min(99.9, f64::max(0.0, node.fni_score));

        // Citations (weighted by source type)
        let node_in_edges: Vec<&EdgeInput> = in_edges
            .get(&node.id)
            .map(|indices| indices.iter().map(|&i| &edges[i]).collect())
            .unwrap_or_default();
        let weighted_cit = compute_mesh_points(&node_in_edges);
        let citations_norm = f64::min(100.0, (weighted_cit.ln_1p() / 3.0_f64.ln_1p()) * 100.0);

        // Mesh degree
        let deg = in_degree.get(&node.id).copied().unwrap_or(0)
            + out_degree.get(&node.id).copied().unwrap_or(0);
        let mesh_norm = f64::min(100.0, (deg as f64 / 20.0) * 100.0);

        // Recency
        let recency = if node.days_since_update >= 0.0 {
            f64::min(100.0, 100.0 * f64::exp(-0.015 * node.days_since_update))
        } else {
            50.0
        };

        let hub = (0.35 * fni) + (0.25 * citations_norm) + (0.25 * mesh_norm) + (0.15 * recency);
        let pr = pr_scores.get(&node.id).copied().unwrap_or(0.0);

        results.push(HubScoreResult {
            id: node.id.clone(),
            hub_score: (hub * 10.0).round() / 10.0,
            pagerank: (pr * 1e6).round() / 1e6,
            in_degree: in_degree.get(&node.id).copied().unwrap_or(0),
            out_degree: out_degree.get(&node.id).copied().unwrap_or(0),
            weighted_citations: weighted_cit,
        });
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pagerank_basic() {
        let nodes = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        let mut adj = HashMap::new();
        adj.insert("A".to_string(), vec!["B".to_string()]);
        adj.insert("B".to_string(), vec!["C".to_string()]);
        adj.insert("C".to_string(), vec!["A".to_string()]);

        let scores = pagerank(&nodes, &adj);
        // Symmetric cycle => roughly equal PageRank
        let a = scores["A"];
        let b = scores["B"];
        assert!((a - b).abs() < 0.01);
    }

    #[test]
    fn test_mesh_points_arxiv() {
        let edge = EdgeInput {
            from: "arxiv-paper--x".to_string(),
            to: "model-y".to_string(),
            source_type: "arxiv".to_string(),
        };
        let points = compute_mesh_points(&[&edge]);
        assert_eq!(points, 30.0);
    }
}
