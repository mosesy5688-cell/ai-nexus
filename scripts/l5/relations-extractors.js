/**
 * Relations Extractors Module
 * 
 * Utility functions for extracting relations from entity data.
 * Separated from relations-compute.js for CES compliance (<250 lines)
 * 
 * @module l5/relations-extractors
 */

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
export function extractArxivIds(text) {
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
export function detectBaseModel(modelName) {
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
export function extractDatasetIds(text, tags) {
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
