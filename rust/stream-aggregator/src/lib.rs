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

/// V26.6: Build global registry stats (Pass 1) entirely in Rust.
/// Streams registry shards via nxvf-core, extracts (id, fni_score, shard_idx),
/// computes percentile rankings, writes output files. Zero JS heap pressure —
/// body_content never crosses the FFI boundary.
#[napi(object)]
pub struct RegistryStatsResult {
    pub entity_count: u32,
    pub shard_count: u32,
    pub duration_ms: u32,
}

#[napi]
pub fn build_registry_stats(
    shard_dir: String,
    output_dir: String,
) -> Result<RegistryStatsResult> {
    let start = std::time::Instant::now();

    let shard_files = discover_shards(&shard_dir)?;
    let shard_count = shard_files.len() as u32;

    // Phase 1: Extract (id, fni_score) + build registry map (id → shard_idx)
    let mut scores: Vec<(String, f64)> = Vec::new();
    let mut registry_map: HashMap<String, u32> = HashMap::new();

    for (file_idx, file_path) in shard_files.iter().enumerate() {
        let entities = match load_shard_entities(file_path) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[RUST-STATS] Skipping corrupted shard {}: {}", file_path, e);
                continue;
            }
        };
        let shard_idx = std::path::Path::new(file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("part-"))
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(file_idx as u32);

        for e in &entities {
            let id = e.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() { continue; }
            let score = e.get("fni_score").and_then(|v| v.as_f64())
                .or_else(|| e.get("fni").and_then(|v| v.as_f64()))
                .unwrap_or(0.0);
            scores.push((id.to_string(), score));
            registry_map.insert(id.to_string(), shard_idx);
        }
        // entities dropped here — O(1 shard) memory in Rust
    }

    let entity_count = scores.len() as u32;

    // Phase 2: Calculate percentile rankings
    let rankings = percentile::calculate_rankings(&scores);

    // Phase 3: Write output files
    fs::create_dir_all(&output_dir).ok();

    // rankings.json: { "id": percentile, ... }
    let rankings_obj: HashMap<&str, u8> = rankings.iter()
        .map(|(k, v)| (k.as_str(), *v))
        .collect();
    let rankings_path = format!("{}/rankings.json", output_dir);
    let rankings_file = fs::File::create(&rankings_path)
        .map_err(|e| Error::from_reason(format!("Cannot create rankings.json: {}", e)))?;
    serde_json::to_writer(BufWriter::new(rankings_file), &rankings_obj)
        .map_err(|e| Error::from_reason(format!("Write rankings.json: {}", e)))?;

    // registry-map.json: { "id": shard_idx, ... }
    let reg_path = format!("{}/.registry-map.json", output_dir);
    let reg_file = fs::File::create(&reg_path)
        .map_err(|e| Error::from_reason(format!("Cannot create registry-map.json: {}", e)))?;
    serde_json::to_writer(BufWriter::new(reg_file), &registry_map)
        .map_err(|e| Error::from_reason(format!("Write registry-map.json: {}", e)))?;

    // fni-thresholds.json (for late-binding)
    let mut sorted_scores: Vec<f64> = scores.iter().map(|(_, s)| *s).collect();
    sorted_scores.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let mut score_to_rank: HashMap<u64, usize> = HashMap::new();
    for (i, &s) in sorted_scores.iter().enumerate() {
        score_to_rank.entry(s.to_bits()).or_insert(i);
    }
    let score_percentiles: HashMap<String, u32> = score_to_rank.iter()
        .map(|(bits, rank)| {
            let s = f64::from_bits(*bits);
            let pct = ((1.0 - *rank as f64 / entity_count as f64) * 100.0).round() as u32;
            (format!("{}", s), pct)
        })
        .collect();
    let thresholds_path = format!("{}/fni-thresholds.json", output_dir);
    let thresholds = serde_json::json!({
        "_ts": format!("{:?}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()),
        "_count": entity_count,
        "scorePercentiles": score_percentiles
    });
    let th_file = fs::File::create(&thresholds_path)
        .map_err(|e| Error::from_reason(format!("Cannot create fni-thresholds.json: {}", e)))?;
    serde_json::to_writer_pretty(BufWriter::new(th_file), &thresholds)
        .map_err(|e| Error::from_reason(format!("Write fni-thresholds.json: {}", e)))?;

    eprintln!("[RUST-STATS] Complete: {} entities from {} shards in {}ms",
        entity_count, shard_count, start.elapsed().as_millis());

    Ok(RegistryStatsResult {
        entity_count,
        shard_count,
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

