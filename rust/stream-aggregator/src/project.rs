use std::collections::HashMap;
use std::fs;
use std::io::{BufWriter, Write};

use napi::Error;
use napi::Result;
use serde_json::{json, Value};

/// Re-read shards, project entities to slim format, inject percentiles, write NDJSON.
pub fn project_and_write(
    shard_files: &[String],
    rankings: &HashMap<String, u8>,
    output_path: &str,
) -> Result<usize> {
    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(output_path).parent() {
        fs::create_dir_all(parent).ok();
    }

    let out_file = fs::File::create(output_path)
        .map_err(|e| Error::from_reason(format!("Cannot create output: {}", e)))?;
    let mut writer = BufWriter::new(out_file);
    let mut total = 0usize;

    for file_path in shard_files {
        let entities = match super::load_shard_entities(file_path) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[RUST-STREAM] Skipping corrupted shard {}: {}", file_path, e);
                continue;
            }
        };
        for e in &entities {
            let id = e.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() {
                continue;
            }

            let percentile = rankings.get(id).copied().unwrap_or(0);
            let slim = project_entity(e, percentile);

            serde_json::to_writer(&mut writer, &slim)
                .map_err(|e| Error::from_reason(format!("Write error: {}", e)))?;
            writer
                .write_all(b"\n")
                .map_err(|e| Error::from_reason(format!("Write error: {}", e)))?;
            total += 1;
        }
        // Each shard's data freed here when `entities` goes out of scope
    }

    writer
        .flush()
        .map_err(|e| Error::from_reason(format!("Flush error: {}", e)))?;
    Ok(total)
}

/// Port of registry-loader.js projectEntity (slim mode)
pub(crate) fn project_entity(e: &Value, fni_percentile: u8) -> Value {
    let description = get_description(e);

    json!({
        "id": str_field(e, "id"),
        "umid": str_field(e, "umid"),
        "slug": e.get("slug").and_then(|v| v.as_str()).unwrap_or(""),
        "name": e.get("name")
            .or(e.get("title"))
            .or(e.get("displayName"))
            .and_then(|v| v.as_str()).unwrap_or(""),
        "type": e.get("type")
            .or(e.get("entity_type"))
            .and_then(|v| v.as_str()).unwrap_or("model"),
        "author": e.get("author")
            .or(e.get("creator"))
            .or(e.get("organization"))
            .and_then(|v| v.as_str()).unwrap_or(""),
        "description": description,
        "tags": e.get("tags").cloned().unwrap_or(json!([])),
        "metrics": e.get("metrics").cloned().unwrap_or(json!({})),
        "stars": num_field(e, &["stars", "github_stars"]),
        "downloads": num_field(e, &["downloads"]),
        "likes": num_field(e, &["likes"]),
        "citations": num_field(e, &["citations"]),
        "fni_score": e.get("fni_score").and_then(|v| v.as_f64())
            .or_else(|| e.get("fni").and_then(|v| v.as_f64()))
            .unwrap_or(0.0),
        "fni_percentile": fni_percentile,
        "fni_s": nested_f64(e, &["fni_s"], &["fni_metrics", "s"]),
        "fni_a": nested_f64(e, &["fni_a"], &["fni_metrics", "a"]),
        "fni_p": nested_f64(e, &["fni_p"], &["fni_metrics", "p"]),
        "fni_r": nested_f64(e, &["fni_r"], &["fni_metrics", "r"]),
        "fni_q": nested_f64(e, &["fni_q"], &["fni_metrics", "q"]),
        "primary_category": str_field(e, "primary_category"),
        "pipeline_tag": str_field(e, "pipeline_tag"),
        "last_modified": e.get("last_modified")
            .or(e.get("last_updated"))
            .or(e.get("lastModified"))
            .or(e.get("_updated"))
            .and_then(|v| v.as_str()).unwrap_or(""),
        "license": e.get("license")
            .or(e.get("license_spdx"))
            .and_then(|v| v.as_str()).unwrap_or(""),
        "source": str_field(e, "source"),
    })
}

/// V27.94: DEDICATED relation-aware projection.
///
/// Root-cause fix for the P0 mesh/relation data void: the slim `project_entity`
/// strips every relation-source field, so `extractEntityRelations`
/// (scripts/factory/lib/relation-extractors.js) only ever emitted STACK edges
/// (61.8% zero-rel in prod; zero BASED_ON/TRAINED_ON/CITES/USES/IMPLEMENTS).
///
/// This is intentionally SEPARATE from both slim and fusion:
///  - NOT the slim projector: adding a flag there would pollute the
///    rankings/FNI P1 streaming path with Option<T> bloat.
///  - NOT `project_entity_for_fusion`: it is missing ~8 of the relation field
///    clusters AND carries cold-tier bloat (body_content/html_readme/readme/
///    search_vector) that would blow V8 heap in the extraction stream.
///
/// Field set is the EXACT set read by `extractEntityRelations` (plus
/// fni_score, which generateRelations uses for node force weighting):
///   identity/STACK inputs: id, slug, type, name, tags, description
///   relation clusters: base_model, datasets, datasets_used, arxiv_refs,
///   paper_refs, references, models_used, models, model_id, sdk,
///   implementations, dependencies, features, highlights, velocity,
///   knowledge_tags
/// (the diagnosis list's `relations` is NOT read by the extractor — dropped.)
pub(crate) fn project_entity_for_relations(e: &Value) -> Value {
    let mut out = json!({
        "id": str_field(e, "id"),
        "slug": str_field(e, "slug"),
        "type": e.get("type")
            .or(e.get("entity_type"))
            .and_then(|v| v.as_str()).unwrap_or("model"),
        "name": e.get("name")
            .or(e.get("title"))
            .or(e.get("displayName"))
            .and_then(|v| v.as_str()).unwrap_or(""),
        "description": str_field(e, "description"),
        // generateRelations weights graph nodes by fni_score (single float, not
        // the S/A/P/R/Q metric cluster) — preserve node force without slim bloat.
        "fni_score": e.get("fni_score").and_then(|v| v.as_f64())
            .or_else(|| e.get("fni").and_then(|v| v.as_f64())).unwrap_or(0.0),
    });
    const REL_FIELDS: &[&str] = &[
        "tags", "base_model", "datasets", "datasets_used",
        "arxiv_refs", "paper_refs", "references",
        "models_used", "models", "model_id", "sdk",
        "implementations", "dependencies", "features", "highlights",
        "velocity", "knowledge_tags",
    ];
    for key in REL_FIELDS {
        if let Some(v) = e.get(*key) {
            out[*key] = v.clone();
        }
    }
    out
}

fn str_field<'a>(e: &'a Value, key: &str) -> &'a str {
    e.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

fn num_field(e: &Value, keys: &[&str]) -> f64 {
    for k in keys {
        if let Some(v) = e.get(*k).and_then(|v| v.as_f64()) {
            return v;
        }
    }
    0.0
}

fn nested_f64(e: &Value, direct: &[&str], nested_path: &[&str; 2]) -> f64 {
    for k in direct {
        if let Some(v) = e.get(*k).and_then(|v| v.as_f64()) {
            return v;
        }
    }
    e.get(nested_path[0])
        .and_then(|v| v.get(nested_path[1]))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
}

/// Full-mode projection for fusion — pass through every field pack-db /
/// distiller / row-builders / bundle-builder need downstream.
///
/// V27.61: prior to this PR the whitelist silently dropped ~30 SQL schema
/// columns, including all 4 confirmed (citation/benchmarks/datasets_used/
/// quick_start) plus ~26 others (specs.*, stats.*, links.*, etc).
/// V27.44-V27.49 JS-side data-quality PRs all delivered net zero impact
/// because the field never survived this projection step. See brain memo
/// 2026-05-26 后段三连 audit for evidence.
///
/// Slim `project_entity` above is unchanged — `project_and_write` callers
/// (rankings NDJSON) intentionally need the slim form for FNI compute.
pub(crate) fn project_entity_for_fusion(e: &Value, fni_percentile: u8) -> Value {
    let mut base = project_entity(e, fni_percentile);
    const PASSTHROUGH: &[&str] = &[
        // Cold-tier essentials (existing 3, now in the list for consistency)
        "body_content", "has_fulltext", "relations",
        // Structured metadata used by distiller / row-builders
        "category", "summary", "params_billions", "architecture", "context_length",
        "is_trending", "trend_7d", "_trend_7d",
        "source_url", "image_url", "raw_image_url", "canonical_url",
        "vram_estimate_gb", "vram_fp16_gb", "vram_int8_gb", "vram_int4_gb",
        "task_categories", "num_rows", "primary_language", "forks", "citation_count",
        "runtime_hardware", "vocab_size", "num_layers", "hidden_size",
        "datasets_used", "quick_start", "citation",
        "has_ollama", "has_gguf", "ollama_compatible", "can_run_local",
        "hosted_on", "hosted_on_checked_at",
        "ui_related_mesh", "search_vector",
        // Fields the distiller re-reads as fallback inputs
        "meta_json", "fni_metrics", "license_spdx", "source_platform",
        // Bundle JSON fields (row-builders.js:28-50 builds .bin shards from these)
        "benchmarks", "paper_abstract", "mesh_profile", "changelog",
        "quick_insights", "use_cases", "quantization", "html_readme",
        "created_at", "display_description", "readme",
        // Adapter raw fields used as fallback inputs
        "base_model", "gguf_variants",
    ];
    for key in PASSTHROUGH {
        if let Some(v) = e.get(*key) {
            base[*key] = v.clone();
        }
    }
    base
}

/// Build description with fallback from readme/content/html_readme/body_content
fn get_description(e: &Value) -> String {
    // Try direct description fields
    let raw = e
        .get("description")
        .and_then(|v| v.as_str())
        .or_else(|| e.get("summary").and_then(|v| v.as_str()))
        .or_else(|| {
            e.get("seo_summary")
                .and_then(|v| v.get("description"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("");

    if raw.len() >= 5 {
        return raw.to_string();
    }

    // Fallback: extract from readme/content
    let source = e
        .get("readme")
        .and_then(|v| v.as_str())
        .or_else(|| e.get("content").and_then(|v| v.as_str()))
        .or_else(|| e.get("html_readme").and_then(|v| v.as_str()))
        .or_else(|| e.get("body_content").and_then(|v| v.as_str()))
        .unwrap_or("");

    if source.is_empty() {
        return String::new();
    }

    // Strip HTML tags and markdown, take first 250 chars
    let stripped: String = source
        .chars()
        .take(300)
        .collect::<String>()
        .replace(|c: char| c == '#' || c == '*' || c == '`', "");
    // Simple HTML tag removal
    let mut result = String::with_capacity(250);
    let mut in_tag = false;
    for ch in stripped.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            result.push(' ');
            continue;
        }
        if !in_tag {
            result.push(ch);
        }
    }
    // Normalize whitespace and truncate
    let normalized: String = result.split_whitespace().collect::<Vec<&str>>().join(" ");
    normalized.chars().take(250).collect()
}
