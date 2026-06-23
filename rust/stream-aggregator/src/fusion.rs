//! V26.5 Shard Fusion — Rust-native per-shard processing for master-fusion.
//!
//! Reads a shard file, applies closed-world relation filter, late-binding FNI,
//! optional enrichment injection, projects entities, and writes zstd output.

use std::collections::HashSet;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::project::project_entity_for_fusion;

/// Rust-side mirror of JS `generateUMID`.
/// Unsalted, publicly verifiable: SHA256(canonical_id) → first 8 bytes → 16 hex
/// chars. Must match `scripts/factory/lib/umid-generator.js` exactly.
fn generate_umid(canonical_id: &str) -> String {
    let digest = Sha256::digest(canonical_id.as_bytes());
    let mut out = String::with_capacity(16);
    for b in digest.iter().take(8) {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

#[napi(object)]
pub struct FuseShardResult {
    pub entity_count: u32,
    pub filtered_relations: u32,
    pub enriched_count: u32,
    /// W3-O1 parse-attrition accounting for THIS shard (structured side-channel,
    /// never parsed from console text). master-fusion.js accumulates these.
    pub parse_accounting: ParseAccounting,
}

/// W3-O1 capability-handshake protocol constant exported on the stream-aggregator
/// NAPI surface (Finding B / D-89). The JS bridge reads this to PROVE a v1-capable
/// reader is live: a stale `.node` lacking this export is classified NOT_ACTIVE
/// (WARN, no publication block) instead of masquerading as an integrity FAIL.
/// Mirrors `nxvf_core::parse_report::NXVF_PARSE_ACCOUNTING_PROTOCOL`.
#[napi]
pub fn nxvf_parse_accounting_protocol() -> u32 {
    nxvf_core::parse_report::NXVF_PARSE_ACCOUNTING_PROTOCOL
}

/// W3-O1 per-shard parse accounting surfaced across the NAPI boundary. Carries
/// ONLY counts + a conservation flag + distinct error classes — no payloads,
/// source text, tokens, or keys. `conserved == false` is a fail-closed signal.
/// `protocol_version` self-declares the handshake so a default-zero/absent field
/// can never be inferred as v1 (Finding A anti-empty-set + Finding B handshake).
#[napi(object)]
pub struct ParseAccounting {
    pub protocol_version: u32,
    pub declared: u32,
    pub parsed: u32,
    pub dropped: u32,
    pub parse_errors: u32,
    pub conserved: bool,
    pub error_classes: Vec<String>,
}

/// Fuse a single shard: read → closed-world filter → FNI → enrich → project → write.
/// enrichment_dir may be empty to skip enrichment.
#[napi]
pub fn fuse_shard(
    shard_path: String,
    valid_ids_json: String,
    fni_thresholds_path: String,
    enrichment_dir: String,
    output_path: String,
) -> Result<FuseShardResult> {
    // 1. Parse valid IDs from N-API string (no intermediate file)
    let ids_val: serde_json::Value = serde_json::from_str(&valid_ids_json)
        .map_err(|e| Error::from_reason(format!("parse valid_ids: {e}")))?;
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

    // 3. Read shard (W3-O1: accounted variant surfaces per-entry parse attrition
    // via a structured side-channel; the entity Vec is byte-identical to the
    // non-accounted reader, so fusion output is unchanged).
    let (entities, parse_report) = nxvf_core::load_shard_entities_accounted(&shard_path)
        .map_err(|e| Error::from_reason(format!("read shard: {e}")))?;

    let mut fused = Vec::with_capacity(entities.len());
    let mut filtered_rels = 0u32;
    let mut enriched = 0u32;
    let do_enrich = !enrichment_dir.is_empty();

    // Load ID→umid manifest written by JS downloadShardEnrichment
    let umid_manifest: std::collections::HashMap<String, String> = if do_enrich {
        let manifest_path = format!("{}/manifest.json", enrichment_dir);
        std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Default::default()
    };

    for mut entity in entities {
        let id = entity
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }

        // Always re-stamp umid from canonical id (unsalted SHA256). Binary shards
        // can carry stale salted umids from earlier cycles; inheriting those mixes
        // namespaces and produces UNIQUE-constraint collisions in pack-db.
        // Re-stamping is idempotent and guarantees one-to-one id <-> umid alignment
        // with Phase 3 enrichment lookup keys.
        let fresh_umid = generate_umid(&id);
        entity["umid"] = json!(fresh_umid);

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

        // C. Enrichment from pre-downloaded local files.
        // Use the freshly-stamped umid — Phase 4 of master-fusion.js saves
        // enrichment files as `${generateUMID(id)}.md.gz`, so this matches.
        // umid_manifest is kept as a belt-and-braces fallback for the rare case
        // where a stale manifest entry is the only available lookup key.
        if do_enrich {
            let umid: &str = if !fresh_umid.is_empty() {
                &fresh_umid
            } else {
                umid_manifest.get(&id).map(|s| s.as_str()).unwrap_or("")
            };
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
        parse_accounting: ParseAccounting {
            protocol_version: parse_report.protocol_version,
            declared: parse_report.declared_entity_count as u32,
            parsed: parse_report.parsed_entity_count as u32,
            dropped: parse_report.dropped_entity_count as u32,
            parse_errors: parse_report.parse_error_count as u32,
            conserved: parse_report.conserved(),
            error_classes: parse_report
                .distinct_error_classes()
                .iter()
                .map(|s| s.to_string())
                .collect(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn umid_matches_js_reference() {
        // Reference values precomputed via JS generateUMID() in
        // scripts/factory/lib/umid-generator.js, i.e. unsalted
        // SHA256(canonical_id)[0..16]. If this test fails after touching
        // generate_umid(), you have desynced Rust from JS — pack-db will start
        // rejecting entities with UNIQUE-umid collisions.
        //
        // UMID is unsalted, so it is publicly verifiable. Anyone can recompute:
        //   node -e "console.log(require('crypto').createHash('sha256')
        //     .update('hf-model--meta-llama--llama-3').digest('hex').slice(0,16))"
        assert_eq!(
            generate_umid("hf-model--meta-llama--llama-3"),
            "52eaca4b97d1964e"
        );
        // A salt-set environment must NOT change the output (salt is gone).
        std::env::set_var("UMID_SALT", "test-salt-123");
        assert_eq!(
            generate_umid("hf-model--meta-llama--llama-3"),
            "52eaca4b97d1964e"
        );
        std::env::remove_var("UMID_SALT");
        // A second canonical_id, also publicly verifiable.
        assert_eq!(
            generate_umid("arxiv-paper--2017--attention-is-all-you-need"),
            "8e055264c3931891"
        );
    }
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
