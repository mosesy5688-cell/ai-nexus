/**
 * L5 Relations Compute Script
 * 
 * B.3 Knowledge Relations Table
 * Discovers entity relationships from existing data:
 * - paper_id: ArXiv IDs from model READMEs
 * - base_model: Base→Variant patterns
 * - variant: Inverse of base_model
 * - dataset_id: Training datasets from tags/meta_json
 * 
 * @module l5/relations-compute
 */

import fs from 'fs';
import path from 'path';

/**
 * ArXiv ID extraction patterns
 */
const ARXIV_PATTERNS = [
    /arxiv\.org\/abs\/(\d{4}\.\d{4,5})/gi,
    /arxiv\.org\/pdf\/(\d{4}\.\d{4,5})/gi,
    /arXiv:(\d{4}\.\d{4,5})/gi,
    /\[(\d{4}\.\d{4,5})\]/g  // Common format: [2401.12345]
];

/**
 * Base model detection pattern
 * Matches: Model-Name-7B, Model-Name-70B-Instruct, Model-GGUF
 */
const VARIANT_SUFFIX_PATTERN = /^(.+?)[-_]((\d+\.?\d*[BM])|instruct|chat|base|gguf|awq|gptq|fp16|bf16|q[48]_\d|qlora|lora)/i;

/**
 * Common HuggingFace dataset patterns
 */
const DATASET_PATTERNS = [
    /dataset:(\S+)/gi,                           // HF tag format: dataset:xxx
    /huggingface\.co\/datasets\/([\w-]+\/[\w-]+)/gi,  // URL format
    /trained[- ]on[- ](?:the[- ])?(\w[\w-]+)/gi  // "trained on X" mentions
];

// Known high-value datasets to detect
const KNOWN_DATASETS = [
    'wikipedia', 'common_crawl', 'c4', 'pile', 'redpajama', 'openwebtext',
    'dolly', 'alpaca', 'sharegpt', 'oasst', 'slimpajama', 'refinedweb',
    'starcoder', 'the_stack', 'code_alpaca', 'evol_instruct'
];

/**
 * Extract ArXiv IDs from text
 */
function extractArxivIds(text) {
    if (!text) return [];
    const ids = new Set();

    for (const pattern of ARXIV_PATTERNS) {
        let match;
        const regex = new RegExp(pattern.source, pattern.flags);
        while ((match = regex.exec(text)) !== null) {
            ids.add(match[1]);
        }
    }

    return [...ids];
}

/**
 * Detect base model from variant name
 * Returns null if no pattern match
 */
function detectBaseModel(modelName) {
    if (!modelName) return null;

    const match = modelName.match(VARIANT_SUFFIX_PATTERN);
    if (match && match[1] && match[1].length >= 3) {
        return match[1];
    }

    return null;
}

/**
 * Extract dataset IDs from text and tags
 */
function extractDatasetIds(text, tags) {
    if (!text && !tags) return [];
    const datasets = new Set();

    const searchText = [text || '', Array.isArray(tags) ? tags.join(' ') : (tags || '')].join(' ').toLowerCase();

    // Pattern-based extraction
    for (const pattern of DATASET_PATTERNS) {
        let match;
        const regex = new RegExp(pattern.source, pattern.flags);
        while ((match = regex.exec(searchText)) !== null) {
            if (match[1] && match[1].length >= 3) {
                datasets.add(match[1].toLowerCase());
            }
        }
    }

    // Known dataset detection
    for (const dataset of KNOWN_DATASETS) {
        if (searchText.includes(dataset)) {
            datasets.add(dataset);
        }
    }

    return [...datasets];
}

/**
 * Build relations for all entities
 */
function discoverRelations(entities) {
    const relations = [];
    const baseModelIndex = new Map(); // Track base models for variant linking

    console.log(`🔍 Discovering relations for ${entities.length} entities...`);

    for (const entity of entities) {
        // 1. Extract ArXiv paper_id relations
        const textToSearch = [
            entity.body_content || '',
            entity.description || '',
            entity.tags || ''
        ].join(' ');

        const arxivIds = extractArxivIds(textToSearch);
        for (const arxivId of arxivIds) {
            relations.push({
                source_id: entity.id,
                target_id: `arxiv:${arxivId}`,
                relation_type: 'paper_id',
                confidence: 0.9,
                source_url: entity.source_url || null
            });
        }

        // 2. Detect base_model relations
        const baseName = detectBaseModel(entity.name);
        if (baseName) {
            // Track for later reverse lookup
            if (!baseModelIndex.has(baseName.toLowerCase())) {
                baseModelIndex.set(baseName.toLowerCase(), []);
            }
            baseModelIndex.get(baseName.toLowerCase()).push(entity.id);

            // Create potential base_model relation (will be validated later)
            relations.push({
                source_id: entity.id,
                target_id: `base:${baseName}`,
                relation_type: 'base_model',
                confidence: 0.7,
                source_url: null
            });
        }

        // 3. Extract dataset_id relations (B.7 enhancement)
        const datasetIds = extractDatasetIds(textToSearch, entity.tags);
        for (const datasetId of datasetIds) {
            relations.push({
                source_id: entity.id,
                target_id: `dataset:${datasetId}`,
                relation_type: 'dataset_id',
                confidence: 0.6,
                source_url: entity.source_url || null
            });
        }
    }

    // 3. Create variant relations (inverse of base_model)
    for (const [baseName, variantIds] of baseModelIndex) {
        if (variantIds.length > 1) {
            // Find the actual base entity if it exists
            const baseEntity = entities.find(e =>
                e.name && e.name.toLowerCase() === baseName
            );

            if (baseEntity) {
                for (const variantId of variantIds) {
                    relations.push({
                        source_id: baseEntity.id,
                        target_id: variantId,
                        relation_type: 'variant',
                        confidence: 0.8,
                        source_url: null
                    });
                }
            }
        }
    }

    return relations;
}

/**
 * Main execution function
 */
export async function computeRelations(inputFile, outputFile) {
    console.log(`📊 Loading entities from ${inputFile}...`);
    const entities = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    console.log(`📦 Loaded ${entities.length} entities`);

    const startTime = Date.now();
    const relations = discoverRelations(entities);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Deduplicate relations
    const uniqueRelations = [...new Map(
        relations.map(r => [`${r.source_id}|${r.target_id}|${r.relation_type}`, r])
    ).values()];

    console.log(`\n✅ Discovered ${uniqueRelations.length} relations in ${elapsed}s`);

    // Count by type
    const typeCounts = {};
    for (const r of uniqueRelations) {
        typeCounts[r.relation_type] = (typeCounts[r.relation_type] || 0) + 1;
    }
    console.log('📊 Relation types:', typeCounts);

    // Ensure output directory exists
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save relations
    fs.writeFileSync(outputFile, JSON.stringify(uniqueRelations, null, 2));
    console.log(`💾 Saved: ${outputFile}`);

    // Save summary
    const summary = {
        total_relations: uniqueRelations.length,
        by_type: typeCounts,
        computed_at: new Date().toISOString(),
        elapsed_seconds: parseFloat(elapsed)
    };

    const summaryFile = outputFile.replace('.json', '_summary.json');
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

    return summary;
}

// CLI execution
if (process.argv[1].includes('relations-compute')) {
    const inputFile = process.argv[2] || 'data/entities.json';
    const outputFile = process.argv[3] || 'data/relations.json';

    computeRelations(inputFile, outputFile)
        .then(summary => {
            console.log('\n📊 Summary:');
            console.log(`   Total: ${summary.total_relations} relations`);
            console.log(`   Types: ${JSON.stringify(summary.by_type)}`);
        })
        .catch(err => {
            console.error('❌ Error:', err.message);
            process.exit(1);
        });
}

export default { computeRelations, extractArxivIds, detectBaseModel };
