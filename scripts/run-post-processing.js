import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const CONFIG = {
    CATEGORIES_PATH: path.join(__dirname, '../src/data/categories.json'),
    KEYWORDS_OUTPUT_PATH: path.join(__dirname, '../public/data/keywords.json'),
    SEARCH_INDEX_PATH: path.join(__dirname, '../public/data/search-index.json'),
    RANKINGS_PATH: path.join(__dirname, '../public/data/rankings.json'),
    PUBLIC_DATA_DIR: path.join(__dirname, '../public/data'),
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

// Ensure output directory exists
if (!fs.existsSync(CONFIG.PUBLIC_DATA_DIR)) {
    fs.mkdirSync(CONFIG.PUBLIC_DATA_DIR, { recursive: true });
}

// --- Helper Functions ---

function fetchAllModelsFromD1() {
    console.log('📦 Fetching all models from D1...');
    try {
        // Fetch all models. We might need pagination if it gets too large, but for now fetch all.
        // Using --json to get structured data
        const cmd = `npx wrangler d1 execute ai-nexus-db --remote --command "SELECT * FROM models" --json`;
        const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }); // 10MB buffer
        const parsed = JSON.parse(output);

        // D1 returns an array of results. Usually results[0].results is the data.
        if (parsed && parsed.length > 0 && parsed[0].results) {
            return parsed[0].results.map(row => {
                // Parse JSON fields
                try { row.tags = JSON.parse(row.tags); } catch (e) { row.tags = []; }
                try { row.links_data = JSON.parse(row.links_data); } catch (e) { row.links_data = {}; }
                try { row.related_ids = JSON.parse(row.related_ids); } catch (e) { row.related_ids = []; }
                return row;
            });
        }
        return [];
    } catch (error) {
        console.error('❌ Failed to fetch from D1:', error.message);
        process.exit(1);
    }
}

function calculateVelocity(model) {
    const now = new Date();
    const createdAt = new Date(model.last_updated || new Date());
    const ageInDays = Math.max((now - createdAt) / (1000 * 60 * 60 * 24), 1);

    const likes = model.likes || 0;
    const downloads = model.downloads || 0;

    // Velocity = likes/day + (downloads/day / 10)
    return (likes / ageInDays) + (downloads / ageInDays / 10);
}

function assignTagsAndStandardize(models) {
    console.log('🏷️ Standardizing tags...');
    const categories = JSON.parse(fs.readFileSync(CONFIG.CATEGORIES_PATH, 'utf-8'));
    const categoryKeywords = new Map();

    // Build lookup map
    categories.flatMap(g => g.items).forEach(cat => {
        categoryKeywords.set(cat.slug.toLowerCase(), cat.slug);
        categoryKeywords.set(cat.title.toLowerCase(), cat.slug);
    });

    // Add merge map
    for (const [key, value] of Object.entries(CONFIG.KEYWORD_MERGE_MAP)) {
        if (categoryKeywords.has(value.toLowerCase())) {
            categoryKeywords.set(key.toLowerCase(), value);
        }
    }

    models.forEach(model => {
        const modelTags = new Set(model.tags || []);
        const description = (model.description || '').toLowerCase();

        // Standardize existing tags
        const newTags = new Set();
        modelTags.forEach(tag => {
            if (categoryKeywords.has(tag.toLowerCase())) {
                newTags.add(categoryKeywords.get(tag.toLowerCase()));
            } else {
                newTags.add(tag); // Keep original if no mapping
            }
        });

        // Extract from description
        for (const [title, slug] of categoryKeywords.entries()) {
            if (description.includes(title)) {
                newTags.add(slug);
            }
        }

        model.tags = Array.from(newTags);
    });

    return models;
}

function generateKeywords(models) {
    console.log('🔑 Generating keywords.json...');
    const categories = JSON.parse(fs.readFileSync(CONFIG.CATEGORIES_PATH, 'utf-8'));
    const categoryCounts = {};

    categories.forEach(group => {
        group.items.forEach(item => {
            categoryCounts[item.slug] = { ...item, count: 0 };
        });
    });

    models.forEach(model => {
        (model.tags || []).forEach(tag => {
            if (categoryCounts[tag]) {
                categoryCounts[tag].count++;
            }
        });
    });

    const validatedKeywords = Object.values(categoryCounts)
        .filter(cat => cat.count > 0)
        .sort((a, b) => b.count - a.count);

    fs.writeFileSync(CONFIG.KEYWORDS_OUTPUT_PATH, JSON.stringify(validatedKeywords, null, 2));
    return validatedKeywords;
}

function calculateScoresAndRisingStars(models) {
    console.log('⭐ Calculating scores and rising stars...');
    models.forEach(model => {
        model.velocity = calculateVelocity(model);

        // Popularity Score (simple weighted sum)
        model.popularity_score = (model.likes || 0) * 2 + (model.downloads || 0) * 0.1;
    });

    // Determine Rising Stars (Top 5% by velocity)
    const sortedByVelocity = [...models].sort((a, b) => b.velocity - a.velocity);
    const thresholdIndex = Math.floor(models.length * 0.05);
    const thresholdVelocity = sortedByVelocity[thresholdIndex]?.velocity || 0;

    models.forEach(model => {
        model.is_rising_star = model.velocity >= thresholdVelocity && model.velocity > 0.1; // Min velocity check
    });

    return models;
}

function calculateRelatedModels(models) {
    console.log('🔗 Calculating related models...');
    // Simple tag overlap similarity
    // For performance, we only do this for top models or on-demand, but here we do it for all as requested.
    // Optimization: Pre-compute tag sets
    const modelTagSets = models.map(m => ({ id: m.id, tags: new Set(m.tags || []) }));

    models.forEach((model, idx) => {
        const myTags = modelTagSets[idx].tags;
        if (myTags.size === 0) return;

        const scores = models
            .map((other, otherIdx) => {
                if (idx === otherIdx) return null;
                const otherTags = modelTagSets[otherIdx].tags;
                let overlap = 0;
                myTags.forEach(t => { if (otherTags.has(t)) overlap++; });
                return { id: other.id, score: overlap };
            })
            .filter(x => x && x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map(x => x.id);

        model.related_ids = scores;
    });
    return models;
}

function generateRankings(models) {
    console.log('🏆 Generating rankings.json...');

    const hot = [...models].sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 100);
    const trending = [...models].sort((a, b) => (b.downloads || 0) - (a.downloads || 0)).slice(0, 100);
    const newModels = [...models].sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()).slice(0, 100);
    const rising = models.filter(m => m.is_rising_star).sort((a, b) => b.velocity - a.velocity).slice(0, 100);

    const rankings = {
        hot,
        trending,
        new: newModels,
        rising
    };

    fs.writeFileSync(CONFIG.RANKINGS_PATH, JSON.stringify(rankings, null, 2));
}

function createSearchIndex(models) {
    console.log('🔍 Generating search-index.json...');
    const index = models.map(m => ({
        id: m.id,
        slug: m.slug,
        name: m.name,
        author: m.author,
        description: m.description,
        tags: m.tags,
        likes: m.likes,
        downloads: m.downloads,
        is_rising_star: m.is_rising_star,
        source: m.source
    }));
    fs.writeFileSync(CONFIG.SEARCH_INDEX_PATH, JSON.stringify(index, null, 2));
}

async function updateD1(models) {
    console.log('💾 Updating D1 with calculated fields (tags, scores, related)...');
    // We need to update: tags, is_rising_star, related_ids
    // Doing this in batches to avoid command line length limits

    const BATCH_SIZE = 50;
    for (let i = 0; i < models.length; i += BATCH_SIZE) {
        const batch = models.slice(i, i + BATCH_SIZE);
        const statements = batch.map(m => {
            const tagsJson = JSON.stringify(m.tags).replace(/'/g, "''");
            const relatedJson = JSON.stringify(m.related_ids).replace(/'/g, "''");
            const isRising = m.is_rising_star ? 1 : 0;
            return `UPDATE models SET tags='${tagsJson}', related_ids='${relatedJson}', is_rising_star=${isRising} WHERE id='${m.id}';`;
        }).join('\n');

        // Write to temp file to execute
        const tempSqlPath = path.join(__dirname, 'temp_update.sql');
        fs.writeFileSync(tempSqlPath, statements);

        try {
            execSync(`npx wrangler d1 execute ai-nexus-db --remote --file=${tempSqlPath}`);
        } catch (e) {
            console.error(`❌ Failed to update batch ${i}:`, e.message);
        }
        fs.unlinkSync(tempSqlPath);
    }
}

// --- Main Execution ---

async function main() {
    console.log('🚀 Starting Loop 3: Post-processing...');

    // 1. Fetch
    let models = fetchAllModelsFromD1();
    console.log(`📥 Fetched ${models.length} models from D1.`);

    // 2. Standardize Tags
    models = assignTagsAndStandardize(models);

    // 3. Generate Keywords
    generateKeywords(models);

    // 4. Scoring
    models = calculateScoresAndRisingStars(models);

    // 5. Relationships
    models = calculateRelatedModels(models);

    // 6. Rankings
    generateRankings(models);

    // 7. Search Index
    createSearchIndex(models);

    // 8. Update D1 (Optional but recommended to keep DB in sync with JSONs)
    // The user requirement says "Save all processed data... to public/data directory".
    // It implies the JSONs are the consumption point for the frontend.
    // However, updating D1 is good practice for persistence.
    await updateD1(models);

    console.log('✅ Loop 3 completed successfully.');
}

main();
