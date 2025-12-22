/**
 * HuggingFace Collection Strategies
 * 
 * B.1 CES Refactor: Extracted from huggingface-adapter.js
 * Contains constants and configuration for collection strategies
 * 
 * @module ingestion/adapters/hf-strategies
 */

export const HF_API_BASE = 'https://huggingface.co/api';
export const HF_RAW_BASE = 'https://huggingface.co';

/**
 * V4.3.1 Multi-Strategy Collection
 * Use different sort strategies to collect more models
 */
export const COLLECTION_STRATEGIES = [
    { sort: 'likes', direction: -1, name: 'Most Liked' },
    { sort: 'downloads', direction: -1, name: 'Most Downloaded' },
    { sort: 'lastModified', direction: -1, name: 'Recently Updated' },
    { sort: 'createdAt', direction: -1, name: 'Newest Created' },
];

/**
 * B.1 Full Expansion: Pipeline tags for tag-based collection
 * 21 HuggingFace pipeline tags for comprehensive coverage
 * Target: 21 tags × 5000/tag = 105K+ models
 */
export const PIPELINE_TAGS = [
    'text-generation',           // ~50K models
    'text-classification',       // ~15K models
    'fill-mask',                 // ~8K models
    'token-classification',      // ~5K models
    'question-answering',        // ~4K models
    'translation',               // ~3K models
    'summarization',             // ~2K models
    'feature-extraction',        // ~10K models
    'text2text-generation',      // ~3K models
    'sentence-similarity',       // ~2K models
    'text-to-image',             // ~8K models
    'image-classification',      // ~5K models
    'image-to-text',             // ~2K models
    'object-detection',          // ~1K models
    'image-segmentation',        // ~1K models
    'depth-estimation',          // ~500 models
    'automatic-speech-recognition', // ~2K models
    'text-to-speech',            // ~1K models
    'audio-classification',      // ~500 models
    'zero-shot-classification',  // ~500 models
    'conversational',            // ~1K models
];

/**
 * Rate limiting configuration
 */
export const RATE_LIMIT_CONFIG = {
    batchSizeAuthenticated: 5,
    batchSizeUnauthenticated: 2,
    delayMsAuthenticated: 800,
    delayMsUnauthenticated: 1500,
    maxRetries: 3,
    baseBackoffMs: 2000,
};

/**
 * Calculate exponential backoff delay
 * @param {number} retryCount - Current retry attempt
 * @returns {number} Delay in milliseconds
 */
export function calculateBackoff(retryCount) {
    return RATE_LIMIT_CONFIG.baseBackoffMs * Math.pow(2, retryCount);
}
