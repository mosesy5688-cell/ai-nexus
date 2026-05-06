//! Core single-object R2 operations: upload, download, list, stream, purge.
//! All async functions return Promise to JS via napi-rs tokio runtime.

use std::collections::HashMap;
use std::path::Path;

use aws_sdk_s3::primitives::ByteStream;
use md5::{Digest, Md5};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::io::AsyncReadExt;

use crate::client::R2Client;
use crate::types::{content_type_for_ext, detect_content_encoding, DownloadResult, UploadResult};

/// Fetch all R2 ETags with optional prefix filtering (paginated).
/// Returns a HashMap<key, etag> (etag without quotes).
#[napi]
pub async fn fetch_all_r2_etags(
    client: &R2Client,
    prefix_filter: Vec<String>,
) -> Result<HashMap<String, String>> {
    let mut etag_map = HashMap::new();
    let prefixes: Vec<Option<String>> = if prefix_filter.is_empty() {
        vec![None]
    } else {
        prefix_filter.into_iter().map(Some).collect()
    };

    for prefix in &prefixes {
        let mut continuation_token: Option<String> = None;
        loop {
            let mut req = client
                .client
                .list_objects_v2()
                .bucket(&client.bucket)
                .max_keys(1000);
            if let Some(p) = prefix {
                req = req.prefix(p);
            }
            if let Some(token) = &continuation_token {
                req = req.continuation_token(token);
            }

            let resp = req.send().await.map_err(|e| {
                Error::from_reason(format!("ListObjectsV2 failed: {e}"))
            })?;

            for obj in resp.contents() {
                if let (Some(key), Some(etag)) = (obj.key(), obj.e_tag()) {
                    etag_map.insert(
                        key.to_string(),
                        etag.trim_matches('"').to_string(),
                    );
                }
            }

            if resp.is_truncated() == Some(true) {
                continuation_token = resp.next_continuation_token().map(|s| s.to_string());
            } else {
                break;
            }
        }
    }

    Ok(etag_map)
}

/// Upload a single file to R2 with MD5/ETag skip and retry.
/// V25.13: Streams from disk — O(1) memory regardless of file size
/// (was OOM on 4GB+ embedding-cache.db with whole-file `tokio::fs::read`).
#[napi]
pub async fn upload_file(
    client: &R2Client,
    local_path: String,
    remote_path: String,
    remote_etag: Option<String>,
    max_retries: Option<u32>,
) -> Result<UploadResult> {
    let retries = max_retries.unwrap_or(3);
    upload_file_inner(client, &local_path, &remote_path, remote_etag.as_deref(), retries, 0).await
}

const MD5_CHUNK: usize = 8 * 1024 * 1024;

/// Stream-compute MD5 + detect content encoding from first chunk.
/// O(1) memory (8MB rolling buffer) regardless of file size.
async fn stream_md5_and_encoding(
    local_path: &str,
) -> std::io::Result<(String, Option<&'static str>)> {
    let mut file = tokio::fs::File::open(local_path).await?;
    let mut hasher = Md5::new();
    let mut buf = vec![0u8; MD5_CHUNK];
    let mut content_encoding: Option<&'static str> = None;
    let mut first_chunk = true;
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        if first_chunk {
            content_encoding = detect_content_encoding(&buf[..n]);
            first_chunk = false;
        }
        hasher.update(&buf[..n]);
    }
    Ok((format!("{:x}", hasher.finalize()), content_encoding))
}

async fn upload_file_inner(
    client: &R2Client,
    local_path: &str,
    remote_path: &str,
    remote_etag: Option<&str>,
    max_retries: u32,
    attempt: u32,
) -> Result<UploadResult> {
    // V25.13: Streaming MD5 + encoding detection (8MB rolling buffer).
    let (local_md5, content_encoding) = match stream_md5_and_encoding(local_path).await {
        Ok(v) => v,
        Err(e) => {
            return Ok(UploadResult {
                success: false,
                path: remote_path.to_string(),
                skipped: false,
                error: Some(format!("read error: {e}")),
                parts: None,
            });
        }
    };

    // ETag skip
    if let Some(etag) = remote_etag {
        if local_md5 == etag {
            return Ok(UploadResult {
                success: true,
                path: remote_path.to_string(),
                skipped: true,
                error: None,
                parts: None,
            });
        }
    }

    // Content-type detection
    let ext = Path::new(remote_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let content_type = content_type_for_ext(ext);

    // V25.13: Streaming body from disk path (SDK reads in ~64KB chunks lazily).
    // Replaces in-memory `ByteStream::from(Vec<u8>)` which OOMed on 4GB+ files.
    let body = match ByteStream::from_path(local_path).await {
        Ok(b) => b,
        Err(e) => {
            return Ok(UploadResult {
                success: false,
                path: remote_path.to_string(),
                skipped: false,
                error: Some(format!("ByteStream::from_path: {e}")),
                parts: None,
            });
        }
    };

    let mut req = client
        .client
        .put_object()
        .bucket(&client.bucket)
        .key(remote_path)
        .body(body)
        .content_type(content_type);

    // Content-Encoding removed: .gz files are binary objects (Content-Type: application/gzip),
    // NOT gzip-encoded transport. Setting Content-Encoding causes R2 to reject the upload.
    let _ = content_encoding;

    match req.send().await {
        Ok(_) => Ok(UploadResult {
            success: true,
            path: remote_path.to_string(),
            skipped: false,
            error: None,
            parts: None,
        }),
        Err(_e) if attempt < max_retries => {
            let backoff = 1000 * 2u64.pow(attempt);
            tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
            Box::pin(upload_file_inner(
                client, local_path, remote_path, remote_etag, max_retries, attempt + 1,
            ))
            .await
        }
        Err(e) => Ok(UploadResult {
            success: false,
            path: remote_path.to_string(),
            skipped: false,
            error: Some(format!("PutObject failed after {attempt} retries: {e}")),
            parts: None,
        }),
    }
}

/// Stream JSON state directly to R2 (small objects).
#[napi]
pub async fn stream_to_r2(client: &R2Client, key: String, data: String) -> Result<bool> {
    client
        .client
        .put_object()
        .bucket(&client.bucket)
        .key(&key)
        .body(ByteStream::from(data.into_bytes()))
        .content_type("application/json")
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("streamToR2 failed: {e}")))?;
    Ok(true)
}

/// Download an object from R2 and return raw bytes.
#[napi]
pub async fn download_from_r2(
    client: &R2Client,
    key: String,
    local_path: Option<String>,
) -> Result<DownloadResult> {
    match client.client.get_object().bucket(&client.bucket).key(&key).send().await {
        Ok(resp) => {
            let body = resp.body.collect().await
                .map_err(|e| Error::from_reason(format!("body read: {e}")))?;
            let bytes = body.into_bytes();
            let size = bytes.len() as i64;
            if let Some(path) = local_path {
                if let Some(parent) = Path::new(&path).parent() {
                    tokio::fs::create_dir_all(parent).await.ok();
                }
                tokio::fs::write(&path, &bytes).await
                    .map_err(|e| Error::from_reason(format!("write {path}: {e}")))?;
            }
            Ok(DownloadResult { success: true, size, error: None })
        }
        Err(e) => Ok(DownloadResult {
            success: false, size: 0,
            error: Some(format!("{e}")),
        }),
    }
}

