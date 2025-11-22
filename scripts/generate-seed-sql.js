const fs = require('fs');
const path = require('path');

const MODELS_FILE = path.join(__dirname, '../src/data/models.json');
const OUTPUT_FILE = path.join(__dirname, '../seed.sql');

try {
    if (!fs.existsSync(MODELS_FILE)) {
        console.error(`Error: Models file not found at ${MODELS_FILE}`);
        process.exit(1);
    }

    const models = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    console.log(`Generating SQL for ${models.length} models...`);

    let sql = "BEGIN TRANSACTION;\n";

    // Batch size to prevent "statement too long" errors if we were doing multi-value inserts,
    // but here we do individual statements for safety with ON CONFLICT.
    // SQLite can handle many statements in a transaction.

    for (const model of models) {
        const escape = (str) => {
            if (str === null || str === undefined) return 'NULL';
            return "'" + String(str).replace(/'/g, "''") + "'";
        };

        const tagsJson = JSON.stringify(model.tags || []);

        // Default values for missing fields
        const id = escape(model.id);
        const name = escape(model.name || model.id.split('/').pop());
        const author = escape(model.author || 'Unknown');
        const description = escape(model.description || '');
        const tags = escape(tagsJson);
        const pipeline_tag = escape(model.pipeline_tag || model.task || 'unknown');
        const likes = model.likes || 0;
        const downloads = model.downloads || 0;
        const cover_image_url = escape(model.cover_image_url || null);
        const source_url = escape(model.source_url || `https://huggingface.co/${model.id}`);
        const created_at = escape(model.createdAt || new Date().toISOString());

        // Use INSERT INTO ... ON CONFLICT to preserve seo_summary and other enriched fields
        sql += `INSERT INTO models (id, name, author, description, tags, pipeline_tag, likes, downloads, cover_image_url, source_url, created_at) 
VALUES (${id}, ${name}, ${author}, ${description}, ${tags}, ${pipeline_tag}, ${likes}, ${downloads}, ${cover_image_url}, ${source_url}, ${created_at})
ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,
    author=excluded.author,
    description=excluded.description,
    tags=excluded.tags,
    pipeline_tag=excluded.pipeline_tag,
    likes=excluded.likes,
    downloads=excluded.downloads,
    cover_image_url=excluded.cover_image_url,
    source_url=excluded.source_url,
    last_checked=CURRENT_TIMESTAMP;\n`;
    }

    sql += "COMMIT;\n";

    fs.writeFileSync(OUTPUT_FILE, sql);
    console.log(`Successfully generated ${OUTPUT_FILE}`);

} catch (error) {
    console.error("Error generating SQL:", error);
    process.exit(1);
}
