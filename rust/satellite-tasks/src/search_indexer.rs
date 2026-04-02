//! Search Index Builder
//! Builds core index (top 5000 gzip'd) + sharded full index + manifest.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

const CORE_SIZE: usize = 5000;
const SHARD_SIZE: usize = 5000;

#[napi(object)]
pub struct SearchShardResult {
    pub shard_index: u32,
    pub entity_count: u32,
    pub compressed_data: Buffer,
}

#[napi(object)]
pub struct SearchIndexResult {
    pub core_data: Buffer,
    pub shards: Vec<SearchShardResult>,
    pub manifest_json: String,
    pub total_entities: u32,
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string(); }
    // Find a valid UTF-8 char boundary at or before `max`
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    s[..end].to_string()
}

fn str_val(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn num_val(v: &Value, key: &str) -> Value {
    v.get(key).cloned().unwrap_or(Value::Null)
}

fn build_core_entry(e: &Value) -> Value {
    let name = str_val(e, "name");
    let name = if name.is_empty() {
        let s = str_val(e, "slug");
        if s.is_empty() { "Unknown".to_string() } else { s }
    } else { name };

    let slug = str_val(e, "slug");
    let slug = if slug.is_empty() {
        let id = str_val(e, "id");
        id.rsplit_once('/').or_else(|| id.rsplit_once(':'))
            .map(|(_, r)| r.to_string())
            .unwrap_or(id)
    } else { slug };

    let etype = str_val(e, "type");
    let etype = if etype.is_empty() { "model".to_string() } else { etype };

    let desc = {
        let d = str_val(e, "description");
        if d.is_empty() { str_val(e, "summary") } else { d }
    };

    serde_json::json!({
        "id": str_val(e, "id"),
        "name": name,
        "type": etype,
        "author": str_val(e, "author"),
        "description": truncate(&desc, 150),
        "slug": slug,
        "params_billions": num_val(e, "params_billions"),
        "context_length": num_val(e, "context_length"),
        "stars": num_val(e, "stars"),
        "downloads": num_val(e, "downloads"),
        "fni_s": num_val(e, "fni_s"),
        "fni_a": num_val(e, "fni_a"),
        "fni_p": num_val(e, "fni_p"),
        "fni_r": num_val(e, "fni_r"),
        "fni_q": num_val(e, "fni_q"),
        "bundle_key": num_val(e, "bundle_key"),
        "bundle_offset": num_val(e, "bundle_offset"),
        "bundle_size": num_val(e, "bundle_size"),
    })
}

fn build_full_entry(e: &Value) -> Value {
    let mut entry = build_core_entry(e);
    let obj = entry.as_object_mut().unwrap();

    // tags: first 5
    if let Some(tags) = e.get("tags").and_then(|t| t.as_array()) {
        let first5: Vec<Value> = tags.iter().take(5).cloned().collect();
        obj.insert("tags".into(), Value::Array(first5));
    } else {
        obj.insert("tags".into(), Value::Array(vec![]));
    }

    // fni_score rounded
    if let Some(fni) = e.get("fni_score").and_then(|f| f.as_f64()) {
        obj.insert("fni_score".into(), serde_json::json!(fni.round()));
    }

    obj.insert("image_url".into(), num_val(e, "image_url"));
    entry
}

fn zstd_json(val: &Value) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(val)
        .map_err(|e| Error::from_reason(format!("JSON serialize error: {}", e)))?;
    zstd::encode_all(json.as_slice(), 3)
        .map_err(|e| Error::from_reason(format!("Zstd compress error: {}", e)))
}

/// V26.5: Build search indices by streaming shard files — two-pass, O(shard_size) memory.
/// Pass 1: extract FNI scores → determine top-5000 threshold.
/// Pass 2: re-read shards, build core + full entries, emit shards progressively.
#[napi]
pub fn build_search_index_from_dir(shard_dir: String, _output_dir: String) -> Result<SearchIndexResult> {
    // Pass 1: Collect (fni_score) to find the core threshold
    let mut scores: Vec<f64> = Vec::new();
    nxvf_core::for_each_shard(&shard_dir, |entities| {
        for e in &entities {
            let fni = e.get("fni_score").and_then(|v| v.as_f64())
                .or_else(|| e.get("fni").and_then(|v| v.as_f64()))
                .unwrap_or(0.0);
            scores.push(fni);
        }
        Ok(())
    }).map_err(|e| Error::from_reason(e))?;

    // Sort descending, find threshold for top CORE_SIZE
    scores.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let core_threshold = if scores.len() > CORE_SIZE { scores[CORE_SIZE - 1] } else { 0.0 };
    let total = scores.len() as u32;
    drop(scores); // Free O(N * 8 bytes) — lightweight

    // Pass 2: Stream shards, build core + full entries
    let mut core_entries: Vec<Value> = Vec::new();
    let mut full_entries: Vec<Value> = Vec::new();

    nxvf_core::for_each_shard(&shard_dir, |entities| {
        for e in &entities {
            let fni = e.get("fni_score").and_then(|v| v.as_f64())
                .or_else(|| e.get("fni").and_then(|v| v.as_f64()))
                .unwrap_or(0.0);
            if fni >= core_threshold && core_entries.len() < CORE_SIZE {
                core_entries.push(build_core_entry(e));
            }
            full_entries.push(build_full_entry(e));
        }
        Ok(())
    }).map_err(|e| Error::from_reason(e))?;

    eprintln!("[RUST-SAT] build_search_index_from_dir: {} total, {} core (threshold={:.1})",
        total, core_entries.len(), core_threshold);

    // Build output (same as inner)
    let core_data = zstd_json(&Value::Array(core_entries))?;
    let mut shards = Vec::new();
    for (i, chunk) in full_entries.chunks(SHARD_SIZE).enumerate() {
        let compressed = zstd_json(&Value::Array(chunk.to_vec()))?;
        shards.push(SearchShardResult {
            shard_index: i as u32, entity_count: chunk.len() as u32, compressed_data: compressed.into(),
        });
    }

    let manifest = serde_json::json!({
        "totalEntities": total, "totalShards": shards.len(), "shardSize": SHARD_SIZE, "extension": ".zst",
    });

    Ok(SearchIndexResult { core_data: core_data.into(), shards, manifest_json: manifest.to_string(), total_entities: total })
}

/// Build search indices from entity JSON buffer (legacy Buffer API).
#[napi]
pub fn build_search_index(entities_json: Buffer) -> Result<SearchIndexResult> {
    let raw = String::from_utf8_lossy(&entities_json);
    let sanitized = nxvf_core::sanitize_json_escapes(&raw);
    let entities: Vec<Value> = serde_json::from_str(&sanitized)
        .map_err(|e| Error::from_reason(format!("JSON parse error: {}", e)))?;
    build_search_index_inner(&entities, None)
}

fn build_search_index_inner(entities: &[Value], _output_dir: Option<&str>) -> Result<SearchIndexResult> {

    let total = entities.len() as u32;

    // Core index: top 5000
    let core: Vec<Value> = entities.iter().take(CORE_SIZE).map(build_core_entry).collect();
    let core_data = zstd_json(&Value::Array(core))?;

    // Full index: all entities, sharded
    let full: Vec<Value> = entities.iter().map(build_full_entry).collect();
    let mut shards = Vec::new();
    for (i, chunk) in full.chunks(SHARD_SIZE).enumerate() {
        let compressed = zstd_json(&Value::Array(chunk.to_vec()))?;
        shards.push(SearchShardResult {
            shard_index: i as u32,
            entity_count: chunk.len() as u32,
            compressed_data: compressed.into(),
        });
    }

    let manifest = serde_json::json!({
        "totalEntities": total,
        "totalShards": shards.len(),
        "shardSize": SHARD_SIZE,
        "extension": ".zst",
    });

    Ok(SearchIndexResult {
        core_data: core_data.into(),
        shards,
        manifest_json: manifest.to_string(),
        total_entities: total,
    })
}
