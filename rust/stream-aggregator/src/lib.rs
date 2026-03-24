use napi::bindgen_prelude::*;
use napi_derive::napi;
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

