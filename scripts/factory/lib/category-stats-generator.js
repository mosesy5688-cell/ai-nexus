/**
 * Category Stats Generator Module V14.4
 * Constitution Reference: Art 3.1 (Aggregator Output)
 * 
 * Generates category_stats.json for homepage category display
 */

import fs from 'fs/promises';
import path from 'path';

// V6 Category Mapping (per UX Strategy V2.0)
const CATEGORY_MAP = {
    'text-generation': 'Text Generation & Content Creation',
    'knowledge-retrieval': 'Knowledge Retrieval & RAG',
    'vision-multimedia': 'Vision & Multimedia',
    'automation-workflow': 'Automation & Workflow',
    'infrastructure-ops': 'Infrastructure & Ops',
};

// Pipeline tag to category mapping
const PIPELINE_TO_CATEGORY = {
    'text-generation': 'text-generation',
    'text2text-generation': 'text-generation',
    'summarization': 'text-generation',
    'translation': 'text-generation',
    'conversational': 'text-generation',
    'question-answering': 'knowledge-retrieval',
    'fill-mask': 'knowledge-retrieval',
    'feature-extraction': 'knowledge-retrieval',
    'sentence-similarity': 'knowledge-retrieval',
    'text-retrieval': 'knowledge-retrieval',
    'image-classification': 'vision-multimedia',
    'image-segmentation': 'vision-multimedia',
    'object-detection': 'vision-multimedia',
    'image-to-image': 'vision-multimedia',
    'image-to-text': 'vision-multimedia',
    'text-to-image': 'vision-multimedia',
    'text-to-video': 'vision-multimedia',
    'video-classification': 'vision-multimedia',
    'automatic-speech-recognition': 'vision-multimedia',
    'text-to-speech': 'vision-multimedia',
    'audio-classification': 'vision-multimedia',
    'reinforcement-learning': 'automation-workflow',
    'robotics': 'automation-workflow',
    'tabular-classification': 'infrastructure-ops',
    'tabular-regression': 'infrastructure-ops',
};

/**
 * Generate category statistics from entities
 */
export async function generateCategoryStats(entities, outputDir = './output') {
    console.log('[CATEGORY] Generating category_stats.json...');

    const cacheDir = path.join(outputDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });

    // Initialize counters
    const stats = {};
    for (const [key, label] of Object.entries(CATEGORY_MAP)) {
        stats[key] = {
            id: key,
            label: label,
            count: 0,
            top_models: [],
        };
    }

    // Count entities by category
    const modelsByCategory = {};
    for (const entity of entities) {
        if (entity.type !== 'model' && entity.type !== undefined) continue;

        const pipelineTag = entity.pipeline_tag || entity.tags?.[0] || '';
        const category = PIPELINE_TO_CATEGORY[pipelineTag] || 'text-generation';

        if (stats[category]) {
            stats[category].count++;

            // Track for top models
            if (!modelsByCategory[category]) {
                modelsByCategory[category] = [];
            }
            modelsByCategory[category].push({
                id: entity.id,
                name: entity.name || entity.slug,
                fni: entity.fni || entity.fni_score || 0,
            });
        }
    }

    // Add top 5 models per category
    for (const [category, models] of Object.entries(modelsByCategory)) {
        const sorted = models.sort((a, b) => (b.fni || 0) - (a.fni || 0));
        stats[category].top_models = sorted.slice(0, 5).map(m => ({
            id: m.id,
            name: m.name,
        }));
    }

    // Output format
    const output = {
        categories: Object.values(stats),
        total_models: entities.filter(e => !e.type || e.type === 'model').length,
        _generated: new Date().toISOString(),
    };

    const content = JSON.stringify(output, null, 2);
    const filePath = path.join(cacheDir, 'category_stats.json');
    await fs.writeFile(filePath, content);

    console.log(`  [CATEGORY] ${Object.keys(stats).length} categories, ${output.total_models} models`);
    for (const [key, data] of Object.entries(stats)) {
        if (data.count > 0) {
            console.log(`    - ${key}: ${data.count} models`);
        }
    }
}
