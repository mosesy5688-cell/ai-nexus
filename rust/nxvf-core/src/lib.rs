//! NXVF-Core: Shared shard reader for the AI-Nexus factory pipeline.
//!
//! Provides unified shard loading (NXVF V4.1 binary + JSON.gz + JSON),
//! shard discovery with format priority, and JSON sanitization.
//! Used by stream-aggregator, satellite-tasks, mesh-engine, fni-calc.

use aes::Aes256;
use cipher::{generic_array::GenericArray, KeyIvInit, StreamCipher};
use ctr::Ctr128BE;
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{BufReader, Read};
use std::sync::OnceLock;
use std::{fs, path::Path};

// ── NXVF V4.1 Constants ────────────────────────────────────────────

const HEADER_SIZE: usize = 29;
const NXVF_MAGIC: [u8; 4] = [0x4E, 0x58, 0x56, 0x46]; // "NXVF"
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
const GZIP_MAGIC: [u8; 2] = [0x1F, 0x8B];

type Aes256Ctr = Ctr128BE<Aes256>;

// ── AES Key Management ─────────────────────────────────────────────

static AES_KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();

fn get_aes_key() -> &'static Option<[u8; 32]> {
    AES_KEY.get_or_init(|| {
        let hex_str = std::env::var("AES_CRYPTO_KEY").ok()?;
        if hex_str.len() < 64 {
            return None;
        }
        let bytes = hex::decode(&hex_str[..64]).ok()?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        eprintln!("[NXVF-CORE] AES-256-CTR sovereign encryption enabled");
        Some(key)
    })
}

// ── NXVF Header ─────────────────────────────────────────────────────

struct NxvfHeader {
    offset_table_offset: u32,
    entity_count: u32,
    checksum: u32,
}

fn parse_header(data: &[u8]) -> Option<NxvfHeader> {
    if data.len() < HEADER_SIZE || data[0..4] != NXVF_MAGIC {
        return None;
    }
    Some(NxvfHeader {
        offset_table_offset: u32::from_le_bytes(data[7..11].try_into().ok()?),
        entity_count: u32::from_le_bytes(data[11..15].try_into().ok()?),
        checksum: u32::from_le_bytes(data[15..19].try_into().ok()?),
    })
}

// ── Payload Detection & Decryption ──────────────────────────────────

/// Detect raw JSON or Zstd magic to skip decryption.
fn is_valid_payload(buf: &[u8]) -> bool {
    if buf.len() < 2 {
        return false;
    }
    let (b0, b1) = (buf[0], buf[1]);
    // JSON object: {"
    if b0 == 0x7B && b1 == 0x22 {
        return true;
    }
    // JSON array: [{ or [[ or [" or []
    if b0 == 0x5B && (b1 == 0x7B || b1 == 0x5B || b1 == 0x22 || b1 == 0x5D) {
        return true;
    }
    // Zstd magic (4 bytes)
    if buf.len() >= 4 && buf[0..4] == ZSTD_MAGIC {
        return true;
    }
    false
}

/// Derive per-entity IV: SHA-256(key || shardName || String(offset))[0:16]
fn derive_entity_iv(key: &[u8; 32], shard_name: &str, offset: u32) -> [u8; 16] {
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(shard_name.as_bytes());
    hasher.update(offset.to_string().as_bytes());
    let digest = hasher.finalize();
    let mut iv = [0u8; 16];
    iv.copy_from_slice(&digest[..16]);
    iv
}

/// AES-256-CTR decrypt (symmetric — same as encrypt).
fn decrypt_payload(key: &[u8; 32], shard_name: &str, payload: &[u8], offset: u32) -> Vec<u8> {
    let iv = derive_entity_iv(key, shard_name, offset);
    let mut decrypted = payload.to_vec();
    let mut cipher = Aes256Ctr::new(
        GenericArray::from_slice(key),
        GenericArray::from_slice(&iv),
    );
    cipher.apply_keystream(&mut decrypted);
    decrypted
}

// ── Lightweight Field Extraction ───────────────────────────────────

/// Minimal struct for stats extraction — serde skips all other fields
/// (body_content, readme, html_readme etc.) without allocating memory.
#[derive(serde::Deserialize)]
struct SlimEntity {
    #[serde(default)]
    id: String,
    #[serde(default)]
    fni_score: Option<f64>,
    #[serde(default)]
    fni: Option<f64>,
}

/// Extract (id, fni_score) from a shard file. O(1 entity) memory —
/// each entity payload is decoded, slim-parsed (serde skips body_content),
/// then immediately dropped. No full-entity Vec accumulation.
pub fn extract_scores_from_shard(file_path: &str) -> Result<Vec<(String, f64)>, String> {
    if file_path.ends_with(".bin") {
        return extract_scores_from_binary_shard(file_path);
    }
    // JSON.gz/.json.zst/.json fallback — must full-parse (rare legacy path)
    let entities = load_shard_entities(file_path)?;
    Ok(entities.iter().filter_map(|e| {
        let id = e.get("id")?.as_str()?;
        if id.is_empty() { return None; }
        let score = e.get("fni_score").and_then(|v| v.as_f64())
            .or_else(|| e.get("fni").and_then(|v| v.as_f64())).unwrap_or(0.0);
        Some((id.to_string(), score))
    }).collect())
}

fn extract_scores_from_binary_shard(file_path: &str) -> Result<Vec<(String, f64)>, String> {
    let data = fs::read(file_path).map_err(|e| format!("Cannot read {}: {}", file_path, e))?;
    if data.len() < HEADER_SIZE || data[0..4] != NXVF_MAGIC {
        return Err(format!("Invalid NXVF: {}", file_path));
    }
    let header = parse_header(&data).ok_or_else(|| format!("Bad header: {}", file_path))?;
    let ot_start = header.offset_table_offset as usize;
    let ot_end = ot_start + header.entity_count as usize * 8;
    if ot_end > data.len() { return Err(format!("Offset table overflow: {}", file_path)); }
    let offset_table = &data[ot_start..ot_end];
    let shard_name = Path::new(file_path).file_name().and_then(|n| n.to_str()).unwrap_or("");
    let aes_key = get_aes_key();
    let mut results = Vec::with_capacity(header.entity_count as usize);

    for i in 0..header.entity_count as usize {
        let base = i * 8;
        let offset = u32::from_le_bytes(offset_table[base..base+4].try_into().unwrap_or([0;4]));
        let size = u32::from_le_bytes(offset_table[base+4..base+8].try_into().unwrap_or([0;4]));
        let end = offset as usize + size as usize;
        if end > data.len() { continue; }
        let mut payload = data[offset as usize..end].to_vec();
        if !is_valid_payload(&payload) {
            if let Some(key) = aes_key {
                let decrypted = decrypt_payload(key, shard_name, &payload, offset);
                if is_valid_payload(&decrypted) { payload = decrypted; }
            }
        }
        if payload.len() >= 4 && payload[0..4] == ZSTD_MAGIC {
            if let Ok(d) = zstd::decode_all(payload.as_slice()) { payload = d; }
        } else if payload.len() >= 2 && payload[0..2] == GZIP_MAGIC {
            let mut dec = GzDecoder::new(payload.as_slice());
            let mut d = Vec::new();
            if dec.read_to_end(&mut d).is_ok() { payload = d; }
        }
        // Slim parse: serde only allocates id + fni_score, skips body_content/readme/etc.
        if let Ok(e) = serde_json::from_slice::<SlimEntity>(&payload) {
            if !e.id.is_empty() {
                results.push((e.id, e.fni_score.or(e.fni).unwrap_or(0.0)));
            }
        }
        // payload dropped here — O(1 entity) memory
    }
    Ok(results)
}

// ── Public API ──────────────────────────────────────────────────────

/// Read and decode a binary NXVF V4.1 shard file into entity JSON values.
pub fn read_binary_shard(file_path: &str) -> Result<Vec<serde_json::Value>, String> {
    let data = fs::read(file_path)
        .map_err(|e| format!("Cannot read {}: {}", file_path, e))?;

    let header = parse_header(&data)
        .ok_or_else(|| format!("Invalid NXVF header: {}", file_path))?;

    let ot_start = header.offset_table_offset as usize;
    let ot_end = ot_start + header.entity_count as usize * 8;
    if ot_end > data.len() {
        return Err(format!("Offset table exceeds file size: {}", file_path));
    }
    let offset_table = &data[ot_start..ot_end];

    // Verify checksum (XOR of offset table uint32 words)
    let mut computed: u32 = 0;
    for chunk in offset_table.chunks_exact(4) {
        computed ^= u32::from_le_bytes(chunk.try_into().unwrap_or([0; 4]));
    }
    if computed != header.checksum {
        eprintln!("[NXVF-CORE] Checksum mismatch: {}", file_path);
    }

    let shard_name = Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let aes_key = get_aes_key();
    let mut entities = Vec::with_capacity(header.entity_count as usize);

    for i in 0..header.entity_count as usize {
        let base = i * 8;
        let offset =
            u32::from_le_bytes(offset_table[base..base + 4].try_into().unwrap_or([0; 4]));
        let size =
            u32::from_le_bytes(offset_table[base + 4..base + 8].try_into().unwrap_or([0; 4]));
        let end = offset as usize + size as usize;
        if end > data.len() {
            continue;
        }

        let mut payload = data[offset as usize..end].to_vec();

        // AES-CTR: try raw first, decrypt only if payload is not already valid
        if !is_valid_payload(&payload) {
            if let Some(key) = aes_key {
                let decrypted = decrypt_payload(key, shard_name, &payload, offset);
                if is_valid_payload(&decrypted) {
                    payload = decrypted;
                }
            }
        }

        // Zstd decompression
        if payload.len() >= 4 && payload[0..4] == ZSTD_MAGIC {
            match zstd::decode_all(payload.as_slice()) {
                Ok(decompressed) => payload = decompressed,
                Err(e) => {
                    eprintln!("[NXVF-CORE] Zstd error in {}[{}]: {}", shard_name, i, e);
                    continue;
                }
            }
        }
        // Gzip decompression
        else if payload.len() >= 2 && payload[0..2] == GZIP_MAGIC {
            let mut decoder = GzDecoder::new(payload.as_slice());
            let mut decompressed = Vec::new();
            match decoder.read_to_end(&mut decompressed) {
                Ok(_) => payload = decompressed,
                Err(e) => {
                    eprintln!("[NXVF-CORE] Gzip error in {}[{}]: {}", shard_name, i, e);
                    continue;
                }
            }
        }

        // JSON parse with sanitization fallback + forced-decrypt retry
        match serde_json::from_slice::<serde_json::Value>(&payload) {
            Ok(val) => entities.push(val),
            Err(e) => {
                let raw_str = String::from_utf8_lossy(&payload);
                let sanitized = sanitize_json_escapes(&raw_str);
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&sanitized) {
                    entities.push(val);
                    continue;
                }
                // Forced-decrypt retry: isValidPayload false positive (~1/65536)
                if let Some(key) = aes_key {
                    let raw = &data[offset as usize..end];
                    let mut retry = decrypt_payload(key, shard_name, raw, offset);
                    if retry.len() >= 4 && retry[0..4] == ZSTD_MAGIC {
                        if let Ok(d) = zstd::decode_all(retry.as_slice()) {
                            retry = d;
                        }
                    } else if retry.len() >= 2 && retry[0..2] == GZIP_MAGIC {
                        let mut dec = GzDecoder::new(retry.as_slice());
                        let mut d = Vec::new();
                        if dec.read_to_end(&mut d).is_ok() {
                            retry = d;
                        }
                    }
                    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&retry) {
                        entities.push(val);
                        continue;
                    }
                }
                eprintln!("[NXVF-CORE] Parse error {}[{}]: {}", shard_name, i, e);
            }
        }
    }

    eprintln!(
        "[NXVF-CORE] Read {} entities from {}",
        entities.len(),
        shard_name
    );
    Ok(entities)
}

/// Load entities from a shard file (any format: .bin, .json.gz, .json, .json.zst).
pub fn load_shard_entities(path: &str) -> Result<Vec<serde_json::Value>, String> {
    // NXVF binary shard
    if path.ends_with(".bin") {
        return read_binary_shard(path);
    }

    let file = fs::File::open(path)
        .map_err(|e| format!("Cannot open {}: {}", path, e))?;

    let mut raw = String::new();
    if path.ends_with(".json.zst") || path.ends_with(".zst") {
        // Zstd compressed
        let reader = BufReader::new(file);
        let mut decoder = zstd::Decoder::new(reader)
            .map_err(|e| format!("Zstd decoder init error in {}: {}", path, e))?;
        decoder
            .read_to_string(&mut raw)
            .map_err(|e| format!("Zstd decompress error in {}: {}", path, e))?;
    } else if path.ends_with(".gz") {
        let mut decoder = GzDecoder::new(BufReader::new(file));
        decoder
            .read_to_string(&mut raw)
            .map_err(|e| format!("Decompress error in {}: {}", path, e))?;
    } else {
        BufReader::new(file)
            .read_to_string(&mut raw)
            .map_err(|e| format!("Read error in {}: {}", path, e))?;
    }

    let sanitized = sanitize_json_escapes(&raw);
    let data: serde_json::Value = serde_json::from_str(&sanitized)
        .map_err(|e| format!("JSON parse error in {}: {}", path, e))?;

    // Handle both { "entities": [...] } and [...] formats
    if let Some(arr) = data.as_array() {
        Ok(arr.clone())
    } else if let Some(entities) = data.get("entities").and_then(|v| v.as_array()) {
        Ok(entities.clone())
    } else {
        Ok(vec![data])
    }
}

/// Discover shard files with format priority: .bin > .json.zst > .json.gz > .json
/// Prevents duplicate entities when stale legacy files coexist with binary shards.
pub fn discover_shards(dir: &str) -> Result<Vec<String>, String> {
    // Map shard index (e.g. "part-000") → (priority, full_path)
    let mut shard_map: BTreeMap<String, (u8, String)> = BTreeMap::new();

    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Cannot read shard dir {}: {}", dir, e))?;

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("part-") {
            continue;
        }

        let priority = if name.ends_with(".bin") {
            0u8
        } else if name.ends_with(".json.zst") {
            1
        } else if name.ends_with(".json.gz") {
            2
        } else if name.ends_with(".json") {
            3
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
    let zst_count = files.iter().filter(|f| f.ends_with(".json.zst")).count();
    let other_count = files.len() - bin_count - zst_count;
    eprintln!(
        "[NXVF-CORE] Discovered {} shards ({} binary, {} zst, {} json.gz/json)",
        files.len(),
        bin_count,
        zst_count,
        other_count
    );
    Ok(files)
}

/// Stream entities from a single shard file, calling `callback` per entity.
/// Memory: raw decompressed buffer + O(1 entity Value). No full Vec<Value> accumulation.
/// Each entity Value is dropped after callback returns.
pub fn for_each_entity_in_file<F>(file_path: &str, mut callback: F) -> Result<usize, String>
where
    F: FnMut(serde_json::Value) -> Result<(), String>,
{
    if file_path.ends_with(".bin") {
        let entities = read_binary_shard(file_path)?;
        let count = entities.len();
        for e in entities { callback(e)?; }
        return Ok(count);
    }
    let file = fs::File::open(file_path)
        .map_err(|e| format!("Cannot open {}: {}", file_path, e))?;
    let mut raw = Vec::new();
    if file_path.ends_with(".json.zst") || file_path.ends_with(".zst") {
        zstd::Decoder::new(BufReader::new(file))
            .map_err(|e| format!("Zstd init {}: {}", file_path, e))?
            .read_to_end(&mut raw).map_err(|e| format!("Zstd {}: {}", file_path, e))?;
    } else if file_path.ends_with(".gz") {
        GzDecoder::new(BufReader::new(file)).read_to_end(&mut raw)
            .map_err(|e| format!("Gzip {}: {}", file_path, e))?;
    } else {
        BufReader::new(file).read_to_end(&mut raw)
            .map_err(|e| format!("Read {}: {}", file_path, e))?;
    };
    // In-place sanitize: fix incomplete \uXXXX escapes by zero-padding. ~0 extra allocation.
    sanitize_json_escapes_inplace(&mut raw);
    // Find entities array bounds — skip {"shardId":N,"entities":[ wrapper
    let arr_start = raw.iter().position(|&b| b == b'[').unwrap_or(0);
    let arr_end = raw.iter().rposition(|&b| b == b']').map(|p| p + 1).unwrap_or(raw.len());
    let slice = &raw[arr_start..arr_end];
    let stream = serde_json::Deserializer::from_slice(slice).into_iter::<serde_json::Value>();
    let mut count = 0usize;
    for result in stream {
        match result {
            Ok(val) => { callback(val)?; count += 1; }
            Err(e) => { eprintln!("[NXVF-CORE] Stream parse error in {}: {}", file_path, e); break; }
        }
    }
    Ok(count)
}

/// Load all entities from a shard directory into a single Vec.
/// WARNING: O(N) memory. Prefer `for_each_shard` for streaming.
pub fn load_all_entities(shard_dir: &str) -> Result<Vec<serde_json::Value>, String> {
    let mut all = Vec::new();
    for_each_shard(shard_dir, |entities| {
        all.extend(entities);
        Ok(())
    })?;
    Ok(all)
}

/// Stream entities one shard at a time. O(shard_size) memory.
/// Callback receives owned Vec<Value> per shard — memory freed after callback returns.
pub fn for_each_shard<F>(shard_dir: &str, mut callback: F) -> Result<usize, String>
where
    F: FnMut(Vec<serde_json::Value>) -> Result<(), String>,
{
    let files = discover_shards(shard_dir)?;
    let mut total = 0usize;
    for path in &files {
        match load_shard_entities(path) {
            Ok(entities) => {
                total += entities.len();
                callback(entities)?;
            }
            Err(e) => eprintln!("[NXVF-CORE] Skipping corrupted shard {}: {}", path, e),
        }
    }
    Ok(total)
}

/// In-place fix for incomplete \uXXXX escapes. Zero allocation for valid data.
/// Pads incomplete hex digits with zeros: \uAB → \u00AB. Uses Vec::splice
/// which is O(n) memcpy per fix, but typically only 1-2 fixes per shard.
fn sanitize_json_escapes_inplace(data: &mut Vec<u8>) {
    let mut i = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut fixes = 0u32;
    while i < data.len() {
        let b = data[i];
        if escaped {
            if b == b'u' && in_string {
                let hex_start = i + 1;
                let mut hex_count = 0;
                while hex_start + hex_count < data.len() && data[hex_start + hex_count].is_ascii_hexdigit() && hex_count < 4 {
                    hex_count += 1;
                }
                if hex_count < 4 {
                    let pad = 4 - hex_count;
                    let zeros = vec![b'0'; pad];
                    data.splice(hex_start..hex_start, zeros);
                    fixes += 1;
                    i = hex_start + 4;
                } else {
                    i = hex_start + 4;
                }
            } else {
                i += 1;
            }
            escaped = false;
            continue;
        }
        if b == b'"' { in_string = !in_string; }
        else if b == b'\\' && in_string { escaped = true; }
        i += 1;
    }
    if fixes > 0 { eprintln!("[NXVF-CORE] Sanitized {} incomplete \\u escapes in-place", fixes); }
}

/// Fix malformed \uXXXX escape sequences that JS serializers can produce.
/// Replaces incomplete \u escapes (fewer than 4 hex digits) with \uFFFD.
pub fn sanitize_json_escapes(input: &str) -> String {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut result = Vec::with_capacity(len);
    let mut i = 0;

    let mut in_string = false;
    let mut escaped = false;

    while i < len {
        let b = bytes[i];
        if escaped {
            result.push(b);
            if b == b'u' && in_string {
                if i + 4 < len && bytes[i + 1..i + 5].iter().all(|c| c.is_ascii_hexdigit()) {
                    result.extend_from_slice(&bytes[i + 1..i + 5]);
                    i += 5;
                } else {
                    let u_pos = result.len() - 1;
                    result[u_pos] = b'u';
                    result.extend_from_slice(b"FFFD");
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

    String::from_utf8(result).unwrap_or_else(|_| input.to_string())
}

/// Auto-detect and decompress a buffer (Zstd, Gzip, or raw).
pub fn auto_decompress(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() >= 4 && data[0..4] == ZSTD_MAGIC {
        zstd::decode_all(data).map_err(|e| format!("Zstd decompress: {}", e))
    } else if data.len() >= 2 && data[0..2] == GZIP_MAGIC {
        let mut decoder = GzDecoder::new(data);
        let mut out = Vec::new();
        decoder
            .read_to_end(&mut out)
            .map_err(|e| format!("Gzip decompress: {}", e))?;
        Ok(out)
    } else {
        Ok(data.to_vec())
    }
}

/// Load a JSON file with auto-decompression. Tries .zst, .gz, and raw variants.
pub fn load_json_file(base_path: &str) -> Result<serde_json::Value, String> {
    // Try exact path first, then compressed variants
    let candidates = if base_path.ends_with(".zst")
        || base_path.ends_with(".gz")
        || base_path.ends_with(".json")
    {
        vec![base_path.to_string()]
    } else {
        vec![
            format!("{}.zst", base_path),
            format!("{}.gz", base_path),
            base_path.to_string(),
        ]
    };

    for path in &candidates {
        if let Ok(data) = fs::read(path) {
            let decompressed = auto_decompress(&data)?;
            let text = String::from_utf8_lossy(&decompressed);
            let sanitized = sanitize_json_escapes(&text);
            return serde_json::from_str(&sanitized)
                .map_err(|e| format!("JSON parse error in {}: {}", path, e));
        }
    }

    Err(format!("Cannot load JSON from {}", base_path))
}

/// Compress data with Zstd and write to file.
pub fn write_zstd(path: &str, data: &[u8], level: i32) -> Result<(), String> {
    let compressed =
        zstd::encode_all(data, level).map_err(|e| format!("Zstd compress: {}", e))?;
    fs::write(path, compressed).map_err(|e| format!("Write {}: {}", path, e))
}

/// Compress data with Gzip and write to file.
pub fn write_gzip(path: &str, data: &[u8]) -> Result<(), String> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let file =
        fs::File::create(path).map_err(|e| format!("Cannot create {}: {}", path, e))?;
    let mut encoder = GzEncoder::new(file, Compression::default());
    encoder
        .write_all(data)
        .map_err(|e| format!("Gzip write: {}", e))?;
    encoder
        .finish()
        .map_err(|e| format!("Gzip finish: {}", e))?;
    Ok(())
}
