// tools/rust-img-optimizer/src/main.rs
// V3.2: Added WebP conversion and resize support

use clap::Parser;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, File};
use std::io::{Write, Cursor};
use std::path::Path;
use std::sync::Arc;

use futures::future::join_all;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use urlencoding::encode;

// V3.2: Image processing
use image::{ImageFormat, GenericImageView, imageops::FilterType};

/// Safely escape a string for SQL insertion
/// Handles: single quotes, backslashes, newlines, control chars, and non-ASCII
fn escape_sql_string(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 2);
    
    for c in s.chars() {
        match c {
            // Escape single quotes (SQL standard: '' for literal ')
            '\'' => result.push_str("''"),
            // Remove backslashes (can cause issues in some SQL contexts)
            '\\' => result.push(' '),
            // Replace newlines/carriage returns with spaces
            '\n' | '\r' => result.push(' '),
            // Replace tabs with spaces
            '\t' => result.push(' '),
            // Remove null bytes and other control characters
            c if c.is_control() => {}
            // Keep ASCII printable characters
            c if c.is_ascii() => result.push(c),
            // Remove non-ASCII characters for D1 compatibility
            _ => {}
        }
    }
    
    // Collapse multiple spaces into one
    result
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Wrap string in SQL quotes with escaping, or return NULL
fn sql_string_or_null(s: &Option<String>) -> String {
    match s {
        Some(val) if !val.trim().is_empty() => format!("'{}'", escape_sql_string(val)),
        _ => "NULL".to_string()
    }
}

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
    // V3.2 Schema Fields
    #[serde(rename = "type")]
    entity_type: Option<String>,
    body_content: Option<String>,
    meta_json: Option<String>,
    assets_json: Option<String>,
    relations_json: Option<String>,
    canonical_id: Option<String>,
    license_spdx: Option<String>,
    compliance_status: Option<String>,
    quality_score: Option<f64>,
    content_hash: Option<String>,
    velocity: Option<f64>,
    raw_image_url: Option<String>,
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

    // ==================== Create temporary directories ====================
    fs::create_dir_all("data/images")?;
    fs::create_dir_all("data/docs")?;  // V3.1: For full README storage to R2

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
    let safe_desc = escape_sql_string(&model.description.unwrap_or_default());

    // V3.1 Schema: Handle fields with proper escaping
    let source_trail = sql_string_or_null(&model.source_trail);
    let commercial_slots = sql_string_or_null(&model.commercial_slots);
    let notebooklm_summary = sql_string_or_null(&model.notebooklm_summary);
    let velocity_score = model.velocity_score.map(|v| v.to_string()).unwrap_or("NULL".to_string());
    let last_commercial_at = model.last_commercial_at.clone().map(|s| format!("'{}'", escape_sql_string(&s))).unwrap_or("NULL".to_string());

    // V3.2 Schema: Handle new fields
    let entity_type = model.entity_type.as_ref().map(|s| format!("'{}'", escape_sql_string(s))).unwrap_or("'model'".to_string());
    
    // V3.1 Constitution Pillar III: Data Integrity - Full content to R2, no truncation
    // Write body_content to .md file for R2 upload, store URL reference in D1
    let r2_url_prefix = env::var("R2_PUBLIC_URL_PREFIX").unwrap_or_else(|_| "https://cdn.free2aitools.com".to_string());
    let body_content_url = if let Some(content) = &model.body_content {
        if !content.trim().is_empty() {
            // Write full content to .md file (NO TRUNCATION)
            let doc_path = format!("data/docs/{}.md", db_id);
            match fs::write(&doc_path, content) {
                Ok(_) => {
                    logs.push_str(&format!("Saved full README to {}\n", doc_path));
                    format!("'{}/docs/{}.md'", r2_url_prefix, db_id)
                },
                Err(e) => {
                    logs.push_str(&format!("Failed to write doc {}: {}\n", doc_path, e));
                    "NULL".to_string()
                }
            }
        } else {
            "NULL".to_string()
        }
    } else {
        "NULL".to_string()
    };
    
    // Extract first 5KB for FTS5 search index (stored in D1 for search capability)
    let search_text = model.body_content.as_ref().map(|s| {
        let truncated = if s.len() > 5000 { &s[..5000] } else { s.as_str() };
        format!("'{}'", escape_sql_string(truncated))
    }).unwrap_or("NULL".to_string());
    
    // Use escape_sql_string for all JSON and string fields
    let meta_json = sql_string_or_null(&model.meta_json);
    let assets_json = sql_string_or_null(&model.assets_json);
    let relations_json = sql_string_or_null(&model.relations_json);
    let canonical_id = sql_string_or_null(&model.canonical_id);
    let license_spdx = sql_string_or_null(&model.license_spdx);
    let compliance_status = model.compliance_status.clone().map(|s| format!("'{}'", escape_sql_string(&s))).unwrap_or("'pending'".to_string());
    let quality_score = model.quality_score.map(|v| v.to_string()).unwrap_or("NULL".to_string());
    let content_hash = model.content_hash.clone().map(|s| format!("'{}'", s)).unwrap_or("NULL".to_string());
    let velocity = model.velocity.map(|v| v.to_string()).unwrap_or("NULL".to_string());
    let raw_image_url = sql_string_or_null(&model.raw_image_url);

    let upsert_stmt = format!(
        "INSERT OR REPLACE INTO models (id, slug, name, author, description, tags, pipeline_tag, likes, downloads, cover_image_url, source_trail, commercial_slots, notebooklm_summary, velocity_score, last_commercial_at, type, body_content, body_content_url, meta_json, assets_json, relations_json, canonical_id, license_spdx, compliance_status, quality_score, content_hash, velocity, raw_image_url, last_updated) VALUES ('{}', '{}', '{}', '{}', '{}', '{}', '{}', {}, {}, NULL, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, CURRENT_TIMESTAMP);\n",
        escape_sql_string(&db_id),
        escape_sql_string(&slug),
        escape_sql_string(&name),
        escape_sql_string(&author),
        safe_desc,
        escape_sql_string(&tags_json),
        escape_sql_string(&pipeline),
        model.likes.unwrap_or(0),
        model.downloads.unwrap_or(0),
        source_trail,
        commercial_slots,
        notebooklm_summary,
        velocity_score,
        last_commercial_at,
        entity_type,
        search_text,         // body_content now stores search_text (5KB for FTS5)
        body_content_url,    // NEW: R2 URL for full content
        meta_json,
        assets_json,
        relations_json,
        canonical_id,
        license_spdx,
        compliance_status,
        quality_score,
        content_hash,
        velocity,
        raw_image_url
    );

    // ==================== V3.2: Image Download & WebP Conversion ====================
    // Priority: raw_image_url > GitHub avatar > Skip (no placeholder)
    let src_url = model.raw_image_url.clone().or_else(|| {
        if source == "github" {
            Some(format!("https://github.com/{}.png", author))
        } else {
            None // V3.2: No placeholder images
        }
    });

    let mut update_stmt = None;

    if let Some(url) = src_url {
        logs.push_str(&format!("Downloading image for {} from {}\n", db_id, url));
        eprintln!("[{}] Downloading image...", db_id);

        if let Ok(resp) = reqwest::get(&url).await {
            if resp.status().is_success() {
                if let Ok(body) = resp.bytes().await {
                    // V3.2: Decode, resize to 1200px width, convert to WebP
                    match process_image_to_webp(&body, &db_id) {
                        Ok(webp_path) => {
                            logs.push_str(&format!("Image converted to WebP: {}\n", webp_path));
                            eprintln!("[{}] Saved as WebP", db_id);
                            update_stmt = Some(format!(
                                "UPDATE models SET cover_image_url = 'https://cdn.free2aitools.com/models/{}.webp' WHERE id = '{}';\n",
                                db_id, db_id
                            ));
                        }
                        Err(e) => {
                            logs.push_str(&format!("WebP conversion failed: {}\n", e));
                            eprintln!("[{}] WebP conversion failed: {}", db_id, e);
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
    } else {
        logs.push_str("No image URL available, skipping\n");
        eprintln!("[{}] No image URL, skipping", db_id);
    }

    Some((upsert_stmt, update_stmt, logs))
}

/// V3.2: Process image to WebP format with resize
/// - Decodes various formats (JPEG, PNG, GIF, WebP)
/// - Resizes to max 1200px width (maintains aspect ratio)
/// - Converts to WebP with 85% quality
fn process_image_to_webp(data: &[u8], db_id: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    // Decode the image
    let img = image::load_from_memory(data)?;
    
    let (width, height) = img.dimensions();
    
    // Resize if width > 1200px (maintain aspect ratio)
    let resized = if width > 1200 {
        let new_height = (height as f64 * (1200.0 / width as f64)) as u32;
        img.resize(1200, new_height, FilterType::Lanczos3)
    } else {
        img
    };
    
    // Ensure output directory exists
    let output_dir = Path::new("data/images");
    if !output_dir.exists() {
        fs::create_dir_all(output_dir)?;
    }
    
    // Save as WebP
    let file_path = format!("data/images/{}.webp", db_id);
    let output_file = File::create(&file_path)?;
    let mut buffered = std::io::BufWriter::new(output_file);
    
    resized.write_to(&mut buffered, ImageFormat::WebP)?;
    
    Ok(file_path)
}
