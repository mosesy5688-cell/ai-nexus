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
        let entities = super::load_shard_entities(file_path)?;
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
fn project_entity(e: &Value, fni_percentile: u8) -> Value {
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
        "fni_p": nested_f64(e, &["fni_p"], &["fni_metrics", "p"]),
        "fni_v": nested_f64(e, &["fni_v"], &["fni_metrics", "f"]),
        "fni_c": nested_f64(e, &["fni_c"], &["fni_metrics", "c"]),
        "fni_u": nested_f64(e, &["fni_u"], &["fni_metrics", "u"]),
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
