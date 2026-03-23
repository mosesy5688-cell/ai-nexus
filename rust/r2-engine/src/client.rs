//! R2/S3 client creation via aws-sdk-s3.
//! Endpoint: https://{account_id}.r2.cloudflarestorage.com

use aws_credential_types::Credentials;
use aws_sdk_s3::config::{BehaviorVersion, Region};
use aws_sdk_s3::Client;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::types::R2Config;

/// Opaque R2 client wrapper — passed between JS and Rust calls.
/// Holds the aws-sdk S3 client and bucket name.
#[napi]
pub struct R2Client {
    pub(crate) client: Client,
    pub(crate) bucket: String,
}

/// Create an R2 client from configuration.
/// Returns an opaque R2Client that can be reused across operations.
#[napi]
pub fn create_r2_client(config: R2Config) -> Result<R2Client> {
    let endpoint = format!(
        "https://{}.r2.cloudflarestorage.com",
        config.account_id
    );

    let credentials = Credentials::new(
        &config.access_key_id,
        &config.secret_access_key,
        None,
        None,
        "r2-engine",
    );

    let s3_config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("auto"))
        .endpoint_url(&endpoint)
        .credentials_provider(credentials)
        .force_path_style(true)
        .build();

    let client = Client::from_conf(s3_config);

    Ok(R2Client {
        client,
        bucket: config.bucket,
    })
}
