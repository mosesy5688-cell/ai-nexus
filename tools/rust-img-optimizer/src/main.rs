use clap::Parser;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Input JSON file path
    #[arg(short, long)]
    input: String,

    /// Upload to R2
    #[arg(long)]
    upload: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct Model {
    id: String,
    likes: i32,
    downloads: i32,
    tags: Vec<String>,
    pipeline_tag: Option<String>,
    author: Option<String>,
    // Add other fields as needed
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    println!("Processing input: {}", args.input);

    // 1. Read JSON
    let data = fs::read_to_string(&args.input)?;
    let models: Vec<Model> = serde_json::from_str(&data)?;
    println!("Found {} models", models.len());

    // 2. Generate SQL
    let mut sql = String::from("-- Auto-generated upsert SQL\n");
    
    for model in models {
        // Simplified logic: Generate INSERT OR REPLACE statements
        // In a real implementation, we would process images here and update cover_image_url
        
        let author = model.author.unwrap_or_else(|| "unknown".to_string());
        let pipeline = model.pipeline_tag.unwrap_or_else(|| "other".to_string());
        let tags_json = serde_json::to_string(&model.tags).unwrap_or("[]".to_string());
        
        // Escape strings (very basic, should use parameterized queries in app, but this is generating a script)
        let safe_desc = "Auto-ingested description"; 
        
        let stmt = format!(
            "INSERT OR REPLACE INTO models (id, name, author, description, tags, pipeline_tag, likes, downloads, last_updated) VALUES ('{}', '{}', '{}', '{}', '{}', '{}', {}, {}, CURRENT_TIMESTAMP);\n",
            model.id,
            model.id, // Name defaults to ID for now
            author,
            safe_desc,
            tags_json.replace("'", "''"),
            pipeline,
            model.likes,
            model.downloads
        );
        sql.push_str(&stmt);
    }

    // 3. Write SQL to file (at repo root)
    let output_path = Path::new("../../data/upsert.sql");
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output_path, sql)?;
    println!("SQL written to {:?}", output_path);

    if args.upload {
        println!("Upload flag set - Image processing would happen here.");
        // Implement R2 upload logic using aws-sdk-s3
    }

    Ok(())
}
