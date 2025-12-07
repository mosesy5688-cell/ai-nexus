// tools/rust-img-optimizer/src/main.rs

use clap::Parser;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

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
    // V3.1 Schema Fields
    source_trail: Option<String>,
    commercial_slots: Option<String>,
    notebooklm_summary: Option<String>,
    velocity_score: Option<f64>,
    last_commercial_at: Option<String>,
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

    // ==================== Create temporary images directory ====================
    fs::create_dir_all("data/images")?;

    // ==================== Load JSON data with robust error handling ====================
    let data = match fs::read_to_string(&args.input) {
        Ok(content) => content,
        Err(e) => {
            eprintln!("❌ FATAL: Could not read input file '{}': {}", args.input, e);
            eprintln!("📋 Health Check: FAILED - Input file not accessible");
            std::process::exit(1);
        }
    };

    // Handle empty file gracefully
    if data.trim().is_empty() {
        eprintln!("⚠️ WARNING: Input file is empty. Generating empty SQL files.");
        eprintln!("📋 Health Check: WARN - No models to process");
        
        // Generate empty SQL files to prevent downstream failures
        fs::write("data/upsert.sql", "-- Empty: No models in input\n")?;
        fs::write("data/update_urls.sql", "-- Empty: No models in input\n")?;
        return Ok(());
    }

    let models: Vec<Model> = match serde_json::from_str(&data) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("❌ FATAL: JSON parse error: {}", e);
            eprintln!("📋 Health Check: FAILED - Malformed JSON");
            std::process::exit(1);
        }
    };

    // Validate we have models
    if models.is_empty() {
        eprintln!("⚠️ WARNING: JSON parsed but contains 0 models.");
        eprintln!("📋 Health Check: WARN - Empty model array");
        fs::write("data/upsert.sql", "-- Empty: 0 models in array\n")?;
        fs::write("data/update_urls.sql", "-- Empty: 0 models in array\n")?;
        return Ok(());
    }

    eprintln!("✅ Found {} models in the file", models.len());
    eprintln!("📋 Health Check: OK - Ready to process");

    // ==================== Process models concurrently ====================
    let semaphore = Arc::new(Semaphore::new(10));

    eprintln!("Starting concurrent image processing for {} models...", models.len());

    let handles: Vec<JoinHandle<Option<(String, Option<String>, String)>>> = models
        .into_iter()
        .map(|model| {
            let sem = Arc::clone(&semaphore);
            tokio::spawn(async move {
                let _permit = sem.acquire().await.unwrap();
                process_model(model).await
            })
        })
        .collect();

    let results = join_all(handles).await;

    // ==================== Generate SQL output ====================
    let mut upsert_sql = String::from("-- Auto-generated upsert SQL\n");
    let mut update_sql = String::from("-- Auto-generated update URLs SQL\n");
    
    upsert_sql.push_str(&debug_header);
    update_sql.push_str(&debug_header);

    let mut total_models = 0;
    let mut models_with_images = 0;

    for result in results {
        if let Ok(Some((upsert_stmt, update_stmt, logs))) = result {
            upsert_sql.push_str(&upsert_stmt);
            
            if let Some(update) = update_stmt {
                update_sql.push_str(&update);
                models_with_images += 1;
            }

            if !logs.is_empty() {
                let log_comment = format!("/* LOGS:\n{}\n*/\n", logs);
                upsert_sql.push_str(&log_comment);
                update_sql.push_str(&log_comment);
            }
            total_models += 1;
        }
    }

    let mut upsert_file = File::create("data/upsert.sql")?;
    upsert_file.write_all(upsert_sql.as_bytes())?;

    let mut update_file = File::create("data/update_urls.sql")?;
    update_file.write_all(update_sql.as_bytes())?;

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

    eprintln!("SQL generated successfully.");

    Ok(())
}

async fn process_model(model: Model) -> Option<(String, Option<String>, String)> {
    let source = model.source.clone().unwrap_or_else(|| "huggingface".to_string());

    let (author, name) = if let (Some(a), Some(n)) = (model.author.clone(), model.name.clone()) {
        (a, n)
    } else {
        let parts: Vec<String> = model.id.split('/').map(|s| s.to_string()).collect();
        if parts.len() >= 2 {
            (parts[0].clone(), parts[1].clone())
        } else {
            ("unknown".to_string(), model.id.clone())
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

    // ==================== Build Upsert SQL (Base Data) ====================
    let pipeline = model.pipeline_tag.unwrap_or_else(|| "other".to_string());
    let tags_json = serde_json::to_string(&model.tags.unwrap_or_default()).unwrap_or("[]".to_string());
    let safe_desc = model.description.unwrap_or_default().replace('\'', "''").replace('\n', " ");

    // V3.1 Schema: Handle new fields
    let source_trail = model.source_trail.clone().map(|s| format!("'{}'", s.replace('\'', "''"))).unwrap_or("NULL".to_string());
    let commercial_slots = model.commercial_slots.clone().map(|s| format!("'{}'", s.replace('\'', "''"))).unwrap_or("NULL".to_string());
    let notebooklm_summary = model.notebooklm_summary.clone().map(|s| format!("'{}'", s.replace('\'', "''"))).unwrap_or("NULL".to_string());
    let velocity_score = model.velocity_score.map(|v| v.to_string()).unwrap_or("NULL".to_string());
    let last_commercial_at = model.last_commercial_at.clone().map(|s| format!("'{}'", s)).unwrap_or("NULL".to_string());

    let upsert_stmt = format!(
        "INSERT OR REPLACE INTO models (id, slug, name, author, description, tags, pipeline_tag, likes, downloads, cover_image_url, source_trail, commercial_slots, notebooklm_summary, velocity_score, last_commercial_at, last_updated) VALUES ('{}', '{}', '{}', '{}', '{}', '{}', '{}', {}, {}, NULL, {}, {}, {}, {}, {}, CURRENT_TIMESTAMP);\n",
        db_id,
        slug,
        name.replace('\'', "''"),
        author.replace('\'', "''"),
        safe_desc,
        tags_json.replace('\'', "''"),
        pipeline,
        model.likes.unwrap_or(0),
        model.downloads.unwrap_or(0),
        source_trail,
        commercial_slots,
        notebooklm_summary,
        velocity_score,
        last_commercial_at
    );

    // ==================== Image Download & Update SQL ====================
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

    let mut update_stmt = None;

    if let Ok(resp) = reqwest::get(src_url).await {
        if resp.status().is_success() {
            if let Ok(body) = resp.bytes().await {
                let file_path = format!("data/images/{}.jpg", db_id);
                if let Ok(mut file) = File::create(&file_path) {
                    if file.write_all(&body).is_ok() {
                        logs.push_str("Image saved locally\n");
                        eprintln!("[{}] Image saved to {}", db_id, file_path);

                        update_stmt = Some(format!(
                            "UPDATE models SET cover_image_url = 'https://cdn.free2aitools.com/models/{}.jpg' WHERE id = '{}';\n",
                            db_id, db_id
                        ));
                    } else {
                        logs.push_str("Failed to write image file\n");
                    }
                } else {
                    logs.push_str("Failed to create image file\n");
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

    Some((upsert_stmt, update_stmt, logs))
}
