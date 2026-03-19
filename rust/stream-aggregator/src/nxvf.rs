//! NXVF V4.1 Binary Shard Reader — Zstd/Gzip decompression + AES-256-CTR decryption.
//! Port of scripts/factory/lib/registry-binary-reader.js for native Rust performance.
//! Header: Magic(4B) | Version(1B) | SlotID(2B) | OffsetTableOffset(4B) |
//!         EntityCount(4B) | Checksum(4B) | EmbeddingOffset(4B) |
//!         EmbeddingCount(4B) | EmbeddingDim(2B) = 29 bytes

use aes::Aes256;
use cipher::{generic_array::GenericArray, KeyIvInit, StreamCipher};
use ctr::Ctr128BE;
use flate2::read::GzDecoder;
use napi::{Error, Result};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const HEADER_SIZE: usize = 29;
const NXVF_MAGIC: [u8; 4] = [0x4E, 0x58, 0x56, 0x46]; // "NXVF"
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
const GZIP_MAGIC: [u8; 2] = [0x1F, 0x8B];

type Aes256Ctr = Ctr128BE<Aes256>;

/// Lazily load AES-256 key from AES_CRYPTO_KEY env var (first 64 hex chars → 32 bytes).
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
        eprintln!("[RUST-NXVF] AES-256-CTR sovereign encryption enabled");
        Some(key)
    })
}

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

/// Match JS isValidPayload(): detect raw JSON or Zstd magic to skip decryption.
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
    // Gzip magic (2 bytes)
    if buf.len() >= 2 && buf[0..2] == GZIP_MAGIC {
        return true;
    }
    false
}

/// Derive per-entity IV: SHA-256(key || shardName || String(offset))[0:16]
/// Must match shard-crypto.js deriveEntityIv() exactly.
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

/// Read and decode a binary NXVF V4.1 shard file into entity JSON values.
pub fn read_binary_shard(file_path: &str) -> Result<Vec<serde_json::Value>> {
    let data = std::fs::read(file_path)
        .map_err(|e| Error::from_reason(format!("Cannot read {}: {}", file_path, e)))?;

    let header = parse_header(&data)
        .ok_or_else(|| Error::from_reason(format!("Invalid NXVF header: {}", file_path)))?;

    let ot_start = header.offset_table_offset as usize;
    let ot_end = ot_start + header.entity_count as usize * 8;
    if ot_end > data.len() {
        return Err(Error::from_reason(format!(
            "Offset table exceeds file size: {}",
            file_path
        )));
    }
    let offset_table = &data[ot_start..ot_end];

    // Verify checksum (XOR of offset table uint32 words)
    let mut computed: u32 = 0;
    for chunk in offset_table.chunks_exact(4) {
        computed ^= u32::from_le_bytes(chunk.try_into().unwrap_or([0; 4]));
    }
    if computed != header.checksum {
        eprintln!("[RUST-NXVF] Checksum mismatch: {}", file_path);
    }

    let shard_name = std::path::Path::new(file_path)
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

        // Zstd decompression (detect via magic bytes)
        if payload.len() >= 4 && payload[0..4] == ZSTD_MAGIC {
            match zstd::decode_all(payload.as_slice()) {
                Ok(decompressed) => payload = decompressed,
                Err(e) => {
                    eprintln!("[RUST-NXVF] Zstd error in {}[{}]: {}", shard_name, i, e);
                    continue;
                }
            }
        }
        // Gzip decompression (detect via magic bytes 1F 8B)
        else if payload.len() >= 2 && payload[0..2] == GZIP_MAGIC {
            use std::io::Read;
            let mut decoder = GzDecoder::new(payload.as_slice());
            let mut decompressed = Vec::new();
            match decoder.read_to_end(&mut decompressed) {
                Ok(_) => payload = decompressed,
                Err(e) => {
                    eprintln!("[RUST-NXVF] Gzip error in {}[{}]: {}", shard_name, i, e);
                    continue;
                }
            }
        }

        // JSON parse with sanitization fallback + forced-decrypt retry
        match serde_json::from_slice::<serde_json::Value>(&payload) {
            Ok(val) => entities.push(val),
            Err(e) => {
                let raw_str = String::from_utf8_lossy(&payload);
                let sanitized = super::sanitize_json_escapes(&raw_str);
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&sanitized) {
                    entities.push(val);
                    continue;
                }
                // Forced-decrypt retry: isValidPayload false positive where encrypted
                // bytes randomly start with 0x7B22 ("{"), ~1/65536 chance per entity
                if let Some(key) = aes_key {
                    let raw = &data[offset as usize..end];
                    let mut retry = decrypt_payload(key, shard_name, raw, offset);
                    if retry.len() >= 4 && retry[0..4] == ZSTD_MAGIC {
                        if let Ok(d) = zstd::decode_all(retry.as_slice()) { retry = d; }
                    } else if retry.len() >= 2 && retry[0..2] == GZIP_MAGIC {
                        use std::io::Read;
                        let mut dec = GzDecoder::new(retry.as_slice());
                        let mut d = Vec::new();
                        if dec.read_to_end(&mut d).is_ok() { retry = d; }
                    }
                    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&retry) {
                        entities.push(val);
                        continue;
                    }
                }
                eprintln!("[RUST-NXVF] Parse error {}[{}]: {}", shard_name, i, e);
            }
        }
    }

    eprintln!(
        "[RUST-NXVF] Read {} entities from {}",
        entities.len(),
        shard_name
    );
    Ok(entities)
}
