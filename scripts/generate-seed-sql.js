import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_FILE = path.join(__dirname, '../src/data/models.json');
const OUTPUT_FILE = path.join(__dirname, '../seed.sql');

try {
    if (!fs.existsSync(MODELS_FILE)) {
        console.error(`Error: Models file not found at ${MODELS_FILE}`);
        process.exit(1);
    }

    const models = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    console.log(`Generating SQL for ${models.length} models...`);

    let sql = "";

    // D1 doesn't support explicit BEGIN TRANSACTION/COMMIT in wrangler d1 execute
    // Each statement is automatically wrapped in a transaction

    for (const model of models) {
        const escape = (str) => {
            if (str === null || str === undefined) return 'NULL';
            let stringValue = str;
            if (typeof str === 'object') {
                // Handle case where description is an object (e.g. from some API responses)
                stringValue = str.text || str.content || JSON.stringify(str);
            }
            return "'" + String(stringValue).replace(/'/g, "''") + "'";
        };

        const tagsJson = JSON.stringify(model.tags || []);

        // Default values for missing fields
        const id = escape(model.id);
        const name = escape(model.name || model.id.split('/').pop());
        const author = escape(model.author || 'Unknown');

        // Robust description handling
        let desc = model.description || '';
        if (typeof desc === 'object') {
            desc = desc.text || desc.content || JSON.stringify(desc);
        }
        const description = escape(desc);

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

    fs.writeFileSync(OUTPUT_FILE, sql);
    console.log(`Successfully generated ${OUTPUT_FILE}`);

} catch (error) {
    console.error("Error generating SQL:", error);
    process.exit(1);
}
