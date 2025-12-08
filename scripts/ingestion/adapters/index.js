/**
 * Adapter Registry
 * 
 * Central registry for all data source adapters.
 * New adapters can be added here for future sources.
 * 
 * @module ingestion/adapters
 */

import { HuggingFaceAdapter } from './huggingface-adapter.js';
import { GitHubAdapter } from './github-adapter.js';

// Export base for extension
export { BaseAdapter, NSFW_KEYWORDS, LICENSE_MAP } from './base-adapter.js';

// Registered adapters
export const adapters = {
    'huggingface': new HuggingFaceAdapter(),
    'github': new GitHubAdapter(),
    // Future adapters:
    // 'arxiv': new ArxivAdapter(),
    // 'kaggle': new KaggleAdapter(),
    // 'modelscope': new ModelScopeAdapter(),
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

export default adapters;
