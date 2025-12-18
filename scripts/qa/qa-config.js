/**
 * QA Test Configuration
 */

export const CORE_PAGES = [
    { url: '/', name: 'Home Page', requiredComponents: ['<html', '<head', '<body', 'model-card', 'class='] },
    { url: '/leaderboard', name: 'Leaderboard Page', requiredComponents: ['DOCTYPE', 'leaderboard', 'benchmark'] },
    { url: '/explore', name: 'Explore Page', requiredComponents: ['DOCTYPE', 'explore', 'model'] },
    { url: '/compare', name: 'Compare Page', requiredComponents: ['DOCTYPE', 'compare', 'model'] },
    { url: '/ranking', name: 'Rankings Page', requiredComponents: ['DOCTYPE', 'ranking', 'model'] },
    { url: '/knowledge', name: 'Knowledge Base', requiredComponents: ['DOCTYPE', 'knowledge', 'article'] },
    { url: '/methodology', name: 'Methodology Page', requiredComponents: ['DOCTYPE', 'methodology'] },
    { url: '/about', name: 'About Page', requiredComponents: ['DOCTYPE', 'about'] }
];

export const CACHE_FILES = [
    { url: '/cache/benchmarks.json', name: 'Benchmarks Cache', requiredKeys: ['version', 'data'], minRecords: 5 },
    { url: '/cache/specs.json', name: 'Specs Cache', requiredKeys: ['version', 'data'], minRecords: 3 }
];

export const API_ENDPOINTS = [
    // V6 Architecture: Serverless Search (Client-side)
    // No server endpoints to test
];

export const KNOWLEDGE_ARTICLES = [
    { url: '/knowledge/what-is-mmlu', name: 'Article: MMLU' },
    { url: '/knowledge/what-is-humaneval', name: 'Article: HumanEval' },
    { url: '/knowledge/what-is-fni', name: 'Article: FNI' },
    { url: '/knowledge/what-is-deploy-score', name: 'Article: Deploy Score' },
    { url: '/knowledge/what-is-context-length', name: 'Article: Context Length' }
];

// Models from benchmarks.json to test
export const MODEL_UMIDS = [
    'huggingface--qwen--qwen2.5-72b-instruct',
    'huggingface--meta-llama--llama-3.3-70b-instruct',
    'huggingface--meta-llama--llama-3.1-70b-instruct',
    'huggingface--mistralai--mistral-large-instruct-2407',
    'huggingface--deepseek-ai--deepseek-v2.5',
    'huggingface--qwen--qwen2.5-7b-instruct',
    'huggingface--meta-llama--llama-3.1-8b-instruct',
    'huggingface--microsoft--phi-3-medium-4k-instruct',
    'huggingface--google--gemma-2-9b-it',
    'huggingface--mistralai--mistral-7b-instruct-v0.3'
];
