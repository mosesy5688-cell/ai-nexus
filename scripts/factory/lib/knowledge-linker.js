/**
 * Knowledge Linker Module V14.5.2
 * SPEC: SPEC-KNOWLEDGE-V14.5.2
 * 
 * Links entities to knowledge articles based on keyword matching.
 * Provides EXPLAIN relations for concepts like:
 * - FNI Score
 * - Context Length
 * - GGUF/GGML formats
 * - Benchmark scores (MMLU, HumanEval, etc.)
 */

import fs from 'fs/promises';
import path from 'path';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';

// Knowledge keywords mapping
// Maps keywords found in entity data to knowledge article slugs
const KNOWLEDGE_KEYWORDS = {
    // Scoring & Metrics
    'fni': 'fni-score',
    'fni_score': 'fni-score',
    'fni-score': 'fni-score',
    'humaneval': 'humaneval-benchmark',
    'mmlu': 'mmlu-benchmark',
    'gsm8k': 'gsm8k-benchmark',
    'hellaswag': 'commonsense-reasoning',

    // Model Architecture
    'transformer': 'transformer-architecture',
    'attention': 'attention-mechanism',
    'moe': 'mixture-of-experts',
    'mixture of experts': 'mixture-of-experts',
    'context length': 'context-length',
    'context window': 'context-length',
    'context_length': 'context-length',

    // Quantization & Formats
    'gguf': 'gguf-format',
    'ggml': 'gguf-format',
    'gptq': 'quantization',
    'awq': 'quantization',
    'bnb': 'quantization',
    'bitsandbytes': 'quantization',
    'int4': 'quantization',
    'int8': 'quantization',
    'fp16': 'precision',
    'bf16': 'precision',

    // Fine-tuning
    'lora': 'lora-finetuning',
    'qlora': 'lora-finetuning',
    'peft': 'lora-finetuning',
    'finetuned': 'fine-tuning',
    'fine-tuned': 'fine-tuning',
    'instruct': 'instruction-tuning',
    'chat': 'chat-models',

    // Inference
    'vllm': 'inference-optimization',
    'tgi': 'inference-optimization',
    'ollama': 'local-deployment',
    'llama.cpp': 'local-deployment',

    // Safety
    'rlhf': 'rlhf',
    'dpo': 'direct-preference-optimization',
    'alignment': 'ai-alignment',

    // Multimodal
    'multimodal': 'multimodal',
    'vision': 'vision-models',
    'image': 'image-generation',
    'audio': 'audio-models',
    'speech': 'speech-models',

    // RAG & Embeddings
    'embedding': 'embeddings',
    'embeddings': 'embeddings',
    'rag': 'rag-retrieval',
    'retrieval': 'rag-retrieval',
    'vector': 'vector-databases',
};

/**
 * Extract knowledge links from an entity
 * @param {Object} entity 
 * @returns {Array} Knowledge article links
 */
function extractKnowledgeLinks(entity) {
    const links = new Map(); // slug -> confidence

    // Build searchable text
    const searchText = [
        entity.name || '',
        entity.description || '',
        ...(Array.isArray(entity.tags) ? entity.tags : []).filter(t => typeof t === 'string'),
        entity.architecture || '',
        entity.pipeline_tag || '',
        entity.primary_category || '',
    ].join(' ').toLowerCase();

    // Match keywords
    for (const [keyword, slug] of Object.entries(KNOWLEDGE_KEYWORDS)) {
        if (searchText.includes(keyword.toLowerCase())) {
            // Increase confidence if keyword appears multiple times
            const count = (searchText.match(new RegExp(keyword, 'gi')) || []).length;
            const confidence = Math.min(1.0, 0.5 + count * 0.1);

            if (!links.has(slug) || links.get(slug) < confidence) {
                links.set(slug, confidence);
            }
        }
    }

    return Array.from(links.entries()).map(([slug, confidence]) => ({
        slug,
        confidence: Math.round(confidence * 100),
    }));
}

/**
 * Main knowledge linking function
 * @param {Array} entities All entities
 * @param {string} outputDir Output directory
 */
export async function computeKnowledgeLinks(entities, outputDir = './output') {
    console.log('[KNOWLEDGE-LINKER V14.5.2] Computing knowledge links...');

    const startTime = Date.now();
    const relationsDir = path.join(outputDir, 'cache', 'relations');
    await fs.mkdir(relationsDir, { recursive: true });

    const allLinks = [];
    const knowledgeStats = {};

    for (const entity of entities) {
        const id = normalizeId(entity.id || entity.slug, getNodeSource(entity.id || entity.slug, entity.type), entity.type);
        const links = extractKnowledgeLinks(entity);

        if (links.length > 0) {
            allLinks.push({
                entity_id: id,
                entity_type: entity.type || 'model',
                knowledge: links,
            });

            // Track stats
            for (const link of links) {
                knowledgeStats[link.slug] = (knowledgeStats[link.slug] || 0) + 1;
            }
        }
    }

    // V14.5.2 Output format
    const output = {
        _v: '14.5.2',
        _ts: new Date().toISOString(),
        _count: allLinks.length,
        _duration_ms: Date.now() - startTime,
        _keywords: Object.keys(KNOWLEDGE_KEYWORDS).length,
        stats: knowledgeStats,
        links: allLinks,
    };

    const zlib = await import('zlib');
    await fs.writeFile(
        path.join(relationsDir, 'knowledge-links.json.gz'),
        zlib.gzipSync(JSON.stringify(output))
    );

    console.log(`  [KNOWLEDGE-LINKER] Linked ${allLinks.length} entities to knowledge articles`);
    console.log(`  Top 5 articles:`);
    const topArticles = Object.entries(knowledgeStats)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    for (const [slug, count] of topArticles) {
        console.log(`    - ${slug}: ${count}`);
    }

    return { totalLinks: allLinks.length, stats: knowledgeStats };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const entitiesPath = process.argv[2] || './output/entities.json';
    const outputDir = process.argv[3] || './output';

    try {
        const data = await fs.readFile(entitiesPath);
        const entities = JSON.parse(data);
        await computeKnowledgeLinks(Array.isArray(entities) ? entities : entities.entities || [], outputDir);
    } catch (error) {
        console.error('[KNOWLEDGE-LINKER] Error:', error.message);
        process.exit(1);
    }
}
