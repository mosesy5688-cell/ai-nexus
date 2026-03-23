//! Shared types and content-type mapping for R2 operations.

use napi_derive::napi;

/// R2/S3 connection configuration passed from JS.
#[napi(object)]
#[derive(Clone)]
pub struct R2Config {
    pub account_id: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub bucket: String,
}

/// Result of a single upload operation.
#[napi(object)]
pub struct UploadResult {
    pub success: bool,
    pub path: String,
    pub skipped: bool,
    pub error: Option<String>,
    pub parts: Option<u32>,
}

/// Result of a download operation.
#[napi(object)]
pub struct DownloadResult {
    pub success: bool,
    pub size: i64,
    pub error: Option<String>,
}

/// Entry from directory walk with pre-computed MD5.
#[napi(object)]
pub struct WalkEntry {
    pub rel_path: String,
    pub size: i64,
    pub md5: String,
}

/// Result of a batch upload operation.
#[napi(object)]
pub struct BatchResult {
    pub success: i32,
    pub failed: i32,
    pub skipped: i32,
    pub unchanged: i32,
    pub total_size: i64,
}

/// Detect content-type from file extension.
pub fn content_type_for_ext(ext: &str) -> &'static str {
    match ext {
        "json" => "application/json",
        "gz" => "application/gzip",
        "zst" => "application/zstd",
        "db" => "application/x-sqlite3",
        "bin" => "application/octet-stream",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "xml" => "application/xml",
        "html" => "text/html",
        "txt" => "text/plain",
        "ndjson" => "application/x-ndjson",
        "tar" => "application/x-tar",
        _ => "application/octet-stream",
    }
}

/// Detect content-encoding from file magic bytes.
pub fn detect_content_encoding(data: &[u8]) -> Option<&'static str> {
    if data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b {
        Some("gzip")
    } else {
        None
    }
}
