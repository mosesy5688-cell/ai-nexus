//! V26.3 R2 Engine — Native R2/S3 operations via N-API.
//!
//! Async functions return Promise to JS via napi-rs managed tokio runtime.
//! Replaces JS @aws-sdk/client-s3 with native Rust aws-sdk-s3 for:
//! - Parallel MD5 hashing (5-10x faster than JS crypto)
//! - Concurrent upload/download via tokio Semaphore
//! - Streaming multipart upload (O(1) memory for >8MB files)
//! - Recursive directory walk with parallel hash (walkdir)

mod types;
mod client;
mod operations;
mod multipart;
pub(crate) mod batch;
mod backup;
mod purge;
