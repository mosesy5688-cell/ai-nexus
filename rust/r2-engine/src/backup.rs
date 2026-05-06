//! Directory-level R2 backup and restore operations.
//! Backup writes a _manifest.json; restore reads it (or falls back to prefix listing).

use std::path::Path;

use aws_sdk_s3::primitives::ByteStream;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::batch::walk_dir_with_md5;
use crate::client::R2Client;
use crate::types::{content_type_for_ext, BatchResult};

/// Backup a local directory to R2 under a prefix. Writes _manifest.json.
#[napi]
pub async fn backup_directory_to_r2(
    client: &R2Client,
    local_dir: String,
    r2_prefix: String,
    concurrency: Option<u32>,
    min_size: Option<i64>,
) -> Result<BatchResult> {
    let min_bytes = min_size.unwrap_or(1024) as u64;
    let entries = walk_dir_with_md5(local_dir.clone(), None).await?;

    let mut manifest_files: Vec<String> = Vec::new();
    let conc = concurrency.unwrap_or(5) as usize;
    let mut success = 0i32;
    let mut failed = 0i32;
    let mut total_size = 0i64;

    for chunk in entries.chunks(conc) {
        for entry in chunk {
            if (entry.size as u64) < min_bytes { continue; }
            let local_path = format!("{}/{}", local_dir, entry.rel_path);
            let r2_key = format!("{}{}", r2_prefix, entry.rel_path);
            let ext = Path::new(&r2_key).extension().and_then(|e| e.to_str()).unwrap_or("");
            let ct = content_type_for_ext(ext);

            // V25.13: Streaming body from disk (no whole-file load).
            // Size already known from directory walk (entry.size), no read needed for that.
            match ByteStream::from_path(&local_path).await {
                Ok(body) => {
                    match client.client.put_object()
                        .bucket(&client.bucket).key(&r2_key)
                        .body(body).content_type(ct)
                        .send().await
                    {
                        Ok(_) => {
                            manifest_files.push(entry.rel_path.clone());
                            total_size += entry.size as i64;
                            success += 1;
                        }
                        Err(_) => failed += 1,
                    }
                }
                Err(_) => failed += 1,
            }
        }
    }

    let manifest = serde_json::json!({
        "files": manifest_files,
        "timestamp": chrono_now(),
        "count": manifest_files.len()
    });
    let manifest_key = format!("{}_manifest.json", r2_prefix);
    client.client.put_object()
        .bucket(&client.bucket).key(&manifest_key)
        .body(ByteStream::from(manifest.to_string().into_bytes()))
        .content_type("application/json")
        .send().await.ok();

    Ok(BatchResult { success, failed, skipped: 0, unchanged: 0, total_size })
}

/// Restore a directory from R2 (manifest-based or prefix listing).
#[napi]
pub async fn restore_directory_from_r2(
    client: &R2Client,
    r2_prefix: String,
    local_dir: String,
    concurrency: Option<u32>,
) -> Result<BatchResult> {
    let _conc = concurrency.unwrap_or(5) as usize;
    let mut file_keys: Vec<(String, String)> = Vec::new();

    // Try manifest first, fall back to ListObjects if manifest fails or yields 0 entries
    let manifest_key = format!("{}_manifest.json", r2_prefix);
    if let Ok(resp) = client.client.get_object().bucket(&client.bucket).key(&manifest_key).send().await {
        if let Ok(body) = resp.body.collect().await {
            let json: serde_json::Value = serde_json::from_slice(&body.into_bytes()).unwrap_or_default();
            if let Some(files) = json["files"].as_array() {
                for f in files {
                    if let Some(rel) = f.as_str() {
                        file_keys.push((format!("{}{}", r2_prefix, rel), rel.to_string()));
                    }
                }
            }
        }
    }
    // §18.22.7 fix: if manifest yielded 0 entries (GET failed, body failed, or empty), use ListObjects
    if file_keys.is_empty() {
        let mut token: Option<String> = None;
        loop {
            let mut req = client.client.list_objects_v2()
                .bucket(&client.bucket).prefix(&r2_prefix).max_keys(1000);
            if let Some(t) = &token { req = req.continuation_token(t); }
            let resp = req.send().await.map_err(|e| Error::from_reason(format!("{e}")))?;
            for obj in resp.contents() {
                if let Some(key) = obj.key() {
                    if key.ends_with("_manifest.json") { continue; }
                    let rel = &key[r2_prefix.len()..];
                    file_keys.push((key.to_string(), rel.to_string()));
                }
            }
            if resp.is_truncated() == Some(true) {
                token = resp.next_continuation_token().map(|s| s.to_string());
            } else { break; }
        }
    }

    let mut success = 0i32;
    let mut failed = 0i32;
    let mut total_size = 0i64;

    for (key, rel) in &file_keys {
        let local_path = format!("{}/{}", local_dir, rel);
        if let Some(parent) = Path::new(&local_path).parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        match client.client.get_object().bucket(&client.bucket).key(key).send().await {
            Ok(resp) => {
                if let Ok(body) = resp.body.collect().await {
                    let bytes = body.into_bytes();
                    total_size += bytes.len() as i64;
                    if tokio::fs::write(&local_path, &bytes).await.is_ok() {
                        success += 1;
                    } else { failed += 1; }
                } else { failed += 1; }
            }
            Err(_) => failed += 1,
        }
    }

    Ok(BatchResult { success, failed, skipped: 0, unchanged: 0, total_size })
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}
