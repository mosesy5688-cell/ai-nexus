//! Alt Linker - Jaccard Similarity Engine
//! Computes ALT (alternative) relations per category using Jaccard similarity.

use flate2::write::GzEncoder;
use flate2::Compression;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::Write;

const MAX_PER_CATEGORY: usize = 500;
const JACCARD_THRESHOLD: f64 = 0.3;
const MAX_ALTS: usize = 10;

#[napi(object)]
pub struct AltLinkerResult {
    pub categories_data: Vec<AltCategoryResult>,
    pub meta_data: Buffer,
    pub total_relations: u32,
}

#[napi(object)]
pub struct AltCategoryResult {
    pub category: String,
    pub filename: String,
    pub compressed_data: Buffer,
    pub relation_count: u32,
}

fn str_val(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .to_lowercase()
}

fn get_tags(entity: &Value) -> Vec<String> {
    entity.get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

fn jaccard_similarity(tags_a: &HashSet<String>, tags_b: &HashSet<String>) -> f64 {
    if tags_a.is_empty() && tags_b.is_empty() { return 0.0; }
    let intersection = tags_a.intersection(tags_b).count();
    let union = tags_a.union(tags_b).count();
    if union == 0 { 0.0 } else { intersection as f64 / union as f64 }
}

fn gzip_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data)
        .map_err(|e| Error::from_reason(format!("Gzip write error: {}", e)))?;
    encoder.finish()
        .map_err(|e| Error::from_reason(format!("Gzip finish error: {}", e)))
}

/// Compute ALT relations using Jaccard similarity.
#[napi]
pub fn compute_alt_relations(entities_json: Buffer) -> Result<AltLinkerResult> {
    let data = std::str::from_utf8(&entities_json)
        .map_err(|e| Error::from_reason(format!("Invalid UTF-8: {}", e)))?;
    let entities: Vec<Value> = serde_json::from_str(data)
        .map_err(|e| Error::from_reason(format!("JSON parse error: {}", e)))?;

    // Group by category
    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    for entity in &entities {
        let cat = {
            let c = str_val(entity, "primary_category");
            if !c.is_empty() { c }
            else {
                let p = str_val(entity, "pipeline_tag");
                if !p.is_empty() { p } else { "other".to_string() }
            }
        };
        groups.entry(cat).or_default().push(entity);
    }

    let mut categories_data: Vec<AltCategoryResult> = Vec::new();
    let mut total_relations: u32 = 0;
    let mut meta_categories: Vec<Value> = Vec::new();

    for (category, mut group) in groups {
        // Sort by fni_score desc, take top 500
        group.sort_by(|a, b| {
            let fa = a.get("fni_score").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let fb = b.get("fni_score").and_then(|v| v.as_f64()).unwrap_or(0.0);
            fb.partial_cmp(&fa).unwrap_or(std::cmp::Ordering::Equal)
        });
        group.truncate(MAX_PER_CATEGORY);

        // Build tag sets and inverted index
        let mut tag_sets: Vec<(String, HashSet<String>)> = Vec::new();
        let mut inverted: HashMap<String, Vec<usize>> = HashMap::new();

        for (idx, entity) in group.iter().enumerate() {
            let id = str_val(entity, "id");
            let tags: HashSet<String> = get_tags(entity).into_iter().collect();
            for tag in &tags {
                inverted.entry(tag.clone()).or_default().push(idx);
            }
            tag_sets.push((id, tags));
        }

        // Compute Jaccard for each entity
        let mut cat_results: Vec<Value> = Vec::new();
        let mut cat_rel_count: u32 = 0;

        for (idx, (source_id, source_tags)) in tag_sets.iter().enumerate() {
            if source_tags.is_empty() { continue; }

            // Gather candidate indices from inverted index
            let mut candidates: HashSet<usize> = HashSet::new();
            for tag in source_tags {
                if let Some(indices) = inverted.get(tag) {
                    for &i in indices {
                        if i != idx { candidates.insert(i); }
                    }
                }
            }

            // Compute similarity for each candidate
            let mut scored: Vec<(String, i64)> = Vec::new();
            for cand_idx in candidates {
                let (cand_id, cand_tags) = &tag_sets[cand_idx];
                let sim = jaccard_similarity(source_tags, cand_tags);
                if sim >= JACCARD_THRESHOLD {
                    scored.push((cand_id.clone(), (sim * 100.0).round() as i64));
                }
            }

            // Sort desc by score, take top 10
            scored.sort_by(|a, b| b.1.cmp(&a.1));
            scored.truncate(MAX_ALTS);

            if !scored.is_empty() {
                let alts: Vec<Value> = scored.iter()
                    .map(|(id, s)| serde_json::json!([id, s]))
                    .collect();
                cat_rel_count += alts.len() as u32;
                cat_results.push(serde_json::json!({
                    "source_id": source_id,
                    "category": category,
                    "alts": alts,
                }));
            }
        }

        let filename = format!("{}.json.gz", sanitize_filename(&category));
        let cat_json = serde_json::to_vec(&cat_results)
            .map_err(|e| Error::from_reason(format!("Serialize error: {}", e)))?;
        let compressed = gzip_bytes(&cat_json)?;

        meta_categories.push(serde_json::json!({
            "category": category,
            "filename": filename,
            "entity_count": group.len(),
            "relation_count": cat_rel_count,
        }));

        total_relations += cat_rel_count;
        categories_data.push(AltCategoryResult {
            category: category.clone(),
            filename,
            compressed_data: compressed.into(),
            relation_count: cat_rel_count,
        });
    }

    let meta = serde_json::json!({
        "_v": "25.8.3",
        "categories": meta_categories,
        "total_relations": total_relations,
    });
    let meta_bytes = serde_json::to_vec(&meta)
        .map_err(|e| Error::from_reason(format!("Serialize error: {}", e)))?;
    let meta_compressed = gzip_bytes(&meta_bytes)?;

    Ok(AltLinkerResult {
        categories_data,
        meta_data: meta_compressed.into(),
        total_relations,
    })
}
