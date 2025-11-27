import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RAW_DATA_PATH = path.join(__dirname, '../data/raw.json');
const MERGED_DATA_PATH = path.join(__dirname, '../data/merged.json');

const NSFW_KEYWORDS = [
    'nsfw', 'porn', 'sexy', 'explicit', 'erotic', 'nude', 'naked', 'adult', 'xxx', 'hentai'
];

function isNsfw(model) {
    const name = (model.name || '').toLowerCase();
    const description = (model.description || '').toLowerCase();
    const tags = (model.tags || []).map(t => t.toLowerCase());

    for (const keyword of NSFW_KEYWORDS) {
        if (name.includes(keyword) || description.includes(keyword) || tags.includes(keyword)) {
            return true;
        }
    }
    return false;
}

function processData() {
    console.log('🔄 Starting Loop 1.5: Data Pre-processing...');

    if (!fs.existsSync(RAW_DATA_PATH)) {
        console.error('❌ Raw data file not found:', RAW_DATA_PATH);
        process.exit(1);
    }

    const rawData = JSON.parse(fs.readFileSync(RAW_DATA_PATH, 'utf-8'));
    console.log(`📦 Loaded ${rawData.length} raw models.`);

    // 1. Filter NSFW
    const safeModels = rawData.filter(model => !isNsfw(model));
    console.log(`🛡️ Filtered ${rawData.length - safeModels.length} NSFW models. Remaining: ${safeModels.length}`);

    // 2. Merge Duplicates (by ID)
    // In a multi-source environment, we might have collisions or intentional overlaps.
    // For now, we prioritize the first occurrence but merge stats if possible.
    // Since our collectors use source-prefixed IDs (e.g. 'huggingface-author-name'), collisions should be rare unless cross-source.
    // However, we might want to normalize IDs further or handle same-model-different-source later.
    // For this phase, we stick to simple ID deduplication to ensure unique keys for D1.

    const mergedMap = new Map();

    safeModels.forEach(model => {
        // Ensure ID is robust
        if (!model.id) return;

        if (mergedMap.has(model.id)) {
            const existing = mergedMap.get(model.id);
            // Merge logic: keep max likes/downloads, combine tags
            existing.likes = Math.max(existing.likes || 0, model.likes || 0);
            existing.downloads = Math.max(existing.downloads || 0, model.downloads || 0);

            // Merge tags
            const existingTags = new Set(existing.tags || []);
            (model.tags || []).forEach(t => existingTags.add(t));
            existing.tags = Array.from(existingTags);

            // Keep the longer description
            if ((model.description || '').length > (existing.description || '').length) {
                existing.description = model.description;
            }
        } else {
            mergedMap.set(model.id, model);
        }
    });

    const mergedModels = Array.from(mergedMap.values());
    console.log(`✨ Merged into ${mergedModels.length} unique models.`);

    // 3. Output
    fs.writeFileSync(MERGED_DATA_PATH, JSON.stringify(mergedModels, null, 2));
    console.log(`✅ Saved merged data to ${MERGED_DATA_PATH}`);
}

processData();
