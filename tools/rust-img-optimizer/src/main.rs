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
    name: Option<String>,
    source: Option<String>,
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
        // Determine Source
        let source = model.source.clone().unwrap_or_else(|| "huggingface".to_string());

        // Determine Author and Name
        // If provided in JSON, use them. Otherwise fallback to ID parsing.
        let (author, name) = if let (Some(a), Some(n)) = (&model.author, &model.name) {
            (a.clone(), n.clone())
        } else {
            // Fallback: Parse ID (author/name)
            let parts: Vec<&str> = model.id.split('/').collect();
            if parts.len() >= 2 {
                (parts[0].to_string(), parts[1].to_string())
            } else {
                ("unknown".to_string(), model.id.clone())
            }
        };

        // Generate ID: source-author-name (Internal ID)
        // Sanitize to ensure safe characters for DB ID
        let safe_author = author.replace('/', "-").replace('_', "-");
        let safe_name = name.replace('/', "-").replace('_', "-");
        let db_id = format!("{}-{}-{}", source, safe_author, safe_name);
        
        // Generate Slug: source--author--name (URL safe)
        let slug = format!("{}--{}--{}", source, safe_author.to_lowercase(), safe_name.to_lowercase());

        let pipeline = model.pipeline_tag.clone().unwrap_or_else(|| "other".to_string());
        let tags_json = serde_json::to_string(&model.tags).unwrap_or("[]".to_string());
        
        // Escape strings
        let safe_desc = "Auto-ingested description"; 
        
        let stmt = format!(
            "INSERT OR REPLACE INTO models (id, slug, name, author, description, tags, pipeline_tag, likes, downloads, last_updated) VALUES ('{}', '{}', '{}', '{}', '{}', '{}', '{}', {}, {}, CURRENT_TIMESTAMP);\n",
            db_id,
            slug,
            name,
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
