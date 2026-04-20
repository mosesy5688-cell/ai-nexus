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

/// Extract "id" value from raw JSON bytes without full parse.
/// Scans for `"id":"` or `"id" :  "` pattern, returns the value.
fn extract_id_from_raw(raw: &[u8]) -> &str {
    // Fast path: find b'"id"' then scan for the value
    let needle = b"\"id\"";
    let mut pos = 0;
    while pos + needle.len() < raw.len() {
        if let Some(found) = raw[pos..].windows(needle.len()).position(|w| w == needle) {
            let after_key = pos + found + needle.len();
            // Skip whitespace and colon
            let mut i = after_key;
            while i < raw.len() && (raw[i] == b' ' || raw[i] == b':' || raw[i] == b'\t' || raw[i] == b'\n' || raw[i] == b'\r') { i += 1; }
            if i < raw.len() && raw[i] == b'"' {
                let val_start = i + 1;
                let mut val_end = val_start;
                while val_end < raw.len() && raw[val_end] != b'"' {
                    if raw[val_end] == b'\\' { val_end += 1; }
                    val_end += 1;
                }
                if let Ok(s) = std::str::from_utf8(&raw[val_start..val_end]) {
                    if !s.is_empty() { return s; }
                }
            }
            pos = after_key;
        } else {
            break;
        }
    }
    ""
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

/// V26.9: AsyncTask — Phase 1-4 on libuv worker thread. Event loop stays alive.
#[napi(object)]
pub struct RegistryStatsResult {
    pub entity_count: u32,
    pub shard_count: u32,
    pub routed_count: u32,
    pub delta_shard_count: u32,
    pub duration_ms: u32,
}

pub struct StatsTask { shard_dir: String, artifact_dir: String, delta_dir: String, output_dir: String }

impl napi::Task for StatsTask {
    type Output = RegistryStatsResult;
    type JsValue = RegistryStatsResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let start = std::time::Instant::now();
        let shard_files = discover_shards(&self.shard_dir)?;
        let shard_count = shard_files.len() as u32;

        // Phase 1: slim serde extract
        let mut scores: Vec<(String, f64)> = Vec::new();
        let mut registry_map: HashMap<String, u32> = HashMap::new();
        for (fi, fp) in shard_files.iter().enumerate() {
            let ss = match nxvf_core::extract_scores_from_shard(fp) {
                Ok(s) => s, Err(e) => { eprintln!("[RUST-STATS] Skipping {}: {}", fp, e); continue; }
            };
            let si = std::path::Path::new(fp).file_stem().and_then(|s| s.to_str())
                .and_then(|s| s.strip_prefix("part-")).and_then(|s| s.parse::<u32>().ok()).unwrap_or(fi as u32);
            for (id, score) in ss { registry_map.insert(id.clone(), si); scores.push((id, score)); }
            if (fi + 1) % 50 == 0 { eprintln!("[RUST-STATS] Phase 1: {}/{} shards, {} entities", fi+1, shard_count, scores.len()); }
        }
        let entity_count = scores.len() as u32;
        eprintln!("[RUST-STATS] Phase 1 done: {} entities from {} shards ({}ms)", entity_count, shard_count, start.elapsed().as_millis());

        // Phase 2: percentile → rankings.tsv
        eprintln!("[RUST-STATS] Phase 2: percentile rankings...");
        let rankings = percentile::calculate_rankings(&scores);
        fs::create_dir_all(&self.output_dir).ok();
        let mut rw = BufWriter::new(fs::File::create(format!("{}/rankings.tsv", self.output_dir))
            .map_err(|e| Error::from_reason(format!("rankings.tsv: {}", e)))?);
        for (id, pct) in &rankings { write!(rw, "{}\t{}\n", id, pct).ok(); }
        rw.flush().ok();
        drop(scores); drop(rankings);
        eprintln!("[RUST-STATS] Phase 2 done ({}ms)", start.elapsed().as_millis());

        // Phase 3: route artifacts → deltas (in-memory registry_map)
        eprintln!("[RUST-STATS] Phase 3: delta routing...");
        fs::create_dir_all(&self.delta_dir).ok();
        if let Ok(entries) = fs::read_dir(&self.delta_dir) {
            for entry in entries.flatten() { fs::remove_file(entry.path()).ok(); }
        }
        let mut writers: HashMap<u32, BufWriter<fs::File>> = HashMap::new();
        let mut routed = 0u32;
        let mut af: Vec<String> = Vec::new();
        if let Ok(entries) = fs::read_dir(&self.artifact_dir) {
            for entry in entries.flatten() {
                let n = entry.file_name().to_string_lossy().to_string();
                if n.starts_with("shard-") && (n.ends_with(".json.zst") || n.ends_with(".json.gz") || n.ends_with(".json")) {
                    af.push(entry.path().to_string_lossy().to_string());
                }
            }
        }
        af.sort();
        // Diagnostic: check RSS before Phase 3
        if let Ok(status) = fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if line.starts_with("VmRSS:") || line.starts_with("VmSize:") {
                    eprintln!("[RUST-DIAG] {}", line.trim());
                }
            }
        }
        eprintln!("[RUST-DELTA] Found {} artifact shards", af.len());
        for (ai, ap) in af.iter().enumerate() {
            let before = routed;
            let r = nxvf_core::for_each_raw_entity(ap, |raw| {
                let id = extract_id_from_raw(raw);
                if id.is_empty() { return Ok(()); }
                if let Some(&si) = registry_map.get(id) {
                    let w = writers.entry(si).or_insert_with(|| {
                        BufWriter::new(fs::File::create(format!("{}/reg-{}.jsonl", self.delta_dir, si)).expect("delta file"))
                    });
                    w.write_all(raw).ok();
                    w.write_all(b"\n").ok();
                    routed += 1;
                }
                Ok(())
            });
            match r {
                Ok(n) => eprintln!("[RUST-DELTA] {}/{}: {} entities, {} routed ({}ms)", ai+1, af.len(), n, routed-before, start.elapsed().as_millis()),
                Err(e) => eprintln!("[RUST-DELTA] {}/{} ERROR: {}", ai+1, af.len(), e),
            }
        }
        let dsc = writers.len() as u32;
        for (_, mut w) in writers { w.flush().ok(); }
        drop(registry_map);

        // Phase 4: fni-thresholds.json
        if let Ok(f) = fs::File::create(format!("{}/fni-thresholds.json", self.output_dir)) {
            write!(BufWriter::new(f), "{{\"_count\":{}}}\n", entity_count).ok();
        }
        eprintln!("[RUST-STATS] Complete: {} entities, {} routed → {} deltas ({}ms)", entity_count, routed, dsc, start.elapsed().as_millis());
        Ok(RegistryStatsResult { entity_count, shard_count, routed_count: routed, delta_shard_count: dsc, duration_ms: start.elapsed().as_millis() as u32 })
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> { Ok(output) }
}

#[napi]
pub fn build_stats_and_route_deltas(shard_dir: String, artifact_dir: String, delta_dir: String, output_dir: String,
) -> napi::bindgen_prelude::AsyncTask<StatsTask> {
    napi::bindgen_prelude::AsyncTask::new(StatsTask { shard_dir, artifact_dir, delta_dir, output_dir })
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

