import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import util from 'util';
import sharp from 'sharp';
import FormData from 'form-data';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execPromise = util.promisify(exec);

// --- Configuration ---
const CONFIG = {
    HUGGINGFACE_API_BASE_URL: 'https://huggingface.co/api/models?sort=likes&direction=-1&limit=100&filter=text-generation,llm&modelType=model',
    DB_NAME: 'ai-nexus-db',
    R2_BUCKET_NAME: 'ai-nexus-assets',
    R2_PUBLIC_DOMAIN: 'https://img.free2aitools.com',
    CATEGORIES_PATH: path.join(__dirname, '../src/data/categories.json'),
    KEYWORD_MERGE_MAP: {
        'gpt-4': 'gpt', 'chatgpt': 'gpt', 'chat': 'general-dialogue-qa', 'chatbot': 'general-dialogue-qa',
        'conversational': 'general-dialogue-qa', 'summarization': 'summarization-extraction',
        'translation': 'translation-localization', 'code': 'code-generation-assistance', 'coding': 'code-generation-assistance',
        'llms': 'llm', 'agent': 'agents', 'ai-agents': 'agents', 'large-language-model': 'large-language-models',
        'prompts': 'prompt', 'tools': 'tool', 'image-generation': 'image-generation', 'text-to-image': 'image-generation',
        'video-generation': 'video-generation-editing', 'text-to-video': 'video-generation-editing',
        'rag': 'rag-knowledge-base-qa', 'retrieval-augmented-generation': 'rag-knowledge-base-qa',
        'data-analysis': 'data-analysis-insights', 'analytics': 'data-analysis-insights',
        'visualization': 'data-analysis-insights', 'statistics': 'data-analysis-insights',
        'sql': 'data-analysis-insights', 'pandas': 'data-analysis-insights'
    }
};

// --- Source Detection (Constitution V4.3.2) ---

/**
 * Detect the source of a model based on URL patterns and author names
 * Constitution V4.3.2 Compliant - Multi-channel source detection
 * @param {Object} model - Model object with source_url, url, author, id fields
 * @returns {string} - Detected source identifier
 */
function detectSource(model) {
    const sourceUrl = model.source_url || model.url || '';
    const author = (model.author || model.id?.split('/')[0] || '').toLowerCase();
    const modelId = (model.id || '').toLowerCase();

    // Priority 1: URL-based detection (highest confidence)
    const urlPatterns = {
        'huggingface.co': 'huggingface',
        'github.com': 'github',
        'arxiv.org': 'arxiv',
        'paperswithcode.com': 'paperswithcode',
        'civitai.com': 'civitai',
        'ollama.ai': 'ollama',
        'ollama.com': 'ollama'
    };

    for (const [domain, source] of Object.entries(urlPatterns)) {
        if (sourceUrl.includes(domain)) return source;
    }

    // Priority 2: ID prefix detection
    if (modelId.startsWith('huggingface:')) return 'huggingface';
    if (modelId.startsWith('github:')) return 'github';
    if (modelId.startsWith('arxiv:')) return 'arxiv';

    // Priority 3: Author-based detection (company models)
    const authorMap = {
        'x-ai': 'xai', 'xai': 'xai',
        'apple': 'apple', 'nvidia': 'nvidia',
        'google': 'google', 'google-deepmind': 'google',
        'meta': 'meta', 'meta-llama': 'huggingface',
        'microsoft': 'microsoft', 'anthropic': 'anthropic',
        'openai': 'openai', 'mistralai': 'huggingface',
        'qwen': 'huggingface', 'alibaba': 'huggingface',
        'deepseek-ai': 'huggingface', 'cohere': 'cohere',
        'amazon': 'amazon', 'stability': 'stability',
        'huggingface': 'huggingface'
    };

    // Check exact author match
    if (authorMap[author]) return authorMap[author];

    // Check partial author match
    for (const [key, source] of Object.entries(authorMap)) {
        if (author.includes(key)) return source;
    }

    // Default: Check if ID looks like HuggingFace format (author/model-name)
    if (modelId.includes('/') && !modelId.includes(':')) {
        return 'huggingface';
    }

    return 'unknown';
}

// --- Helper Functions ---

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Execute SQL on D1 via Wrangler using a temporary file
async function executeD1(sql) {
    const tempFile = path.join(__dirname, `temp_${Date.now()}.sql`);
    fs.writeFileSync(tempFile, sql);

    // Check for --local flag
    const isLocal = process.argv.includes('--local');
    const targetFlag = isLocal ? '--local' : '--remote';

    const command = `npx wrangler d1 execute ${CONFIG.DB_NAME} ${targetFlag} --file "${tempFile}"`;

    try {
        const { stdout } = await execPromise(command);
        // Clean up
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
        return stdout;
    } catch (error) {
        console.error(`❌ D1 Error: ${error.message}`);
        // Clean up on error too
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
        throw error;
    }
}

// R2 Client Setup
let s3Client = null;
if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
    s3Client = new S3Client({
        region: "auto",
        endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function uploadToR2(buffer, filename, contentType) {
    if (!s3Client) {
        // console.warn("⚠️ R2 Credentials not found. Skipping upload.");
        return null;
    }
    try {
        const command = new PutObjectCommand({
            Bucket: CONFIG.R2_BUCKET_NAME,
            Key: filename,
            Body: buffer,
            ContentType: contentType,
        });
        await s3Client.send(command);
        return `${CONFIG.R2_PUBLIC_DOMAIN}/${filename}`;
    } catch (error) {
        console.error(`❌ R2 Upload Error: ${error.message}`);
        return null;
    }
}

// --- Core Logic ---

async function fetchModelsFromHuggingFace() {
    console.log('📡 Fetching models from Hugging Face...');
    try {
        const response = await axios.get(CONFIG.HUGGINGFACE_API_BASE_URL);
        return response.data;
    } catch (error) {
        console.error('❌ Error fetching from HF:', error.message);
        return [];
    }
}

function assignTagsToModel(models) {
    console.log('🏷️ Assigning tags...');
    let categories = [];
    try {
        categories = JSON.parse(fs.readFileSync(CONFIG.CATEGORIES_PATH, 'utf-8'));
    } catch (e) {
        console.warn("⚠️ Could not load categories.json, skipping tag mapping.");
        return models;
    }

    const categoryKeywords = new Map();

    // Build keyword map
    categories.flatMap(g => g.items).forEach(cat => {
        categoryKeywords.set(cat.slug.toLowerCase(), cat.slug);
        categoryKeywords.set(cat.title.toLowerCase(), cat.slug);
    });
    for (const [key, value] of Object.entries(CONFIG.KEYWORD_MERGE_MAP)) {
        if (categoryKeywords.has(value.toLowerCase())) {
            categoryKeywords.set(key.toLowerCase(), value);
        }
    }

    return models.map(model => {
        const tags = new Set();
        // Add pipeline tag
        if (model.pipeline_tag) {
            if (categoryKeywords.has(model.pipeline_tag.toLowerCase())) {
                tags.add(categoryKeywords.get(model.pipeline_tag.toLowerCase()));
            }
        }
        // Check model tags
        if (model.tags) {
            model.tags.forEach(tag => {
                if (categoryKeywords.has(tag.toLowerCase())) {
                    tags.add(categoryKeywords.get(tag.toLowerCase()));
                }
            });
        }
        // Check merge map
        for (const key of Object.keys(CONFIG.KEYWORD_MERGE_MAP)) {
            if (model.id.toLowerCase().includes(key) || (model.tags && model.tags.includes(key))) {
                tags.add(CONFIG.KEYWORD_MERGE_MAP[key]);
            }
        }

        return {
            ...model,
            processed_tags: Array.from(tags)
        };
    });
}

async function processImage(model) {
    // Placeholder for image processing
    return null;
}

async function batchInsertToD1(models) {
    console.log(`💾 Inserting ${models.length} models into D1 (${process.argv.includes('--local') ? 'LOCAL' : 'REMOTE'})...`);

    // We process in chunks to avoid command line length limits
    const CHUNK_SIZE = 10;
    for (let i = 0; i < models.length; i += CHUNK_SIZE) {
        const chunk = models.slice(i, i + CHUNK_SIZE);
        const values = chunk.map(m => {
            const id = m.id.replace(/'/g, "''"); // Escape single quotes
            const name = (m.modelId || m.id.split('/').pop()).replace(/'/g, "''");
            const author = (m.author || m.id.split('/')[0]).replace(/'/g, "''");
            const desc = (m.description || '').replace(/'/g, "''");
            const tags = JSON.stringify(m.processed_tags || []).replace(/'/g, "''");
            const pipeline = (m.pipeline_tag || '').replace(/'/g, "''");
            const likes = m.likes || 0;
            const downloads = m.downloads || 0;
            const createdAt = m.createdAt || new Date().toISOString();
            const now = new Date().toISOString();

            return `('${id}', '${name}', '${author}', '${desc}', '${tags}', '${pipeline}', ${likes}, ${downloads}, '${createdAt}', '${now}')`;
        }).join(',');

        const sql = `
            INSERT INTO models (id, name, author, description, tags, pipeline_tag, likes, downloads, created_at, last_updated)
            VALUES ${values}
            ON CONFLICT(id) DO UPDATE SET
                likes = excluded.likes,
                downloads = excluded.downloads,
                last_updated = excluded.last_updated,
                tags = excluded.tags;
        `;

        await executeD1(sql);
        process.stdout.write('.');
    }
    console.log('\n✅ Batch insert complete.');
}

// --- Main Execution ---

async function main() {
    console.log('🚀 Starting V3 Data Fetch...');

    // 1. Fetch from HF
    const models = await fetchModelsFromHuggingFace();
    if (models.length === 0) {
        console.log('⚠️ No models found. Exiting.');
        return;
    }
    console.log(`📥 Fetched ${models.length} models.`);

    // 2. Assign Tags
    const taggedModels = assignTagsToModel(models);

    // 3. Process Images (Skipped for now)
    // for (const model of taggedModels) {
    //     model.image_url = await processImage(model);
    // }

    // 4. Insert into D1
    await batchInsertToD1(taggedModels);
}

main().catch(console.error);
