/**
 * L5 Category Reclassification Script
 * 
 * Constitutional Compliance:
 * - Art 1.1: Executes in GitHub Actions (Sidecar)
 * - Art 1.2: L8 unchanged, no regex in Workers
 * - Art 7: DRY - imports from category-mapping.js
 * 
 * @module l5/category-reclassify
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { PIPELINE_TO_V6_CATEGORY, CATEGORY_METADATA } from '../../src/utils/category-mapping.js';

// Tier 3: Name-based inference patterns (L5 only - Art 1.1 Sidecar)
const NAME_PATTERNS = {
    'text-generation': /llama|chat|gpt|mistral|qwen|phi|gemma|instruct|falcon|vicuna|alpaca/i,
    'vision-multimedia': /stable.?diffusion|flux|sdxl|dalle|vision|vit|whisper|tts|wav2vec|clip/i,
    'knowledge-retrieval': /embed|bert|bge|e5|retriev|sentence|jina|nomic|gte|minilm|mpnet/i,
    'automation-workflow': /agent|autom|robot|reward|rl|decision|planner/i,
};

function reclassifyEntity(entity) {
    // Tier 1: pipeline_tag exact match
    if (entity.pipeline_tag) {
        const cat = PIPELINE_TO_V6_CATEGORY[entity.pipeline_tag];
        if (cat) return { category: cat, status: 'classified', tier: 1 };
    }

    // Tier 2: tags[] fallback
    const tags = entity.tags || [];
    const tagArray = typeof tags === 'string' ? JSON.parse(tags) : tags;
    if (Array.isArray(tagArray)) {
        for (const tag of tagArray) {
            const cat = PIPELINE_TO_V6_CATEGORY[String(tag).toLowerCase()];
            if (cat) return { category: cat, status: 'classified', tier: 2 };
        }
    }

    // Tier 3: Name pattern inference (L5 Sidecar only)
    const name = (entity.name || entity.id || '').toLowerCase();
    for (const [cat, pattern] of Object.entries(NAME_PATTERNS)) {
        if (pattern.test(name)) return { category: cat, status: 'inferred', tier: 3 };
    }

    // Tier 4: Default fallback
    return { category: 'infrastructure-ops', status: 'default', tier: 4 };
}

async function main() {
    console.log('🏷️  L5 Category Reclassification (Art 1.1 Sidecar ✅)\n');

    const entitiesPath = process.env.ENTITIES_PATH || 'data/entities.json';
    let entities = [];

    if (fs.existsSync(entitiesPath)) {
        entities = JSON.parse(fs.readFileSync(entitiesPath, 'utf8'));
    } else if (fs.existsSync(entitiesPath + '.gz')) {
        const compressed = fs.readFileSync(entitiesPath + '.gz');
        entities = JSON.parse(zlib.gunzipSync(compressed).toString());
    } else {
        console.error('❌ Entities file not found:', entitiesPath);
        process.exit(1);
    }

    console.log(`📦 Loaded ${entities.length} entities\n`);

    const stats = { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
    const categoryStats = {};

    for (const entity of entities) {
        const { category, tier } = reclassifyEntity(entity);
        stats[`tier${tier}`]++;
        categoryStats[category] = (categoryStats[category] || 0) + 1;
    }

    console.log('📊 Classification Results:');
    console.log(`   Tier 1 (pipeline_tag): ${stats.tier1}`);
    console.log(`   Tier 2 (tags[]): ${stats.tier2}`);
    console.log(`   Tier 3 (name pattern): ${stats.tier3}`);
    console.log(`   Tier 4 (default): ${stats.tier4}`);

    console.log('\n📁 Category Distribution:');
    for (const [cat, count] of Object.entries(categoryStats).sort((a, b) => b[1] - a[1])) {
        console.log(`   ${cat}: ${count} (${(count / entities.length * 100).toFixed(1)}%)`);
    }

    // Write category_stats.json
    const outputDir = 'data/computed';
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const output = {
        generated_at: new Date().toISOString(),
        version: 'V6.2',
        categories: Object.entries(CATEGORY_METADATA)
            .filter(([id]) => id !== 'uncategorized')
            .map(([id, meta]) => ({
                category: id, label: meta.label, icon: meta.icon, color: meta.color,
                count: categoryStats[id] || 0, trending: categoryStats[id] || 0
            })),
        classified_count: stats.tier1 + stats.tier2,
        inferred_count: stats.tier3,
        default_count: stats.tier4,
        total_models: entities.length
    };

    fs.writeFileSync(path.join(outputDir, 'category_stats.json'), JSON.stringify(output, null, 2));
    console.log('\n✅ Saved category_stats.json');
}

main().catch(err => { console.error('❌ Error:', err); process.exit(1); });
