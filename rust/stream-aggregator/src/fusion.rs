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

/// W3-O1 (D-89/D-90) capability handshake constant. Value 1 = this addon emits
/// protocol-v1 parse accounting + per-drop detail records across the NAPI
/// boundary. The JS canary reads THIS (never a default-zero field) to classify
/// the engine as protocol-v1-capable. A legacy addon lacks this export entirely.
#[napi]
pub const PARSE_ACCOUNTING_PROTOCOL: u32 = 1;

/// W3-O1 per-drop record carried ACROSS the NAPI boundary (camelCase to Node).
/// Irreversible coordinates ONLY — never payload bytes, source text, tokens, or
/// keys. `payloadFingerprint`/`serdeLine`/`serdeColumn` are null when N/A.
///
/// `use_nullable = true` is LOAD-BEARING for the W3-O1 contract (Founder D-90):
/// the default `#[napi(object)]` projection OMITS an `Option::None` field from
/// the JS object, so Node reads it back as `undefined`. The spec — and the CI
/// verifier `verify-parse-accounting-binding.mjs` — require a no-payload drop to
/// present `payloadFingerprint === null` (JS null), NOT `undefined`. With
/// `use_nullable`, napi-derive emits `obj.set(field, Null)` for the `None` arm,
/// yielding a real JS `null`; the `Some` arm still emits the 16-hex fingerprint
/// string. This also makes `serdeLine`/`serdeColumn` present as JS null (not
/// undefined) for non-json-parse drops, matching their "null when N/A" contract.
#[napi(object, use_nullable = true)]
pub struct ParseDropRecord {
    pub part: String,
    pub entry_index: u32,
    pub error_class: String,
    pub serde_line: Option<u32>,
    pub serde_column: Option<u32>,
    pub payload_length: u32,
    pub payload_fingerprint: Option<String>,
    pub fingerprint_status: String,
    pub attribution_status: String,
}

/// W3-O1 structured parse accounting for a single fused shard. `protocolVersion`
/// is self-declaring (== PARSE_ACCOUNTING_PROTOCOL) so the JS summary can never
/// infer v1 from an absent/default field. `dropRecords` carries EVERY dropped
/// entry; its length MUST equal `droppedEntityCount` (drop-detail completeness).
#[napi(object)]
pub struct ParseAccounting {
    pub protocol_version: u32,
    /// "binary" when the monitored NXVF reader ran; "not_applicable" for legacy
    /// JSON shards (no binary parse-attrition path on that read).
    pub engine_path: String,
    pub part: String,
    pub declared_entity_count: u32,
    pub parsed_entity_count: u32,
    pub dropped_entity_count: u32,
    pub parse_error_count: u32,
    pub conserved: bool,
    pub drop_records: Vec<ParseDropRecord>,
}

#[napi(object)]
pub struct FuseShardResult {
    pub entity_count: u32,
    pub filtered_relations: u32,
    pub enriched_count: u32,
    /// W3-O1 side-channel parse accounting (D-88/D-90). Always present.
    pub parse_accounting: ParseAccounting,
}

/// Map a nxvf-core ShardParseReport into the NAPI-facing ParseAccounting.
fn build_parse_accounting(report: &nxvf_core::ShardParseReport) -> ParseAccounting {
    let drop_records = report
        .records
        .iter()
        .map(|r| ParseDropRecord {
            part: r.part.clone(),
            entry_index: r.entry_index,
            error_class: r.error_class.as_str().to_string(),
            // serde line/column only meaningful for json-parse drops.
            serde_line: if r.error_class == nxvf_core::DropClass::JsonParse {
                Some(r.serde_line)
            } else {
                None
            },
            serde_column: if r.error_class == nxvf_core::DropClass::JsonParse {
                Some(r.serde_column)
            } else {
                None
            },
            payload_length: r.payload_length,
            payload_fingerprint: r.payload_fingerprint.clone(),
            fingerprint_status: r.fingerprint_status.to_string(),
            attribution_status: r.attribution_status.to_string(),
        })
        .collect();
    ParseAccounting {
        protocol_version: PARSE_ACCOUNTING_PROTOCOL,
        engine_path: "binary".to_string(),
        part: report.part.clone(),
        declared_entity_count: report.declared_entity_count,
        parsed_entity_count: report.parsed_entity_count,
        dropped_entity_count: report.dropped_entity_count(),
        parse_error_count: report.parse_error_count(),
        conserved: report.is_conserved(),
        drop_records,
    }
}

/// Accounting for a NON-monitored shard read (legacy JSON path): no binary
/// parse-attrition exists there, so this is protocol-v1 but engine_path
/// "not_applicable" with zero declared/dropped and an empty record set. The JS
/// canary treats not_applicable as NOT a conserved-summary signal.
fn not_applicable_accounting(part: &str) -> ParseAccounting {
    ParseAccounting {
        protocol_version: PARSE_ACCOUNTING_PROTOCOL,
        engine_path: "not_applicable".to_string(),
        part: part.to_string(),
        declared_entity_count: 0,
        parsed_entity_count: 0,
        dropped_entity_count: 0,
        parse_error_count: 0,
        conserved: true,
        drop_records: Vec::new(),
    }
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
    let thresholds = nxvf_core::load_json_file(&fni_thresholds_path).unwrap_or_else(|_| json!({}));
    let score_pcts = thresholds
        .get("scorePercentiles")
        .and_then(|v| v.as_object());

    // 3. Read shard. For the monitored NXVF binary path use the reporting
    // variant (survivors byte+order identical; accounting is side-channel).
    let part_name = std::path::Path::new(&shard_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let (entities, parse_accounting) = if shard_path.ends_with(".bin") {
        let (e, report) = nxvf_core::read_binary_shard_with_report(&shard_path)
            .map_err(|e| Error::from_reason(format!("read shard: {e}")))?;
        let acc = build_parse_accounting(&report);
        (e, acc)
    } else {
        let e = nxvf_core::load_shard_entities(&shard_path)
            .map_err(|e| Error::from_reason(format!("read shard: {e}")))?;
        (e, not_applicable_accounting(&part_name))
    };

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
        if let Some(rels) = entity.get_mut("relations").and_then(|v| v.as_array_mut()) {
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
    nxvf_core::write_zstd(&output_path, &serialized, 3).map_err(|e| Error::from_reason(e))?;

    Ok(FuseShardResult {
        entity_count: fused.len() as u32,
        filtered_relations: filtered_rels,
        enriched_count: enriched,
        parse_accounting,
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

    /// W3-O1: the NAPI projection of an offset-boundary (no-payload) drop must
    /// carry `payload_fingerprint == None`. With `#[napi(object, use_nullable)]`
    /// on ParseDropRecord, napi-derive renders this `None` as JS `null` (not
    /// `undefined`) — which is what the CI verifier asserts on the real .node.
    /// A real-payload drop must still carry the 16-hex fingerprint string.
    #[test]
    fn no_payload_drop_projects_none_real_payload_projects_fingerprint() {
        let mut report = nxvf_core::ShardParseReport::new("part-000.bin", 2);
        report.record_parsed();
        report.record_drop(nxvf_core::DropRecord::no_payload("part-000.bin", 1));
        let acc = build_parse_accounting(&report);

        assert_eq!(acc.drop_records.len(), 1);
        let rec = &acc.drop_records[0];
        // no-payload → None (→ JS null via use_nullable) + status + no serde coords.
        assert!(rec.payload_fingerprint.is_none());
        assert_eq!(rec.fingerprint_status, "unavailable_no_payload");
        assert_eq!(rec.error_class, "offset_boundary");
        assert!(rec.serde_line.is_none());
        assert!(rec.serde_column.is_none());

        // A real-payload (json-parse) drop still projects a 16-hex fingerprint.
        let mut report2 = nxvf_core::ShardParseReport::new("part-000.bin", 1);
        report2.record_drop(nxvf_core::DropRecord::with_payload(
            "part-000.bin",
            0,
            nxvf_core::DropClass::JsonParse,
            b"{bad",
            1,
            2,
        ));
        let acc2 = build_parse_accounting(&report2);
        let rec2 = &acc2.drop_records[0];
        let fp = rec2.payload_fingerprint.as_deref().expect("fingerprint set");
        assert_eq!(fp.len(), 16);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(rec2.fingerprint_status, "ok");
        // json-parse drop DOES carry serde coords.
        assert_eq!(rec2.serde_line, Some(1));
        assert_eq!(rec2.serde_column, Some(2));
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
