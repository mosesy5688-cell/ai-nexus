//! Entropy purge: delete blacklisted or redundant objects from R2.

use std::collections::HashMap;

use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::client::R2Client;

/// Delete objects matching a blacklist or .json files with .gz equivalents.
#[napi]
pub async fn purge_entropy(
    client: &R2Client,
    etag_map_json: String,
) -> Result<u32> {
    let etag_map: HashMap<String, String> =
        serde_json::from_str(&etag_map_json).unwrap_or_default();
    let blacklist = [
        "cache/search-full.json",
        "cache/search-full.json.gz",
        "cache/search-core.json",
    ];
    let mut to_delete: Vec<String> = Vec::new();
    for key in &blacklist {
        if etag_map.contains_key(*key) {
            to_delete.push(key.to_string());
        }
    }
    for key in etag_map.keys() {
        if key.ends_with(".json") && etag_map.contains_key(&format!("{key}.gz")) {
            to_delete.push(key.clone());
        }
    }

    let total = to_delete.len() as u32;
    for chunk in to_delete.chunks(1000) {
        let objects: Vec<ObjectIdentifier> = chunk
            .iter()
            .filter_map(|k| ObjectIdentifier::builder().key(k).build().ok())
            .collect();
        if objects.is_empty() { continue; }
        let delete = Delete::builder().set_objects(Some(objects)).build()
            .map_err(|e| Error::from_reason(format!("Delete build: {e}")))?;
        client.client.delete_objects().bucket(&client.bucket).delete(delete)
            .send().await.ok();
    }
    Ok(total)
}
