/**
 * Adapter Registry
 * 
 * Central registry for all data source adapters.
 * V4.3.2: Added Open LLM Leaderboard for benchmark data.
 * 
 * @module ingestion/adapters
 */

import { HuggingFaceAdapter } from './huggingface-adapter.js';
import { GitHubAdapter } from './github-adapter.js';
import { DatasetsAdapter } from './datasets-adapter.js';
import { ArXivAdapter } from './arxiv-adapter.js';
import { PapersWithCodeAdapter } from './pwc-adapter.js';
import { OllamaAdapter } from './ollama-adapter.js';
import { CivitAIAdapter } from './civitai-adapter.js';
import { ModelScopeAdapter } from './modelscope-adapter.js';
import { OpenLLMLeaderboardAdapter } from './openllm-adapter.js';
import { DeepSpecAdapter } from './deepspec-adapter.js';
import { SemanticScholarAdapter } from './semanticscholar-adapter.js';

// Export base for extension
export { BaseAdapter, NSFW_KEYWORDS, LICENSE_MAP } from './base-adapter.js';

// Export individual adapters
export { HuggingFaceAdapter } from './huggingface-adapter.js';
export { GitHubAdapter } from './github-adapter.js';
export { DatasetsAdapter } from './datasets-adapter.js';
export { ArXivAdapter } from './arxiv-adapter.js';
export { PapersWithCodeAdapter } from './pwc-adapter.js';
export { OllamaAdapter } from './ollama-adapter.js';
export { CivitAIAdapter } from './civitai-adapter.js';
export { ModelScopeAdapter } from './modelscope-adapter.js';
export { OpenLLMLeaderboardAdapter } from './openllm-adapter.js';
export { DeepSpecAdapter } from './deepspec-adapter.js';
export { SemanticScholarAdapter } from './semanticscholar-adapter.js';

// Registered adapters (V4.3.2 - Multi-source with Benchmarks + Specs + Citations)
export const adapters = {
    // Tier 1: Core Sources
    'huggingface': new HuggingFaceAdapter(),
    'huggingface-datasets': new DatasetsAdapter(),
    'github': new GitHubAdapter(),

    // Tier 2: Academic Sources
    'arxiv': new ArXivAdapter(),
    'paperswithcode': new PapersWithCodeAdapter(),
    'semanticscholar': new SemanticScholarAdapter(),

    // Tier 3: Ecosystem Sources
    'ollama': new OllamaAdapter(),

    // V4.3.1: CivitAI (L2 NSFW filtering verified - production ready)
    'civitai': new CivitAIAdapter(),

    // V4.3.2: Open LLM Leaderboard (Benchmark data) 
    'openllm': new OpenLLMLeaderboardAdapter(),

    // V4.3.2: Deep Spec Extractor (Model specifications)
    'deepspec': new DeepSpecAdapter(),

    // DISABLED: ModelScope - requires API Token for model listing
    // 'modelscope': new ModelScopeAdapter(),
};

/**
 * Get adapter by name
 */
export function getAdapter(name) {
    const adapter = adapters[name];
    if (!adapter) {
        throw new Error(`Unknown adapter: ${name}. Available: ${Object.keys(adapters).join(', ')}`)
    }
    return adapter;
}

/**
 * Get all registered adapter names
 */
export function getAdapterNames() {
    return Object.keys(adapters);
}

/**
 * Get adapters by tier
 */
export function getTier1Adapters() {
    return ['huggingface', 'huggingface-datasets', 'github'];
}

export function getTier2Adapters() {
    return ['arxiv', 'paperswithcode'];
}

export function getTier3Adapters() {
    return ['ollama', 'civitai', 'modelscope'];
}

/**
 * V4.3.1: Get all adapters for parallel harvesting
 */
export function getAllAdapters() {
    return Object.keys(adapters);
}

export default adapters;
