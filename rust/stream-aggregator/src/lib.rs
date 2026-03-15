use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::fs;
use std::io::BufReader;
use flate2::read::GzDecoder;

mod percentile;
mod project;

#[napi(object)]
pub struct AggregateResult {
    pub entity_count: u32,
    pub shard_count: u32,
    pub duration_ms: u32,
}

/// Main function exposed via N-API.
/// Reads JSON.gz shard files, extracts FNI scores, calculates global
/// percentile rankings, projects entities to slim format, writes NDJSON.
#[napi]
pub fn stream_aggregate(shard_dir: String, output_path: String) -> Result<AggregateResult> {
    let start = std::time::Instant::now();

    // Phase 1: Discover shard files (part-*.json.gz)
    let shard_files = discover_shards(&shard_dir)?;

    // Phase 2: Extract all (id, fni_score) from shards — O(1) memory per shard
    let scores = extract_scores(&shard_files)?;

    // Phase 3: Calculate global percentile rankings
    let rankings = percentile::calculate_rankings(&scores);

    // Phase 4: Re-read shards, project to slim format, write NDJSON
    let entity_count = project::project_and_write(&shard_files, &rankings, &output_path)?;

    Ok(AggregateResult {
        entity_count: entity_count as u32,
        shard_count: shard_files.len() as u32,
        duration_ms: start.elapsed().as_millis() as u32,
    })
}

fn discover_shards(dir: &str) -> Result<Vec<String>> {
    let mut files: Vec<String> = fs::read_dir(dir)
        .map_err(|e| Error::from_reason(format!("Cannot read shard dir: {}", e)))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("part-") && (name.ends_with(".json.gz") || name.ends_with(".json"))
            {
                Some(entry.path().to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect();
    files.sort();
    Ok(files)
}

fn extract_scores(files: &[String]) -> Result<Vec<(String, f64)>> {
    let mut scores = Vec::new();
    for file_path in files {
        let entities = match load_shard_entities(file_path) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[RUST-STREAM] Skipping corrupted shard {}: {}", file_path, e);
                continue;
            }
        };
        for e in entities {
            let id = e.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let score = e
                .get("fni_score")
                .and_then(|v| v.as_f64())
                .or_else(|| e.get("fni").and_then(|v| v.as_f64()))
                .unwrap_or(0.0);
            scores.push((id.to_string(), score));
        }
    }
    Ok(scores)
}

pub(crate) fn load_shard_entities(path: &str) -> Result<Vec<serde_json::Value>> {
    let file = fs::File::open(path)
        .map_err(|e| Error::from_reason(format!("Cannot open {}: {}", path, e)))?;

    let data: serde_json::Value = if path.ends_with(".gz") {
        let decoder = GzDecoder::new(BufReader::new(file));
        serde_json::from_reader(BufReader::new(decoder))
    } else {
        serde_json::from_reader(BufReader::new(file))
    }
    .map_err(|e| Error::from_reason(format!("JSON parse error in {}: {}", path, e)))?;

    // Handle both { "entities": [...] } and [...] formats
    if let Some(arr) = data.as_array() {
        Ok(arr.clone())
    } else if let Some(entities) = data.get("entities").and_then(|v| v.as_array()) {
        Ok(entities.clone())
    } else {
        Ok(vec![data])
    }
}
