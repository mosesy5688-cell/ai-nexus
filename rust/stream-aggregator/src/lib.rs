use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, BufWriter, Write};

mod fusion;
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

/// Discover shard files — delegates to nxvf-core.
fn discover_shards(dir: &str) -> Result<Vec<String>> {
    nxvf_core::discover_shards(dir).map_err(|e| Error::from_reason(e))
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
    nxvf_core::load_shard_entities(path).map_err(|e| Error::from_reason(e))
}

/// V55.9: Streaming file compression with O(1) memory via zstd::Encoder.
/// Replaces buffer-based compress (which OOMs on 2GB+ files).
/// Removes input file on success.
#[napi]
pub fn zstd_compress_file(input_path: String, output_path: String, level: i32) -> Result<u32> {
    let input_file = fs::File::open(&input_path)
        .map_err(|e| Error::from_reason(format!("Cannot open {}: {}", input_path, e)))?;
    let output_file = fs::File::create(&output_path)
        .map_err(|e| Error::from_reason(format!("Cannot create {}: {}", output_path, e)))?;

    let mut encoder = zstd::Encoder::new(BufWriter::new(output_file), level)
        .map_err(|e| Error::from_reason(format!("Zstd encoder init: {}", e)))?;

    std::io::copy(&mut BufReader::new(input_file), &mut encoder)
        .map_err(|e| Error::from_reason(format!("Streaming compress: {}", e)))?;

    encoder.finish()
        .map_err(|e| Error::from_reason(format!("Zstd finalize: {}", e)))?;

    let size = fs::metadata(&output_path)
        .map_err(|e| Error::from_reason(format!("Stat: {}", e)))?.len() as u32;

    fs::remove_file(&input_path).ok();
    Ok(size)
}

/// V55.9: Streaming file decompression with O(1) memory.
#[napi]
pub fn zstd_decompress_file(input_path: String, output_path: String) -> Result<u32> {
    let input_file = fs::File::open(&input_path)
        .map_err(|e| Error::from_reason(format!("Cannot open {}: {}", input_path, e)))?;
    let output_file = fs::File::create(&output_path)
        .map_err(|e| Error::from_reason(format!("Cannot create {}: {}", output_path, e)))?;

    let mut decoder = zstd::Decoder::new(BufReader::new(input_file))
        .map_err(|e| Error::from_reason(format!("Zstd decoder init: {}", e)))?;

    let mut writer = BufWriter::new(output_file);
    std::io::copy(&mut decoder, &mut writer)
        .map_err(|e| Error::from_reason(format!("Streaming decompress: {}", e)))?;
    writer.flush()
        .map_err(|e| Error::from_reason(format!("Flush: {}", e)))?;

    let size = fs::metadata(&output_path)
        .map_err(|e| Error::from_reason(format!("Stat: {}", e)))?.len() as u32;
    Ok(size)
}

/// V26.5: Route 2/4 artifact entities to per-registry-shard delta JSONL files.
/// Replaces JS preProcessDeltas — no V8 string limit, no GC pressure,
/// streaming I/O via BufWriter. O(1) memory per entity.
#[napi(object)]
pub struct RouteDeltaResult {
    pub routed_count: u32,
    pub shard_count: u32,
    pub duration_ms: u32,
}

#[napi]
pub fn route_artifacts_to_deltas(
    artifact_dir: String,
    registry_map_path: String,
    delta_dir: String,
) -> Result<RouteDeltaResult> {
    let start = std::time::Instant::now();

    // Load registry map: id → shard_index
    let map_data = fs::read_to_string(&registry_map_path)
        .map_err(|e| Error::from_reason(format!("Cannot read registry map: {}", e)))?;
    let registry_map: HashMap<String, u32> = serde_json::from_str(&map_data)
        .map_err(|e| Error::from_reason(format!("Cannot parse registry map: {}", e)))?;

    // Ensure delta dir exists and is clean
    fs::create_dir_all(&delta_dir).ok();
    if let Ok(entries) = fs::read_dir(&delta_dir) {
        for entry in entries.flatten() {
            fs::remove_file(entry.path()).ok();
        }
    }

    // Open BufWriters lazily per shard index
    let mut writers: HashMap<u32, BufWriter<fs::File>> = HashMap::new();
    let mut routed = 0u32;

    // Discover and process artifact shards
    let mut artifact_files: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&artifact_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("shard-") && (name.ends_with(".json.zst") || name.ends_with(".json.gz") || name.ends_with(".json")) {
                artifact_files.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    artifact_files.sort();

    for artifact_path in &artifact_files {
        let entities = match nxvf_core::load_shard_entities(artifact_path) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[RUST-DELTA] Skipping {}: {}", artifact_path, e);
                continue;
            }
        };

        for entity_val in &entities {
            // Extract enriched entity or use raw
            let incoming = entity_val.get("enriched").unwrap_or(entity_val);
            let id = incoming.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() { continue; }

            if let Some(&shard_idx) = registry_map.get(id) {
                let writer = writers.entry(shard_idx).or_insert_with(|| {
                    let path = format!("{}/reg-{}.jsonl", delta_dir, shard_idx);
                    BufWriter::new(fs::File::create(&path).expect("Cannot create delta file"))
                });
                serde_json::to_writer(&mut *writer, incoming).ok();
                writer.write_all(b"\n").ok();
                routed += 1;
            }
        }

        if routed % 50000 == 0 && routed > 0 {
            eprintln!("[RUST-DELTA] {} entities routed...", routed);
        }
    }

    // Flush all writers
    let shard_count = writers.len() as u32;
    for (_, mut w) in writers {
        w.flush().ok();
    }

    eprintln!("[RUST-DELTA] Complete: {} entities → {} delta files in {}ms",
        routed, shard_count, start.elapsed().as_millis());

    Ok(RouteDeltaResult {
        routed_count: routed,
        shard_count,
        duration_ms: start.elapsed().as_millis() as u32,
    })
}

/// V26.7: Pass 1 + delta routing in one Rust call.
/// 1. Stream registry shards → build (id, fni_score, shard_idx) maps
/// 2. Calculate percentile rankings → write rankings.tsv for JS
/// 3. Route artifact deltas using in-memory registry_map (no JSON roundtrip)
/// 4. Write fni-thresholds.json
/// Zero JS heap for body_content or registry_map.
#[napi(object)]
pub struct RegistryStatsResult {
    pub entity_count: u32,
    pub shard_count: u32,
    pub routed_count: u32,
    pub delta_shard_count: u32,
    pub duration_ms: u32,
}

#[napi]
pub fn build_stats_and_route_deltas(
    shard_dir: String,
    artifact_dir: String,
    delta_dir: String,
    output_dir: String,
) -> Result<RegistryStatsResult> {
    let start = std::time::Instant::now();
    let shard_files = discover_shards(&shard_dir)?;
    let shard_count = shard_files.len() as u32;

    // Phase 1: Stream registry → slim extract (id, fni_score) per entity
    // Uses extract_scores_from_shard — serde skips body_content, O(1 entity) memory
    let mut scores: Vec<(String, f64)> = Vec::new();
    let mut registry_map: HashMap<String, u32> = HashMap::new();
    for (file_idx, file_path) in shard_files.iter().enumerate() {
        let shard_scores = match nxvf_core::extract_scores_from_shard(file_path) {
            Ok(s) => s,
            Err(e) => { eprintln!("[RUST-STATS] Skipping {}: {}", file_path, e); continue; }
        };
        let shard_idx = std::path::Path::new(file_path).file_stem()
            .and_then(|s| s.to_str()).and_then(|s| s.strip_prefix("part-"))
            .and_then(|s| s.parse::<u32>().ok()).unwrap_or(file_idx as u32);
        for (id, score) in shard_scores {
            registry_map.insert(id.clone(), shard_idx);
            scores.push((id, score));
        }
    }
    let entity_count = scores.len() as u32;
    eprintln!("[RUST-STATS] Phase 1: {} entities from {} shards", entity_count, shard_count);

    // Phase 2: Percentile rankings → rankings.tsv
    let rankings = percentile::calculate_rankings(&scores);
    fs::create_dir_all(&output_dir).ok();
    let rankings_path = format!("{}/rankings.tsv", output_dir);
    let mut rw = BufWriter::new(fs::File::create(&rankings_path)
        .map_err(|e| Error::from_reason(format!("rankings.tsv: {}", e)))?);
    for (id, pct) in &rankings { write!(rw, "{}\t{}\n", id, pct).ok(); }
    rw.flush().ok();
    drop(scores); drop(rankings);

    // Phase 3: Route artifacts to deltas using in-memory registry_map
    fs::create_dir_all(&delta_dir).ok();
    if let Ok(entries) = fs::read_dir(&delta_dir) {
        for entry in entries.flatten() { fs::remove_file(entry.path()).ok(); }
    }
    let mut writers: HashMap<u32, BufWriter<fs::File>> = HashMap::new();
    let mut routed = 0u32;
    let mut artifact_files: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&artifact_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("shard-") && (name.ends_with(".json.zst") || name.ends_with(".json.gz") || name.ends_with(".json")) {
                artifact_files.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    artifact_files.sort();
    for artifact_path in &artifact_files {
        let route_result = nxvf_core::for_each_entity_in_file(artifact_path, |entity_val| {
            let incoming = entity_val.get("enriched").unwrap_or(&entity_val);
            let id = incoming.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() { return Ok(()); }
            if let Some(&shard_idx) = registry_map.get(id) {
                let writer = writers.entry(shard_idx).or_insert_with(|| {
                    let path = format!("{}/reg-{}.jsonl", delta_dir, shard_idx);
                    BufWriter::new(fs::File::create(&path).expect("Cannot create delta file"))
                });
                serde_json::to_writer(&mut *writer, incoming).ok();
                writer.write_all(b"\n").ok();
                routed += 1;
            }
            Ok(())
        });
        if let Err(e) = route_result {
            eprintln!("[RUST-DELTA] Skipping {}: {}", artifact_path, e);
        }
    }
    let delta_shard_count = writers.len() as u32;
    for (_, mut w) in writers { w.flush().ok(); }
    drop(registry_map);

    // Phase 4: fni-thresholds.json
    let thresholds_path = format!("{}/fni-thresholds.json", output_dir);
    let th = serde_json::json!({ "_ts": start.elapsed().as_secs(), "_count": entity_count });
    if let Ok(f) = fs::File::create(&thresholds_path) {
        serde_json::to_writer_pretty(BufWriter::new(f), &th).ok();
    }

    eprintln!("[RUST-STATS] Complete: {} entities, {} routed → {} delta shards ({}ms)",
        entity_count, routed, delta_shard_count, start.elapsed().as_millis());

    Ok(RegistryStatsResult {
        entity_count, shard_count, routed_count: routed, delta_shard_count,
        duration_ms: start.elapsed().as_millis() as u32,
    })
}

/// Compress a Buffer with Zstd, returning compressed Buffer.
/// Zero-copy NAPI binding — no WASM, no linear memory leak.
#[napi]
pub fn zstd_compress_buffer(data: Buffer, level: i32) -> Result<Buffer> {
    let compressed = zstd::encode_all(data.as_ref(), level)
        .map_err(|e| Error::from_reason(format!("Zstd compress failed: {}", e)))?;
    Ok(Buffer::from(compressed))
}

/// Decompress a Zstd Buffer, returning decompressed Buffer.
#[napi]
pub fn zstd_decompress_buffer(data: Buffer) -> Result<Buffer> {
    let decompressed = zstd::decode_all(data.as_ref())
        .map_err(|e| Error::from_reason(format!("Zstd decompress failed: {}", e)))?;
    Ok(Buffer::from(decompressed))
}

