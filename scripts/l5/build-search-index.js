// scripts/l5/build-search-index.js
/**
 * V14.2 Static Search Index Generator
 * Constitution: Zero-Cost Compliant
 * 
 * Generates a lightweight JSON index for client-side MiniSearch.
 * Run during L5 Heavy Compute phase.
 * 
 * V14.2.1: Use entities.json (150K+) for 10K index coverage
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Input paths (priority order)
const DATA_SOURCES = [
    { path: path.join(__dirname, '../../data/entities.json'), name: 'entities.json' },
    { path: path.join(__dirname, '../../data/trending.json'), name: 'trending.json' },
    { path: path.join(__dirname, '../../data/cache/trending.json'), name: 'cache/trending.json' },
];
const OUTPUT_PATH = path.join(__dirname, '../../public/data/search-index-top.json');

async function buildIndex() {
    console.log('🔍 [V14.2] Building Static Search Index...');

    // Find first available data source
    for (const source of DATA_SOURCES) {
        if (fs.existsSync(source.path)) {
            console.log(`✅ Using: ${source.name}`);
            return processData(source.path);
        }
    }

    console.error('❌ No data source found. Tried:', DATA_SOURCES.map(s => s.name));
    process.exit(1);
}

function processData(dataPath) {
    const rawData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

    // Handle different data formats
    const models = rawData.models || rawData.data || rawData;

    if (!Array.isArray(models)) {
        console.error('❌ Invalid data format - expected array');
        process.exit(1);
    }

    console.log(`📊 Processing ${models.length} items...`);

    // 1. Sort by FNI Score and take top 10,000
    const topModels = models
        .sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0))
        .slice(0, 10000);

    // 2. Compress fields for minimal JSON size
    // Key mapping: i=id, n=name, s=slug, t=tags, sc=score, a=author
    const indexData = topModels.map(item => {
        // Handle tags - could be string or array
        let tags = item.tags || [];
        if (typeof tags === 'string') {
            tags = tags.split(',').map(t => t.trim());
        }
        if (!Array.isArray(tags)) {
            tags = [];
        }

        return {
            i: item.umid || item.id,
            n: item.name,
            s: item.slug || (item.id ? item.id.replace(/[/:]/g, '--') : ''),
            t: tags.slice(0, 5).join(','),
            sc: item.fni_score || 0,
            a: item.author || ''
        };
    });

    // 3. Ensure output directory exists
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // 4. Write compressed JSON (no pretty print)
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(indexData));

    // Calculate file stats
    const stats = fs.statSync(OUTPUT_PATH);
    const sizeKB = (stats.size / 1024).toFixed(2);

    console.log(`✅ Search Index Generated: ${indexData.length} items`);
    console.log(`📂 Output: ${OUTPUT_PATH}`);
    console.log(`📦 Size: ${sizeKB} KB (Gzip ~${(sizeKB * 0.3).toFixed(0)} KB)`);

    return indexData;
}

// Run
buildIndex().catch(console.error);
