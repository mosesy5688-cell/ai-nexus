//! Relations Graph Builder
//! Builds V14.5.2 adjacency format from pre-extracted nodes and relations.

use flate2::write::GzEncoder;
use flate2::Compression;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;

#[napi(object)]
pub struct RelationsResult {
    pub explicit_json: Buffer,
    pub legacy_json: Buffer,
    pub total_relations: u32,
}

#[derive(Deserialize)]
struct NodeInfo {
    t: String,
    f: f64,
}

#[derive(Deserialize)]
struct RawRelation {
    source_id: String,
    source_type: String,
    target_id: String,
    target_type: String,
    relation_type: String,
    confidence: f64,
}

fn gzip_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data)
        .map_err(|e| Error::from_reason(format!("Gzip write error: {}", e)))?;
    encoder.finish()
        .map_err(|e| Error::from_reason(format!("Gzip finish error: {}", e)))
}

/// Build relations graph from pre-extracted nodes and relations.
/// JS handles extractEntityRelations(); Rust builds the graph + gzip.
#[napi]
pub fn build_relations_graph(
    nodes_json: Buffer,
    relations_json: Buffer,
) -> Result<RelationsResult> {
    let nodes_str = std::str::from_utf8(&nodes_json)
        .map_err(|e| Error::from_reason(format!("Invalid UTF-8 nodes: {}", e)))?;
    let rels_str = std::str::from_utf8(&relations_json)
        .map_err(|e| Error::from_reason(format!("Invalid UTF-8 relations: {}", e)))?;

    let nodes: HashMap<String, NodeInfo> = serde_json::from_str(nodes_str)
        .map_err(|e| Error::from_reason(format!("Nodes JSON parse error: {}", e)))?;
    let relations: Vec<RawRelation> = serde_json::from_str(rels_str)
        .map_err(|e| Error::from_reason(format!("Relations JSON parse error: {}", e)))?;

    // Build V14.5.2 explicit adjacency format
    // nodes: { id: { t, f } }
    // edges: { source_id: [ [target_id, relation_type, confidence_pct], ... ] }
    let mut edges: HashMap<String, Vec<Value>> = HashMap::new();
    let mut reverse: HashMap<String, Vec<Value>> = HashMap::new();
    let mut total_relations: u32 = 0;

    // Ensure all node IDs referenced in relations exist in nodes map
    let mut all_nodes: HashMap<String, Value> = HashMap::new();
    for (id, info) in &nodes {
        all_nodes.insert(id.clone(), serde_json::json!({
            "t": info.t,
            "f": (info.f * 10.0).round() / 10.0,
        }));
    }

    for rel in &relations {
        // Ensure source and target nodes exist
        if !all_nodes.contains_key(&rel.source_id) {
            all_nodes.insert(rel.source_id.clone(), serde_json::json!({
                "t": rel.source_type,
                "f": 0.0,
            }));
        }
        if !all_nodes.contains_key(&rel.target_id) {
            all_nodes.insert(rel.target_id.clone(), serde_json::json!({
                "t": rel.target_type,
                "f": 0.0,
            }));
        }

        let confidence_pct = (rel.confidence * 100.0).round() as i64;
        let edge = serde_json::json!([
            rel.target_id,
            rel.relation_type,
            confidence_pct
        ]);

        edges.entry(rel.source_id.clone())
            .or_default()
            .push(edge);

        // Build reverse lookup
        let rev_edge = serde_json::json!([
            rel.source_id,
            rel.relation_type,
            confidence_pct
        ]);
        reverse.entry(rel.target_id.clone())
            .or_default()
            .push(rev_edge);

        total_relations += 1;
    }

    // V14.5.2 explicit format
    let explicit = serde_json::json!({
        "_v": "14.5.2",
        "_ts": chrono_now(),
        "nodes": all_nodes,
        "edges": edges,
        "reverse": reverse,
        "_stats": {
            "nodeCount": all_nodes.len(),
            "edgeCount": total_relations,
        }
    });

    // Legacy format: flat array of relations
    let legacy_rels: Vec<Value> = relations.iter().map(|r| {
        serde_json::json!({
            "source": r.source_id,
            "target": r.target_id,
            "type": r.relation_type,
            "confidence": (r.confidence * 100.0).round() as i64,
        })
    }).collect();

    let legacy = serde_json::json!({
        "_v": "legacy",
        "relations": legacy_rels,
        "count": total_relations,
    });

    let explicit_bytes = serde_json::to_vec(&explicit)
        .map_err(|e| Error::from_reason(format!("Serialize error: {}", e)))?;
    let legacy_bytes = serde_json::to_vec(&legacy)
        .map_err(|e| Error::from_reason(format!("Serialize error: {}", e)))?;

    Ok(RelationsResult {
        explicit_json: gzip_bytes(&explicit_bytes)?.into(),
        legacy_json: gzip_bytes(&legacy_bytes)?.into(),
        total_relations,
    })
}

/// Simple ISO-like timestamp (no chrono dependency).
fn chrono_now() -> String {
    "auto".to_string()
}
