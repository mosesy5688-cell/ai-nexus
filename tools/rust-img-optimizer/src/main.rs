// tools/rust-img-optimizer/src/main.rs

use clap::Parser;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::sync::Arc;

use aws_config::{BehaviorVersion, SdkConfig};
use aws_credential_types::provider::SharedCredentialsProvider;
use aws_types::region::Region;
use aws_sdk_s3::config::Credentials;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use futures::future::join_all;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use urlencoding::encode;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Path to the input JSON file
    #[arg(short, long)]
    input: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct Model {
    id: String,
    likes: Option<i32>,
    downloads: Option<i32>,
    tags: Option<Vec<String>>,
    pipeline_tag: Option<String>,
    author: Option<String>,
    name: Option<String>,
    source: Option<String>,
    description: Option<String>,
    image_url: Option<String>,
}

struct ProcessingContext {
    r2_client: Option<Client>,
    bucket: String,
    public_url_prefix: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    // Debug information header
    let mut debug_header = String::new();
    debug_header.push_str(&format!("-- Args: {:?}\n", args));
    debug_header.push_str(&format!("-- R2_BUCKET env: {:?}\n", env::var("R2_BUCKET")));
    debug_header.push_str(&format!("-- CLOUDFLARE_ACCOUNT_ID env: {:?}\n", env::var("CLOUDFLARE_ACCOUNT_ID")));
    debug_header.push_str(&format!("-- R2_PUBLIC_URL_PREFIX env: {:?}\n", env::var("R2_PUBLIC_URL_PREFIX")));

    eprintln!("Processing input file: {}", args.input);

    // ==================== 1. Initialize Cloudflare R2 Client ====================
    let bucket = env::var("R2_BUCKET").unwrap_or_else(|_| "MISSING_BUCKET".to_string());
    let account_id = env::var("CLOUDFLARE_ACCOUNT_ID").unwrap_or_else(|_| "MISSING_ID".to_string());
    let public_url_prefix = env::var("R2_PUBLIC_URL_PREFIX").unwrap_or_else(|_| "https://cdn.free2aitools.com".to_string());

    let r2_client = if bucket != "MISSING_BUCKET"
        && account_id != "MISSING_ID"
        && env::var("R2_ACCESS_KEY").is_ok()
        && env::var("R2_SECRET_KEY").is_ok()
    {
        let access_key = env::var("R2_ACCESS_KEY")?;
        let secret_key = env::var("R2_SECRET_KEY")?;

        let endpoint_url = format!("https://{}.r2.cloudflarestorage.com", account_id);

        // Use a pure, manual config builder to avoid conflicts with env vars like AWS_ACCESS_KEY_ID
        let config = SdkConfig::builder()
            .endpoint_url(endpoint_url)
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(SharedCredentialsProvider::new(Credentials::new(access_key, secret_key, None, None, "R2")))
            .region(Region::new("auto"))
            .build();

        let client = Client::new(&config);
        eprintln!("R2 client initialized for bucket: {}", bucket);
        debug_header.push_str("-- R2 Client: Initialized\n");
        Some(client)
    } else {
        eprintln!("R2 credentials missing – skipping image uploads.");
        debug_header.push_str("-- R2 Client: SKIPPED (Missing credentials)\n");
        None
    };

    // ==================== 2. Load JSON data ====================
    let data = fs::read_to_string(&args.input)?;
    let models: Vec<Model> = serde_json::from_str(&data)?;
    eprintln!("Found {} models in the file", models.len());

    // ==================== 3. Process models concurrently ====================
    let ctx = Arc::new(ProcessingContext {
        r2_client,
        bucket: bucket.clone(),
        public_url_prefix,
    });

    let semaphore = Arc::new(Semaphore::new(10));

    eprintln!("Starting concurrent image processing for {} models...", models.len());

    let handles: Vec<JoinHandle<Option<(String, bool, String)>>> = models
        .into_iter()
        .map(|model| {
            let ctx = Arc::clone(&ctx);
            let sem = Arc::clone(&semaphore);
            tokio::spawn(async move {
                let _permit = sem.acquire().await.unwrap();
                process_model(model, ctx).await
            })
        })
        .collect();

    let results = join_all(handles).await;

    // ==================== 4. Generate SQL output ====================
    let mut sql = String::from("-- Auto-generated upsert SQL\n");
    sql.push_str(&debug_header);

    let mut total_models = 0;
    let mut models_with_images = 0;

    for result in results {
        if let Ok(Some((stmt, has_image, logs))) = result {
            sql.push_str(&stmt);
            if !logs.is_empty() {
                sql.push_str(&format!("/* LOGS:\n{}\n*/\n", logs));
            }
            total_models += 1;
            if has_image {
                models_with_images += 1;
            }
        }
    }

    eprintln!("SQL Generation Summary:");
    eprintln!("  Total models processed: {}", total_models);
    eprintln!(
        "  Models with images: {} ({:.1}%)",
        models_with_images,
        if total_models > 0 {
            (models_with_images as f64 / total_models as f64) * 100.0
        } else {
            0.0
        }
    );
    eprintln!("  Models without images: {}", total_models - models_with_images);

    println!("{}", sql);
    eprintln!("SQL generated successfully.");

    Ok(())
}

async fn process_model(model: Model, ctx: Arc<ProcessingContext>) -> Option<(String, bool, String)> {
    let source = model.source.unwrap_or_else(|| "huggingface".to_string());

    let (author, name) = if let (Some(a), Some(n)) = (model.author, model.name) {
        (a, n)
    } else {
        let parts: Vec<String> = model.id.split('/').map(|s| s.to_string()).collect();
        if parts.len() >= 2 {
            (parts[0].clone(), parts[1].clone())
        } else {
            ("unknown".to_string(), model.id)
        }
    };

    let safe_author = author.replace(['/', '_'], "-");
    let safe_name = name.replace(['/', '_'], "-");
    let db_id = format!("{}-{}-{}", source, safe_author, safe_name);
    let slug = format!(
        "{}--{}--{}",
        source,
        safe_author.to_lowercase(),
        safe_name.to_lowercase()
    );

    let mut logs = String::new();
    let mut final_image_url = "NULL".to_string();
    let mut has_image = false;

    // ==================== Image download & upload to R2 ====================
    if let Some(client) = ctx.r2_client.as_ref() {
        let src_url = if source == "github" {
            format!("https://github.com/{}.png", author)
        } else {
            format!(
                "https://ui-avatars.com/api/?name={}&size=512&background=random&color=fff",
                encode(&name)
            )
        };

        logs.push_str(&format!("Downloading image for {} from {}\n", db_id, src_url));
        eprintln!("[{}] Downloading image...", db_id);

        if let Ok(resp) = reqwest::get(src_url).await {
            if resp.status().is_success() {
                if let Ok(body) = resp.bytes().await {
                    let object_key = format!("models/{}.jpg", db_id);

                    let put_result = client
                        .put_object()
                        .bucket(ctx.bucket.clone())
                        .key(object_key.clone())
                        .body(ByteStream::from(body.to_vec()))
                        .content_type("image/jpeg")
                        .send()
                        .await;

                    match put_result {
                        Ok(_) => {
                            final_image_url = format!("'{}/{}'", ctx.public_url_prefix, object_key);
                            has_image = true;
                            logs.push_str("Successfully uploaded to R2\n");
                            eprintln!("[{}] Image uploaded successfully", db_id);
                        }
                        Err(e) => {
                            logs.push_str(&format!("R2 upload failed: {:?}\n", e));
                            eprintln!("[{}] R2 upload error: {:?}", db_id, e);
                        }
                    }
                } else {
                    logs.push_str("Failed to read image bytes\n");
                }
            } else {
                logs.push_str(&format!("HTTP error: {}\n", resp.status()));
            }
        } else {
            logs.push_str("Network request failed\n");
        }
    }

    // ==================== Build SQL statement ====================
    let pipeline = model.pipeline_tag.unwrap_or_else(|| "other".to_string());
    let tags_json = serde_json::to_string(&model.tags.unwrap_or_default()).unwrap_or_else(|_| "[]".to_string());
    let safe_desc = model.description.unwrap_or_default().replace('\'', "''").replace('\n', " ");

    let stmt = format!(
        "INSERT OR REPLACE INTO models (id, slug, name, author, description, tags, pipeline_tag, likes, downloads, cover_image_url, last_updated) VALUES ('{}', '{}', '{}', '{}', '{}', '{}', '{}', {}, {}, {}, CURRENT_TIMESTAMP);\n",
        db_id,
        slug,
        name.replace('\'', "''"),
        author.replace('\'', "''"),
        safe_desc,
        tags_json.replace('\'', "''"),
        pipeline,
        model.likes.unwrap_or(0),
        model.downloads.unwrap_or(0),
        final_image_url
    );

    Some((stmt, has_image, logs))
}