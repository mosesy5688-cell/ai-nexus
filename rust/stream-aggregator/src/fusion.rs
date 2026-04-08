//! V26.5 Shard Fusion — Rust-native per-shard processing for master-fusion.
//!
//! Reads a shard file, applies closed-world relation filter, late-binding FNI,
//! optional enrichment injection, projects entities, and writes zstd output.

use std::collections::HashSet;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::json;

use crate::project::project_entity_for_fusion;

#[napi(object)]
pub struct FuseShardResult {
    pub entity_count: u32,
    pub filtered_relations: u32,
    pub enriched_count: u32,
}

/// Fuse a single shard: read → closed-world filter → FNI → enrich → project → write.
/// enrichment_dir may be empty to skip enrichment.
#[napi]
pub fn fuse_shard(
    shard_path: String,
    valid_ids_path: String,
    fni_thresholds_path: String,
    enrichment_dir: String,
    output_path: String,
) -> Result<FuseShardResult> {
    // 1. Load valid IDs
    let ids_val = nxvf_core::load_json_file(&valid_ids_path)
        .map_err(|e| Error::from_reason(format!("load valid_ids: {e}")))?;
    let valid_ids: HashSet<String> = ids_val
        .as_array()
        .ok_or_else(|| Error::from_reason("valid_ids must be JSON array"))?
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();

    // 2. Load FNI thresholds
    let thresholds = nxvf_core::load_json_file(&fni_thresholds_path)
        .unwrap_or_else(|_| json!({}));
    let score_pcts = thresholds
        .get("scorePercentiles")
        .and_then(|v| v.as_object());

    // 3. Read shard
    let entities = nxvf_core::load_shard_entities(&shard_path)
        .map_err(|e| Error::from_reason(format!("read shard: {e}")))?;

    let mut fused = Vec::with_capacity(entities.len());
    let mut filtered_rels = 0u32;
    let mut enriched = 0u32;
    let do_enrich = !enrichment_dir.is_empty();

    for mut entity in entities {
        let id = entity
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }

        // A. Closed-world relation filter
        if let Some(rels) = entity
            .get_mut("relations")
            .and_then(|v| v.as_array_mut())
        {
            let before = rels.len();
            rels.retain(|r| {
                r.get("target_id")
                    .and_then(|v| v.as_str())
                    .map(|tid| valid_ids.contains(tid))
                    .unwrap_or(false)
            });
            filtered_rels += (before - rels.len()) as u32;
        }

        // B. FNI V2.0: Preserve 2/4 computed score — no recalculation in fusion
        let fni_score = entity
            .get("fni_score")
            .and_then(|v| v.as_f64())
            .or_else(|| entity.get("fni").and_then(|v| v.as_f64()))
            .unwrap_or(0.0);
        let pct_key = (fni_score.round() as i64).to_string();
        let percentile = score_pcts
            .and_then(|m| m.get(&pct_key))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        entity["fni_pScore"] = json!(fni_score);
        entity["fni_percentile"] = json!(percentile);

        // C. Enrichment from pre-downloaded local files
        if do_enrich {
            let umid = entity.get("umid").and_then(|v| v.as_str()).unwrap_or("");
            if !umid.is_empty() {
                if let Some(text) = try_load_enrichment(&enrichment_dir, umid) {
                    if text.len() > 200 {
                        let has_ft = text.len() > 1000;
                        entity["body_content"] = json!(text);
                        entity["has_fulltext"] = json!(has_ft);
                        enriched += 1;
                    }
                }
            }
        }

        // D. Project (full mode — preserves body_content, has_fulltext, relations)
        fused.push(project_entity_for_fusion(&entity, percentile as u8));
    }

    // 5. Write output
    let output = json!({ "entities": fused, "_ts": timestamp_now() });
    let serialized =
        serde_json::to_vec(&output).map_err(|e| Error::from_reason(format!("serialize: {e}")))?;

    // Ensure parent dir exists
    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    nxvf_core::write_zstd(&output_path, &serialized, 3)
        .map_err(|e| Error::from_reason(e))?;

    Ok(FuseShardResult {
        entity_count: fused.len() as u32,
        filtered_relations: filtered_rels,
        enriched_count: enriched,
    })
}

fn try_load_enrichment(dir: &str, umid: &str) -> Option<String> {
    for ext in &[".md.gz", ".md.zst"] {
        let path = format!("{}/{}{}", dir, umid, ext);
        if let Ok(data) = std::fs::read(&path) {
            if let Ok(content) = nxvf_core::auto_decompress(&data) {
                return Some(String::from_utf8_lossy(&content).into_owned());
            }
        }
    }
    None
}

fn timestamp_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}
