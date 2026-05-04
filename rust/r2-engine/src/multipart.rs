//! Multipart upload for files >8MB.
//! Streams file in 8MB chunks to reduce heap pressure (V25.8 §2.2).

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::CompletedMultipartUpload;
use aws_sdk_s3::types::CompletedPart;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::Path;
use tokio::io::AsyncReadExt;

use crate::client::R2Client;
use crate::types::{content_type_for_ext, UploadResult};

const MULTIPART_THRESHOLD: u64 = 8 * 1024 * 1024;
const PART_SIZE: u64 = 8 * 1024 * 1024;

/// Upload a file using multipart if >8MB, else single PutObject.
/// Streams 8MB chunks — O(1) memory per part.
#[napi]
pub async fn upload_file_multipart(
    client: &R2Client,
    local_path: String,
    remote_path: String,
) -> Result<UploadResult> {
    let meta = tokio::fs::metadata(&local_path).await.map_err(|e| {
        Error::from_reason(format!("stat {local_path}: {e}"))
    })?;

    if meta.len() < MULTIPART_THRESHOLD {
        // Delegate to single-part upload
        return crate::operations::upload_file(
            client, local_path, remote_path, None, Some(3),
        )
        .await;
    }

    let ext = Path::new(&remote_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let content_type = content_type_for_ext(ext);

    // Initiate multipart upload
    let create_resp = client
        .client
        .create_multipart_upload()
        .bucket(&client.bucket)
        .key(&remote_path)
        .content_type(content_type)
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("CreateMultipart: {e}")))?;

    let upload_id = create_resp
        .upload_id()
        .ok_or_else(|| Error::from_reason("No UploadId returned"))?
        .to_string();

    let file_size = meta.len();
    let total_parts = ((file_size + PART_SIZE - 1) / PART_SIZE) as u32;
    let mut completed_parts: Vec<CompletedPart> = Vec::new();

    // V25.13: Truly stream from disk — open once, read sequentially per part.
    // Peak memory bounded at PART_SIZE (8MB), regardless of file size.
    // Replaces previous `tokio::fs::read(whole)` which OOMed on 4GB+ files.
    let mut file = tokio::fs::File::open(&local_path).await.map_err(|e| {
        Error::from_reason(format!("open {local_path}: {e}"))
    })?;

    for part_num in 1..=total_parts {
        let part_offset = (part_num - 1) as u64 * PART_SIZE;
        let part_len = std::cmp::min(PART_SIZE, file_size - part_offset) as usize;
        let mut part_buf = vec![0u8; part_len];
        file.read_exact(&mut part_buf).await.map_err(|e| {
            Error::from_reason(format!("read part {part_num}: {e}"))
        })?;

        let upload_resp = client
            .client
            .upload_part()
            .bucket(&client.bucket)
            .key(&remote_path)
            .upload_id(&upload_id)
            .part_number(part_num as i32)
            .body(ByteStream::from(part_buf))
            .send()
            .await
            .map_err(|e| {
                Error::from_reason(format!("UploadPart {part_num}: {e}"))
            })?;

        let etag = upload_resp.e_tag().unwrap_or("").to_string();
        let part = CompletedPart::builder()
            .e_tag(etag)
            .part_number(part_num as i32)
            .build();
        completed_parts.push(part);
    }

    // Complete multipart upload
    let completed = CompletedMultipartUpload::builder()
        .set_parts(Some(completed_parts))
        .build();

    client
        .client
        .complete_multipart_upload()
        .bucket(&client.bucket)
        .key(&remote_path)
        .upload_id(&upload_id)
        .multipart_upload(completed)
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("CompleteMultipart: {e}")))?;

    Ok(UploadResult {
        success: true,
        path: remote_path,
        skipped: false,
        error: None,
        parts: Some(total_parts),
    })
}
