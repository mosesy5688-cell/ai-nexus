use clap::Parser;
use serde::{Deserialize, Serialize};
use std::fs;
use std::env;
use aws_sdk_s3::Client;
use aws_config::meta::region::RegionProviderChain;
use aws_sdk_s3::primitives::ByteStream;
use futures::stream::{self, StreamExt};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Input JSON file path
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
    // Optional input image url if collectors provide it later
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
    
    // DEBUG: Write context to SQL immediately
    let mut debug_header = String::new();
    debug_header.push_str(&format!("-- Args: {:?}\n", args));
    debug_header.push_str(&format!("-- R2_BUCKET env: {:?}\n", env::var("R2_BUCKET")));
    debug_header.push_str(&format!("-- CLOUDFLARE_ACCOUNT_ID env: {:?}\n", env::var("CLOUDFLARE_ACCOUNT_ID")));
    
    eprintln!("Processing input: {}", args.input);

    // 1. Setup R2 Client
    let mut r2_client = None;
    let bucket = env::var("R2_BUCKET").unwrap_or_else(|_| "MISSING_BUCKET".to_string());
    let account_id = env::var("CLOUDFLARE_ACCOUNT_ID").unwrap_or_else(|_| "MISSING_ID".to_string());

    // ALWAYS try to setup upload
    let access_key = env::var("R2_ACCESS_KEY");
    let secret_key = env::var("R2_SECRET_KEY");
    
    if bucket != "MISSING_BUCKET" && account_id != "MISSING_ID" && access_key.is_ok() && secret_key.is_ok() {
        // Set AWS env vars for the SDK to pick them up automatically
        env::set_var("AWS_ACCESS_KEY_ID", access_key.unwrap());
        env::set_var("AWS_SECRET_ACCESS_KEY", secret_key.unwrap());
        env::set_var("AWS_REGION", "auto");

        let endpoint_url = format!("https://{}.r2.cloudflarestorage.com", account_id);
        
        // Force the endpoint resolver to use our static R2 URL
        let endpoint = aws_sdk_s3::config::endpoint::Endpoint::immutable(endpoint_url.parse().expect("Valid URI"));
        let sdk_config = aws_config::load_from_env().await;

        let config = aws_sdk_s3::Config::builder()
            .endpoint_resolver(endpoint)
            .credentials_provider(sdk_config.credentials_provider().expect("No credentials provider found"))
            .region(sdk_config.region().cloned())
            .build();
        
        r2_client = Some(Client::from_conf(config));
        eprintln!("R2 Client initialized for bucket: {}", bucket);
        debug_header.push_str("-- R2 Client: Initialized\n");
    } else {
        eprintln!("R2 Credentials missing, skipping upload.");
        debug_header.push_str("-- R2 Client: SKIPPED (Missing credentials)\n");
    }

    // 2. Read JSON
    let data = fs::read_to_string(&args.input)?;
    let models: Vec<Model> = serde_json::from_str(&data)?;
    eprintln!("Found {} models", models.len());

    // 3. Process Models Concurrently
    let ctx = Arc::new(ProcessingContext {
        r2_client,
        bucket: bucket.clone(),
        public_url_prefix: "https://cdn.free2aitools.com".to_string(), // Default assumption
    });

    let semaphore = Arc::new(Semaphore::new(10)); // Limit concurrency to 10
    
    eprintln!("Starting concurrent image processing for {} models...", models.len());

    let results = stream::iter(models)
        .map(|model| {
            let ctx = ctx.clone();
            let sem = semaphore.clone();
            async move {
                let _permit = sem.acquire().await.unwrap();
                process_model(model, ctx).await
            }
        })
        .buffer_unordered(10)
        .collect::<Vec<_>>()
        .await;
    
    eprintln!("Image processing completed.");

    // 4. Generate SQL and count successes
    let mut sql = String::from("-- Auto-generated upsert SQL\n");
    sql.push_str(&debug_header);
    
    let mut total_models = 0;
    let mut models_with_images = 0;
    
    for res in results {
        if let Some((stmt, has_image, logs)) = res {
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
    
    eprintln!("📊 SQL Generation Summary:");
    eprintln!("  Total models processed: {}", total_models);
    eprintln!("  Models with images: {} ({:.1}%)", models_with_images, (models_with_images as f64 / total_models as f64) * 100.0);
    eprintln!("  Models without images: {}", total_models - models_with_images);

    // 5. Output SQL
    println!("{}", sql);
    eprintln!("SQL generated successfully.");

    Ok(())
}

async fn process_model(model: Model, ctx: Arc<ProcessingContext>) -> Option<(String, bool, String)> {
    // Determine Source
    let source = model.source.clone().unwrap_or_else(|| "huggingface".to_string());

    // Determine Author and Name
    let (author, name) = if let (Some(a), Some(n)) = (&model.author, &model.name) {
        (a.clone(), n.clone())
    } else {
        let parts: Vec<&str> = model.id.split('/').collect();
        if parts.len() >= 2 {
            (parts[0].to_string(), parts[1].to_string())
        } else {
            ("unknown".to_string(), model.id.clone())
        }
    };

    // Generate IDs
    let safe_author = author.replace('/', "-").replace('_', "-");
    let safe_name = name.replace('/', "-").replace('_', "-");
    let db_id = format!("{}-{}-{}", source, safe_author, safe_name);
    let slug = format!("{}--{}--{}", source, safe_author.to_lowercase(), safe_name.to_lowercase());

    let mut logs = String::new();
    
    // Image Logic
    let mut final_image_url = String::from("NULL");
    let mut has_image = false;
    
    if let Some(client) = &ctx.r2_client {
        // 1. Determine Source Image URL
        let src_url = if source == "github" {
             format!("https://github.com/{}.png", author)
        } else {
             // Fallback for HF/Other: UI Avatars
             format!("https://ui-avatars.com/api/?name={}&size=512&background=random&color=fff", name)
        };
        
        eprintln!("[{}] Downloading from: {}", db_id, src_url);
        logs.push_str(&format!("Downloading {} from {}\n", db_id, src_url));

        // 2. Download
        let object_key = format!("models/{}.jpg", db_id);
        
        // Try download
        match reqwest::get(&src_url).await {
            Ok(resp) => {
                if resp.status().is_success() {
                    match resp.bytes().await {
                        Ok(bytes) => {
                            // 3. Upload to R2
                            let bytes_len = bytes.len() as i64;
                            let result = client.put_object()
                                .bucket(&ctx.bucket)
                                .key(&object_key)
                                .body(ByteStream::from(bytes)) // bytes is moved here
                                .content_length(bytes_len)      // Use the pre-calculated length
                                .content_type("image/jpeg")
                                .send()
                                .await;

                            match result {
                                Ok(_) => {
                                    // Success! Construct Public URL
                                    final_image_url = format!("'{}/{}'", ctx.public_url_prefix, object_key);
                                    has_image = true;
                                    eprintln!("[{}] ✅ Image uploaded successfully", db_id);
                                    logs.push_str("Upload success\n");
                                },
                                Err(e) => {
                                    eprintln!("[{}] ❌ R2 upload failed: {}", db_id, e);
                                    logs.push_str(&format!("Upload failed: {}\n", e));
                                },
                            }
                        },
                        Err(e) => {
                            eprintln!("[{}] ❌ Failed to read response bytes: {}", db_id, e);
                            logs.push_str(&format!("Read bytes failed: {}\n", e));
                        },
                    }
                } else {
                    eprintln!("[{}] ❌ HTTP {}: {}", db_id, resp.status(), src_url);
                    logs.push_str(&format!("HTTP error: {}\n", resp.status()));
                }
            },
            Err(e) => {
                eprintln!("[{}] ❌ Network error: {}", db_id, e);
                logs.push_str(&format!("Network error: {}\n", e));
            },
        }
    }

    // Prepare SQL fields
    let pipeline = model.pipeline_tag.clone().unwrap_or_else(|| "other".to_string());
    let tags_json = serde_json::to_string(&model.tags.unwrap_or_default()).unwrap_or("[]".to_string());
    let safe_desc = model.description.unwrap_or_default().replace("'", "''").replace("\n", " ");
    let likes = model.likes.unwrap_or(0);
    let downloads = model.downloads.unwrap_or(0);

    // Generate SQL
    let stmt = format!(
        "INSERT OR REPLACE INTO models (id, slug, name, author, description, tags, pipeline_tag, likes, downloads, cover_image_url, last_updated) VALUES ('{}', '{}', '{}', '{}', '{}', '{}', '{}', {}, {}, {}, CURRENT_TIMESTAMP);\n",
        db_id,
        slug,
        name.replace("'", "''"),
        author.replace("'", "''"),
        safe_desc,
        tags_json.replace("'", "''"),
        pipeline,
        likes,
        downloads,
        final_image_url
    );

    Some((stmt, has_image, logs))
}
