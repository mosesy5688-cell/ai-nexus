/**
 * Adapter Registry
 * 
 * Central registry for all data source adapters.
 * Sprint 2: Added Datasets, ArXiv, Papers With Code adapters.
 * 
 * @module ingestion/adapters
 */

import { HuggingFaceAdapter } from './huggingface-adapter.js';
import { GitHubAdapter } from './github-adapter.js';
import { DatasetsAdapter } from './datasets-adapter.js';
import { ArXivAdapter } from './arxiv-adapter.js';
import { PapersWithCodeAdapter } from './pwc-adapter.js';

// Export base for extension
export { BaseAdapter, NSFW_KEYWORDS, LICENSE_MAP } from './base-adapter.js';

// Export individual adapters
export { HuggingFaceAdapter } from './huggingface-adapter.js';
export { GitHubAdapter } from './github-adapter.js';
export { DatasetsAdapter } from './datasets-adapter.js';
export { ArXivAdapter } from './arxiv-adapter.js';
export { PapersWithCodeAdapter } from './pwc-adapter.js';

// Registered adapters (Sprint 2 - Multi-source)
export const adapters = {
    // Tier 1: Core Sources
    'huggingface': new HuggingFaceAdapter(),
    'huggingface-datasets': new DatasetsAdapter(),
    'github': new GitHubAdapter(),

    // Tier 2: Academic Sources (Sprint 2)
    'arxiv': new ArXivAdapter(),
    'paperswithcode': new PapersWithCodeAdapter(),
};

/**
 * Get adapter by name
 */
export function getAdapter(name) {
    const adapter = adapters[name];
    if (!adapter) {
        throw new Error(`Unknown adapter: ${name}. Available: ${Object.keys(adapters).join(', ')}`);
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

export default adapters;

