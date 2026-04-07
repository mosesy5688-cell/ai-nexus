/**
 * Category Stats Generator Module V14.4
 * Constitution Reference: Art 3.1 (Aggregator Output)
 * 
 * Generates category_stats.json for homepage category display
 */

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';

// V6 Category Mapping (per UX Strategy V2.0)
const CATEGORY_MAP = {
    'text-generation': 'Text Generation & Content Creation',
    'knowledge-retrieval': 'Knowledge Retrieval & RAG',
    'vision-multimedia': 'Vision & Multimedia',
    'automation-workflow': 'Automation & Workflow',
    'infrastructure-ops': 'Infrastructure & Ops',
    'prompts': 'AI Prompts & Templates',
};

// V14.5.1: Map any category string to V6 categories
const CATEGORY_ALIASES = {
    // Pipeline tags
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
    'gguf': 'infrastructure-ops',
    'awq': 'infrastructure-ops',
    'gptq': 'infrastructure-ops',
    'exl2': 'infrastructure-ops',
    'onnx': 'infrastructure-ops',
    'openvino': 'infrastructure-ops',
    'tensorrt': 'infrastructure-ops',
    // Replicate/other source categories
    'audio': 'vision-multimedia',
    'video': 'vision-multimedia',
    'image': 'vision-multimedia',
    'diffusion': 'vision-multimedia',
    'other': 'text-generation',
    'prompts': 'prompts',
};

/**
 * Get V6 category from entity
 */
// V16.7 Tier-3 Pattern Inference Logic
const NAME_PATTERNS = {
    'knowledge-retrieval': /embed|bert|bge|e5|retriev|sentence|jina|nomic|gte|minilm|mpnet|indexing|rag|vector|supabase/i,
    'vision-multimedia': /stable.?diffusion|flux|sdxl|dalle|vision|vit|whisper|tts|wav2vec|clip|upscale|yolo|depth|pose|inpaint/i,
    'automation-workflow': /agent|autom|robot|reward|rl|decision|planner|tool-use|function-call|action|orchestra/i,
    'infrastructure-ops': /quantiz|gguf|awq|gptq|exl2|vllm|sglang|trt-llm|ollama|inference|deployment|optimization/i,
};

/**
 * Get V6 Category based on entity metadata (Art 3.1)
 * Tier 1: source-specific (Replicate/CivitAI)
 * Tier 2: pipeline_tag/tags (Exact Match)
 * Tier 3: Name pattern inference (V16.7 Intelligence)
 * Tier 4: Default fallback
 */
export function getV6Category(entity) {
    // Tier 1: Check primary_category (Prioritize source classification)
    if (entity.primary_category) {
        const mapped = CATEGORY_ALIASES[entity.primary_category];
        if (mapped) return mapped;
    }

    // Tier 2: Check pipeline_tag (HuggingFace direct)
    if (entity.pipeline_tag) {
        const mapped = CATEGORY_ALIASES[entity.pipeline_tag];
        if (mapped) return mapped;
    }

    // Tier 2b: Check tags array
    if (entity.tags) {
        const tags = Array.isArray(entity.tags) ? entity.tags :
            (typeof entity.tags === 'string' ? [entity.tags] : []);
        for (const tag of tags) {
            const mapped = CATEGORY_ALIASES[tag];
            if (mapped) return mapped;
        }
    }

    // Tier 3: Name pattern inference (V16.7 Intelligence)
    const name = (entity.name || entity.id || '').toLowerCase();
    for (const [cat, pattern] of Object.entries(NAME_PATTERNS)) {
        if (pattern.test(name)) return cat;
    }

    // Tier 4: Default Fallback
    return 'text-generation';
}

/**
 * V25.9: Generate category statistics via streaming shard reader.
 * Streaming counters + per-category bounded top-5.
 */
export async function generateCategoryStats(shardReader, outputDir = './output') {
    console.log('[CATEGORY] Generating category_stats.json (streaming)...');

    const cacheDir = path.join(outputDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });

    const stats = {};
    for (const [key, label] of Object.entries(CATEGORY_MAP)) {
        stats[key] = { id: key, label, count: 0, top_models: [] };
    }

    // Per-category bounded top-5 + type counters
    const topByCategory = {};
    const typeCounts = { model: 0, paper: 0, agent: 0, space: 0, dataset: 0, tool: 0, prompt: 0 };

    await shardReader(async (entities) => {
        for (const e of entities) {
            const type = e.type || 'model';
            if (typeCounts[type] !== undefined) typeCounts[type]++;

            if (type === 'model' || !e.type) {
                const category = getV6Category(e);
                if (stats[category]) {
                    stats[category].count++;
                    if (!topByCategory[category]) topByCategory[category] = [];
                    const arr = topByCategory[category];
                    const score = e.fni_score || e.fni || 0;
                    if (arr.length < 5) {
                        arr.push({ id: e.id, name: e.name, fni: score });
                    } else if (score > arr[arr.length - 1].fni) {
                        arr[arr.length - 1] = { id: e.id, name: e.name, fni: score };
                        arr.sort((a, b) => b.fni - a.fni);
                    }
                }
            }
        }
    }, { slim: true });

    for (const [category, models] of Object.entries(topByCategory)) {
        models.sort((a, b) => b.fni - a.fni);
        stats[category].top_models = models.map(m => ({ id: m.id, name: m.name }));
    }

    const output = {
        categories: Object.values(stats),
        total_models: typeCounts.model, total_papers: typeCounts.paper,
        total_agents: typeCounts.agent, total_spaces: typeCounts.space,
        total_datasets: typeCounts.dataset, total_tools: typeCounts.tool,
        total_prompts: typeCounts.prompt,
        _generated: new Date().toISOString(),
    };

    await smartWriteWithVersioning('category_stats.json', output, cacheDir, { compress: true });

    console.log(`  [CATEGORY] ${Object.keys(stats).length} categories, ${output.total_models} models`);
    for (const [key, data] of Object.entries(stats)) {
        if (data.count > 0) console.log(`    - ${key}: ${data.count} models`);
    }
}
