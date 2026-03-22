use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::fs;
use std::io::{BufReader, Read};
use flate2::read::GzDecoder;

mod nxvf;
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

/// Discover shard files with format priority: .bin > .json.gz > .json
/// Prevents duplicate entities when stale legacy files coexist with binary shards.
fn discover_shards(dir: &str) -> Result<Vec<String>> {
    use std::collections::BTreeMap;

    // Map shard index (e.g. "part-000") → (priority, full_path)
    // Lower priority number = preferred format
    let mut shard_map: BTreeMap<String, (u8, String)> = BTreeMap::new();

    let entries = fs::read_dir(dir)
        .map_err(|e| Error::from_reason(format!("Cannot read shard dir: {}", e)))?;

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("part-") {
            continue;
        }

        let priority = if name.ends_with(".bin") {
            0u8
        } else if name.ends_with(".json.gz") {
            1
        } else if name.ends_with(".json") {
            2
        } else {
            continue;
        };

        let index = name.split('.').next().unwrap_or("").to_string();
        let path = entry.path().to_string_lossy().to_string();

        let dominated = match shard_map.get(&index) {
            Some((existing, _)) => priority < *existing,
            None => true,
        };
        if dominated {
            shard_map.insert(index, (priority, path));
        }
    }

    let files: Vec<String> = shard_map.into_values().map(|(_, p)| p).collect();
    let bin_count = files.iter().filter(|f| f.ends_with(".bin")).count();
    let gz_count = files.len() - bin_count;
    eprintln!(
        "[RUST-STREAM] Discovered {} shards ({} binary, {} json.gz/json)",
        files.len(),
        bin_count,
        gz_count
    );
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
    // V25.8.3: Route .bin shards to native NXVF decoder (AES-CTR + Zstd)
    if path.ends_with(".bin") {
        return nxvf::read_binary_shard(path);
    }

    let file = fs::File::open(path)
        .map_err(|e| Error::from_reason(format!("Cannot open {}: {}", path, e)))?;

    // Read entire file to string, then sanitize malformed \u escapes before parsing.
    // JS JSON.stringify can produce \uXXXX sequences that serde_json rejects
    // (e.g. lone surrogates \uD800-\uDFFF, or truncated escapes near buffer boundaries).
    let mut raw = String::new();
    if path.ends_with(".gz") {
        let mut decoder = GzDecoder::new(BufReader::new(file));
        decoder.read_to_string(&mut raw)
            .map_err(|e| Error::from_reason(format!("Decompress error in {}: {}", path, e)))?;
    } else {
        BufReader::new(file).read_to_string(&mut raw)
            .map_err(|e| Error::from_reason(format!("Read error in {}: {}", path, e)))?;
    }

    let sanitized = sanitize_json_escapes(&raw);
    let data: serde_json::Value = serde_json::from_str(&sanitized)
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

/// Compress a file with Zstd, writing to output path. Removes input file on success.
/// Used by merge-batches.js to replace WASM zstd-codec (which leaks linear memory).
#[napi]
pub fn zstd_compress_file(input_path: String, output_path: String, level: i32) -> Result<u32> {
    let input = fs::read(&input_path)
        .map_err(|e| Error::from_reason(format!("Cannot read {}: {}", input_path, e)))?;
    let compressed = zstd::encode_all(input.as_slice(), level)
        .map_err(|e| Error::from_reason(format!("Zstd compress failed: {}", e)))?;
    let size = compressed.len() as u32;
    fs::write(&output_path, &compressed)
        .map_err(|e| Error::from_reason(format!("Cannot write {}: {}", output_path, e)))?;
    fs::remove_file(&input_path).ok(); // Best-effort cleanup
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

/// Fix malformed \uXXXX escape sequences that JS serializers can produce.
/// Replaces incomplete \u escapes (fewer than 4 hex digits) with \uFFFD (replacement char).
pub(crate) fn sanitize_json_escapes(input: &str) -> String {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut result = Vec::with_capacity(len);
    let mut i = 0;

    let mut in_string = false;
    let mut escaped = false;

    while i < len {
        let b = bytes[i];
        if escaped {
            // Previous char was \, this char is the escape type
            result.push(b);
            if b == b'u' && in_string {
                // \u found inside string — check for 4 hex digits
                if i + 4 < len && bytes[i + 1..i + 5].iter().all(|c| c.is_ascii_hexdigit()) {
                    result.extend_from_slice(&bytes[i + 1..i + 5]);
                    i += 5;
                } else {
                    // Malformed — replace: overwrite the 'u' with uFFFD
                    let u_pos = result.len() - 1;
                    result[u_pos] = b'u';
                    result.extend_from_slice(b"FFFD");
                    // Skip any partial hex digits
                    i += 1;
                    while i < len && bytes[i].is_ascii_hexdigit() {
                        i += 1;
                    }
                }
            } else {
                i += 1;
            }
            escaped = false;
            continue;
        }
        if b == b'"' && in_string {
            in_string = false;
        } else if b == b'"' {
            in_string = true;
        } else if b == b'\\' && in_string {
            escaped = true;
            result.push(b);
            i += 1;
            continue;
        }
        result.push(b);
        i += 1;
    }

    // Safe: we only replaced ASCII sequences, preserving valid UTF-8
    String::from_utf8(result).unwrap_or_else(|_| input.to_string())
}
