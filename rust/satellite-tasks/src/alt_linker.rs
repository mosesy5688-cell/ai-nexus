//! Alt Linker - Jaccard Similarity Engine
//! Computes ALT (alternative) relations per category using Jaccard similarity.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

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

fn zstd_bytes(data: &[u8]) -> Result<Vec<u8>> {
    zstd::encode_all(data, 3)
        .map_err(|e| Error::from_reason(format!("Zstd compress error: {}", e)))
}

/// V26.5: Compute ALT relations by streaming shard files — O(shard_size) memory per shard.
/// Accumulates only category-grouped (id, fni_score, tags) tuples, not full entities.
#[napi]
pub fn compute_alt_relations_from_dir(shard_dir: String, _output_dir: String) -> Result<AltLinkerResult> {
    // Lightweight per-entity data: (id, fni_score, tags)
    struct SlimEntity { id: String, fni: f64, tags: Vec<String> }

    let mut groups: HashMap<String, Vec<SlimEntity>> = HashMap::new();

    let total = nxvf_core::for_each_shard(&shard_dir, |entities| {
        for entity in &entities {
            let id = str_val(entity, "id");
            if id.is_empty() { continue; }
            let fni = entity.get("fni_score").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let tags = get_tags(entity);
            let cat = {
                let c = str_val(entity, "primary_category");
                if !c.is_empty() { c }
                else {
                    let p = str_val(entity, "pipeline_tag");
                    if !p.is_empty() { p } else { "other".to_string() }
                }
            };
            groups.entry(cat).or_default().push(SlimEntity { id, fni, tags });
        }
        Ok(())
    }).map_err(|e| Error::from_reason(e))?;

    eprintln!("[RUST-SAT] compute_alt_relations_from_dir: streamed {} entities, {} categories", total, groups.len());

    // Now compute Jaccard per category using slim data
    let mut categories_data: Vec<AltCategoryResult> = Vec::new();
    let mut total_relations: u32 = 0;
    let mut meta_categories: Vec<Value> = Vec::new();

    for (category, mut group) in groups {
        group.sort_by(|a, b| b.fni.partial_cmp(&a.fni).unwrap_or(std::cmp::Ordering::Equal));
        group.truncate(MAX_PER_CATEGORY);

        let mut tag_sets: Vec<(&str, HashSet<String>)> = Vec::new();
        let mut inverted: HashMap<String, Vec<usize>> = HashMap::new();
        for (idx, se) in group.iter().enumerate() {
            let tset: HashSet<String> = se.tags.iter().cloned().collect();
            for tag in &tset { inverted.entry(tag.clone()).or_default().push(idx); }
            tag_sets.push((&se.id, tset));
        }

        let mut cat_results: Vec<Value> = Vec::new();
        let mut cat_rel_count: u32 = 0;
        for (idx, (source_id, source_tags)) in tag_sets.iter().enumerate() {
            if source_tags.is_empty() { continue; }
            let mut candidates: HashSet<usize> = HashSet::new();
            for tag in source_tags {
                if let Some(indices) = inverted.get(tag) {
                    for &i in indices { if i != idx { candidates.insert(i); } }
                }
            }
            let mut scored: Vec<(&str, i64)> = Vec::new();
            for ci in candidates {
                let (cid, ctags) = &tag_sets[ci];
                let sim = jaccard_similarity(source_tags, ctags);
                if sim >= JACCARD_THRESHOLD { scored.push((cid, (sim * 100.0).round() as i64)); }
            }
            scored.sort_by(|a, b| b.1.cmp(&a.1));
            scored.truncate(MAX_ALTS);
            if !scored.is_empty() {
                let alts: Vec<Value> = scored.iter().map(|(id, s)| serde_json::json!([id, s])).collect();
                cat_rel_count += alts.len() as u32;
                cat_results.push(serde_json::json!({ "source_id": source_id, "category": category, "alts": alts }));
            }
        }

        // D-375 PRODUCER_OMIT_ZERO_RELATION_FRAME: ALWAYS record the per-category
        // census entry (entity_count + relation_count, incl. 0) so alt-meta stays a
        // complete census; only EMIT a payload frame when the category has >=1
        // relation. A 0-relation category serializes to a bare `[]` (~11B zstd frame)
        // that is below the r2-handoff .zst 16B upload floor and would fail-close the
        // whole 3/4 Aggregate job. Omitting the frame is data-safe: consumers treat an
        // absent category identically to a present-empty one (both -> []). The
        // serialize+compress+push for a non-empty category is byte-identical to baseline.
        let filename = format!("{}.json.zst", sanitize_filename(&category));
        meta_categories.push(serde_json::json!({
            "category": category, "filename": filename,
            "entity_count": group.len(), "relation_count": cat_rel_count,
        }));
        total_relations += cat_rel_count;
        if cat_rel_count > 0 {
            let cat_json = serde_json::to_vec(&cat_results)
                .map_err(|e| Error::from_reason(format!("Serialize: {}", e)))?;
            let compressed = zstd_bytes(&cat_json)?;
            categories_data.push(AltCategoryResult {
                category: category.clone(), filename, compressed_data: compressed.into(), relation_count: cat_rel_count,
            });
        }
    }

    let meta = serde_json::json!({ "_v": "25.8.3", "categories": meta_categories, "total_relations": total_relations });
    let meta_compressed = zstd_bytes(&serde_json::to_vec(&meta)
        .map_err(|e| Error::from_reason(format!("Serialize: {}", e)))?)?;

    Ok(AltLinkerResult { categories_data, meta_data: meta_compressed.into(), total_relations })
}

/// Compute ALT relations using Jaccard similarity (legacy Buffer API).
#[napi]
pub fn compute_alt_relations(entities_json: Buffer) -> Result<AltLinkerResult> {
    let raw = String::from_utf8_lossy(&entities_json);
    let sanitized = nxvf_core::sanitize_json_escapes(&raw);
    let entities: Vec<Value> = serde_json::from_str(&sanitized)
        .map_err(|e| Error::from_reason(format!("JSON parse error: {}", e)))?;
    compute_alt_relations_inner(&entities)
}

fn compute_alt_relations_inner(entities: &[Value]) -> Result<AltLinkerResult> {
    // Group by category
    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    for entity in entities {
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

        // D-375 PRODUCER_OMIT_ZERO_RELATION_FRAME: ALWAYS record the census entry
        // (entity_count + relation_count incl. 0); only emit a payload frame when the
        // category has >=1 relation. A 0-relation category compresses to a bare `[]`
        // (~11B zstd) below the r2-handoff .zst 16B upload floor, which would fail-close
        // the 3/4 job. Absent == present-empty for consumers, so omission is data-safe.
        // The non-empty serialize+compress+push is byte-identical to baseline.
        let filename = format!("{}.json.zst", sanitize_filename(&category));
        meta_categories.push(serde_json::json!({
            "category": category,
            "filename": filename,
            "entity_count": group.len(),
            "relation_count": cat_rel_count,
        }));

        total_relations += cat_rel_count;
        if cat_rel_count > 0 {
            let cat_json = serde_json::to_vec(&cat_results)
                .map_err(|e| Error::from_reason(format!("Serialize error: {}", e)))?;
            let compressed = zstd_bytes(&cat_json)?;
            categories_data.push(AltCategoryResult {
                category: category.clone(),
                filename,
                compressed_data: compressed.into(),
                relation_count: cat_rel_count,
            });
        }
    }

    let meta = serde_json::json!({
        "_v": "25.8.3",
        "categories": meta_categories,
        "total_relations": total_relations,
    });
    let meta_bytes = serde_json::to_vec(&meta)
        .map_err(|e| Error::from_reason(format!("Serialize error: {}", e)))?;
    let meta_compressed = zstd_bytes(&meta_bytes)?;

    Ok(AltLinkerResult {
        categories_data,
        meta_data: meta_compressed.into(),
        total_relations,
    })
}

// D-375 PRODUCER_OMIT_ZERO_RELATION_FRAME acceptance tests. These run LOCALLY via
// `cargo test` (where Node's napi_* symbols are link-resolvable). They are intentionally
// NOT a Linux CI gate: a standalone cargo-test executable for this napi crate cannot
// resolve napi_* runtime symbols on Linux (provided only by the node host when the .node
// is loaded), so it fails to link. The omit is CI-enforced on the REAL built .node by the
// "Alt-Linker Omit NAPI Binding Gate" (scripts/factory/verify-alt-omit-binding.mjs), which
// exercises BOTH producer paths: the legacy Buffer-input `compute_alt_relations_inner`
// and the direct-shard `compute_alt_relations_from_dir`.
#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal entity Value with an id, category, tags, and a fixed fni_score.
    fn ent(id: &str, cat: &str, tags: &[&str]) -> Value {
        serde_json::json!({
            "id": id,
            "primary_category": cat,
            "tags": tags,
            "fni_score": 1.0,
        })
    }

    /// A zero-relation category (empty tags) + a real category (identical tags).
    fn fixture() -> Vec<Value> {
        vec![
            ent("e1", "empty-cat", &[]),
            ent("e2", "empty-cat", &[]),
            ent("r1", "real-cat", &["nlp", "text"]),
            ent("r2", "real-cat", &["nlp", "text"]),
        ]
    }

    /// Decompress a meta_data / compressed_data Buffer (derefs to [u8]) as JSON.
    fn decode(buf: &[u8]) -> Value {
        let raw = zstd::decode_all(buf).expect("zstd decode");
        serde_json::from_slice(&raw).expect("json parse")
    }

    /// Assert the omit contract on a computed result: real-cat frame present,
    /// empty-cat frame absent, but BOTH categories in the meta census.
    fn assert_omit(result: &AltLinkerResult) {
        let emitted: Vec<&str> = result
            .categories_data
            .iter()
            .map(|c| c.category.as_str())
            .collect();
        assert!(emitted.contains(&"real-cat"), "real-cat frame must be emitted");
        assert!(!emitted.contains(&"empty-cat"), "empty-cat frame must be OMITTED (D-375)");
        let real = result
            .categories_data
            .iter()
            .find(|c| c.category == "real-cat")
            .expect("real-cat present");
        assert!(real.relation_count > 0, "real-cat must carry relations");
        assert!(real.compressed_data.len() >= 16, "real frame must be a full zstd frame");

        // Census: BOTH categories in meta.categories, empty-cat at relation_count=0.
        let meta = decode(&result.meta_data[..]);
        let cats = meta["categories"].as_array().expect("categories array");
        let empty_meta = cats
            .iter()
            .find(|c| c["category"] == "empty-cat")
            .expect("empty-cat still in census");
        assert_eq!(empty_meta["relation_count"], 0, "empty-cat census relation_count=0");
        assert_eq!(empty_meta["entity_count"], 2, "empty-cat census entity_count=2");
        let real_meta = cats
            .iter()
            .find(|c| c["category"] == "real-cat")
            .expect("real-cat in census");
        assert!(real_meta["relation_count"].as_u64().unwrap() > 0);
        assert_eq!(real_meta["entity_count"], 2);
        assert!(result.total_relations > 0, "total_relations must be > 0");
    }

    #[test]
    fn inner_omits_zero_relation_category() {
        let entities = fixture();
        let result = compute_alt_relations_inner(&entities).expect("inner ok");
        assert_omit(&result);
    }

    #[test]
    fn from_dir_omits_zero_relation_category() {
        // Direct-shard path: write a plain-JSON `part-*` shard (discover_shards accepts
        // .json) so the REAL compute_alt_relations_from_dir -> for_each_shard path runs.
        let dir = std::env::temp_dir().join("alt_omit_from_dir_shards");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mk shard dir");
        let entities = fixture();
        std::fs::write(
            dir.join("part-000.json"),
            serde_json::to_vec(&entities).unwrap(),
        )
        .expect("write shard");
        let out = std::env::temp_dir().join("alt_omit_from_dir_out");
        let result = compute_alt_relations_from_dir(
            dir.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
        )
        .expect("from_dir ok");
        assert_omit(&result);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
