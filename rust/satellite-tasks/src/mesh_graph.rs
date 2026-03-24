//! Mesh Graph Builder
//! Builds unified mesh graph from relations + knowledge links + reports.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[napi(object)]
pub struct MeshGraphResult {
    pub graph_data: Buffer,
    pub stats_data: Buffer,
    pub node_count: u32,
    pub edge_count: u32,
}

fn get_node_type(id: &str) -> &str {
    if id.starts_with("hf-model--") { return "model"; }
    if id.starts_with("hf-dataset--") { return "dataset"; }
    if id.starts_with("hf-space--") { return "space"; }
    if id.starts_with("arxiv-paper--") || id.starts_with("s2-paper--") { return "paper"; }
    if id.starts_with("gh-tool--") || id.starts_with("gh-repo--") { return "tool"; }
    if id.starts_with("civitai-model--") { return "model"; }
    if id.starts_with("replicate-model--") { return "model"; }
    if id.starts_with("knowledge--") || id.starts_with("k--") { return "knowledge"; }
    if id.starts_with("report--") { return "report"; }
    "unknown"
}

fn zstd_bytes(data: &[u8]) -> Result<Vec<u8>> {
    zstd::encode_all(data, 3)
        .map_err(|e| Error::from_reason(format!("Zstd compress error: {}", e)))
}

/// V26.5: Build mesh graph by reading input files directly from disk.
#[napi]
pub fn build_mesh_graph_from_files(
    explicit_path: String,
    knowledge_links_path: String,
    reports_path: String,
    output_dir: String,
) -> Result<MeshGraphResult> {
    let explicit_val = nxvf_core::load_json_file(&explicit_path).ok();
    let kl_val = nxvf_core::load_json_file(&knowledge_links_path).ok();
    let rep_val = nxvf_core::load_json_file(&reports_path).ok();

    eprintln!("[RUST-SAT] build_mesh_graph_from_files: explicit={}, knowledge={}, reports={}",
        explicit_val.is_some(), kl_val.is_some(), rep_val.is_some());

    build_mesh_graph_inner(
        explicit_val.as_ref(),
        kl_val.as_ref(),
        rep_val.as_ref(),
        Some(&output_dir),
    )
}

/// Build unified mesh graph from relations + knowledge links (legacy Buffer API).
#[napi]
pub fn build_mesh_graph(
    explicit_json: Buffer,
    knowledge_links_json: Buffer,
    reports_json: Buffer,
) -> Result<MeshGraphResult> {
    let explicit_val = if !explicit_json.is_empty() {
        let raw = String::from_utf8_lossy(&explicit_json);
        let sanitized = nxvf_core::sanitize_json_escapes(&raw);
        serde_json::from_str(&sanitized).ok()
    } else { None };

    let kl_val = if !knowledge_links_json.is_empty() {
        let raw = String::from_utf8_lossy(&knowledge_links_json);
        let sanitized = nxvf_core::sanitize_json_escapes(&raw);
        serde_json::from_str(&sanitized).ok()
    } else { None };

    let rep_val = if !reports_json.is_empty() {
        let raw = String::from_utf8_lossy(&reports_json);
        let sanitized = nxvf_core::sanitize_json_escapes(&raw);
        serde_json::from_str(&sanitized).ok()
    } else { None };

    build_mesh_graph_inner(
        explicit_val.as_ref(),
        kl_val.as_ref(),
        rep_val.as_ref(),
        None,
    )
}

fn build_mesh_graph_inner(
    explicit_val: Option<&Value>,
    kl_val: Option<&Value>,
    rep_val: Option<&Value>,
    _output_dir: Option<&str>,
) -> Result<MeshGraphResult> {
    let mut nodes: HashMap<String, Value> = HashMap::new();
    let mut edges: HashMap<String, Vec<Value>> = HashMap::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();
    let mut edge_type_counts: HashMap<String, u32> = HashMap::new();
    let mut node_type_counts: HashMap<String, u32> = HashMap::new();

    // 1. Parse explicit relations
    if let Some(explicit) = explicit_val {

        // Import nodes
        if let Some(n) = explicit.get("nodes").and_then(|v| v.as_object()) {
            for (id, info) in n {
                nodes.insert(id.clone(), info.clone());
            }
        }

        // Import edges
        if let Some(e) = explicit.get("edges").and_then(|v| v.as_object()) {
            for (source_id, targets) in e {
                if let Some(arr) = targets.as_array() {
                    for edge in arr {
                        if let Some(target) = edge.get(0).and_then(|v| v.as_str()) {
                            let key = (source_id.clone(), target.to_string());
                            if seen_edges.insert(key) {
                                let etype = edge.get(1)
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("RELATED");
                                *edge_type_counts.entry(etype.to_string()).or_insert(0) += 1;
                                edges.entry(source_id.clone())
                                    .or_default()
                                    .push(edge.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Parse knowledge links -> add EXPLAINS edges
    if let Some(kl) = kl_val {
        if let Some(links) = kl.get("links").and_then(|v| v.as_array()) {
            for link in links {
                let entity_id = link.get("entity_id").and_then(|v| v.as_str()).unwrap_or("");
                if entity_id.is_empty() { continue; }
                if let Some(knowledge) = link.get("knowledge").and_then(|v| v.as_array()) {
                    for k in knowledge {
                        let slug = k.get("slug").and_then(|v| v.as_str()).unwrap_or("");
                        let conf = k.get("confidence").and_then(|v| v.as_i64()).unwrap_or(50);
                        if slug.is_empty() { continue; }

                        let k_id = format!("knowledge--{}", slug);
                        let key = (k_id.clone(), entity_id.to_string());
                        if seen_edges.insert(key) {
                            // Ensure knowledge node exists
                            nodes.entry(k_id.clone()).or_insert_with(|| {
                                serde_json::json!({ "t": "knowledge", "f": 0.0 })
                            });
                            // Ensure entity node exists
                            nodes.entry(entity_id.to_string()).or_insert_with(|| {
                                serde_json::json!({
                                    "t": get_node_type(entity_id),
                                    "f": 0.0,
                                })
                            });

                            let edge = serde_json::json!([entity_id, "EXPLAINS", conf]);
                            edges.entry(k_id).or_default().push(edge);
                            *edge_type_counts.entry("EXPLAINS".to_string()).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }

    // 3. Parse reports -> add FEATURED_IN edges
    if let Some(reports) = rep_val {
        if let Some(items) = reports.as_array() {
            for report in items {
                let report_id = report.get("id").and_then(|v| v.as_str())
                    .or_else(|| report.get("slug").and_then(|v| v.as_str()));
                let report_id = match report_id {
                    Some(id) => format!("report--{}", id),
                    None => continue,
                };
                nodes.entry(report_id.clone()).or_insert_with(|| {
                    serde_json::json!({ "t": "report", "f": 0.0 })
                });
                if let Some(featured) = report.get("entities").and_then(|v| v.as_array()) {
                    for eid in featured {
                        let eid = match eid.as_str() { Some(s) => s, None => continue };
                        let key = (eid.to_string(), report_id.clone());
                        if seen_edges.insert(key) {
                            nodes.entry(eid.to_string()).or_insert_with(|| {
                                serde_json::json!({
                                    "t": get_node_type(eid),
                                    "f": 0.0,
                                })
                            });
                            let edge = serde_json::json!([report_id, "FEATURED_IN", 80]);
                            edges.entry(eid.to_string()).or_default().push(edge);
                            *edge_type_counts.entry("FEATURED_IN".to_string())
                                .or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }

    // 4. Calculate stats
    for (id, _) in &nodes {
        let ntype = get_node_type(id);
        *node_type_counts.entry(ntype.to_string()).or_insert(0) += 1;
    }

    let total_edges: u32 = edge_type_counts.values().sum();
    let node_count = nodes.len() as u32;

    let graph = serde_json::json!({
        "_v": "25.8.3",
        "nodes": nodes,
        "edges": edges,
    });
    let stats = serde_json::json!({
        "node_count": node_count,
        "edge_count": total_edges,
        "by_type": node_type_counts,
        "by_edge_type": edge_type_counts,
    });

    let graph_bytes = serde_json::to_vec(&graph)
        .map_err(|e| Error::from_reason(format!("Serialize error: {}", e)))?;
    let stats_bytes = serde_json::to_vec(&stats)
        .map_err(|e| Error::from_reason(format!("Serialize error: {}", e)))?;

    Ok(MeshGraphResult {
        graph_data: zstd_bytes(&graph_bytes)?.into(),
        stats_data: zstd_bytes(&stats_bytes)?.into(),
        node_count,
        edge_count: total_edges,
    })
}
