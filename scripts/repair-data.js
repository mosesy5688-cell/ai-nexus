
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_PATH = path.join(__dirname, '../src/data/models.json');

function repairData() {
    console.log('🔧 Starting V9.25 Data Repair...');

    if (!fs.existsSync(MODELS_PATH)) {
        console.error('❌ models.json not found!');
        process.exit(1);
    }

    let models = [];
    try {
        models = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf-8'));
    } catch (e) {
        console.error('❌ Failed to parse models.json:', e.message);
        process.exit(1);
    }

    console.log(`📦 Scanning ${models.length} models for broken links...`);
    let fixedCount = 0;

    const repairedModels = models.map(model => {
        let changed = false;

        // 1. Fix Download URL (Aggressive V9.25 Fix)
        // Force update for GitHub models to ensure they point to the zip archive, not a 404 HF page
        if (model.id.startsWith('github-')) {
            const sourceUrl = model.sources?.[0]?.url;
            if (sourceUrl && sourceUrl.includes('github.com')) {
                const newUrl = `${sourceUrl}/archive/refs/heads/main.zip`;
                if (model.downloadUrl !== newUrl) {
                    model.downloadUrl = newUrl;
                    changed = true;
                }
            }
        }
        // For non-GitHub models (Hugging Face), only fix if missing
        else if (!model.downloadUrl || model.downloadUrl === null) {
            model.downloadUrl = `https://huggingface.co/${model.id}/tree/main`;
            changed = true;
        }

        // 2. Fix Docs/Readme URL (if we had a specific field for it, but 'sources' covers it)
        // Ensure sources exist
        if (!model.sources || model.sources.length === 0) {
            model.sources = [{
                platform: model.id.startsWith('github-') ? 'GitHub' : 'Hugging Face',
                url: model.id.startsWith('github-') ? `https://github.com/${model.author}/${model.name}` : `https://huggingface.co/${model.id}`,
                license: 'Unknown'
            }];
            changed = true;
        }

        if (changed) fixedCount++;
        return model;
    });

    fs.writeFileSync(MODELS_PATH, JSON.stringify(repairedModels, null, 2));
    console.log(`✅ Repair complete. Fixed ${fixedCount} models.`);
}

repairData();
