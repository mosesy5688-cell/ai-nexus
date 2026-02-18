/**
 * Source Fetcher — V19.0
 * Handles rotational sampling and multi-strategy fetch for individual sources.
 * Extracted from orchestrator.js for Art 5.1 compliance (250-line limit).
 * 
 * @module ingestion/lib/source-fetcher
 */

import { adapters } from '../adapters/index.js';

/**
 * Fetch from a single source with rotational sampling
 * @param {string} sourceName - Source adapter key
 * @param {object} sourceConfig - Source configuration from ingestion-config
 * @param {object} state - Harvest state (mutated with new offset)
 * @param {object} registryManager - Registry manager instance
 * @returns {Promise<Array>} Raw entities
 */
export async function fetchSource(sourceName, sourceConfig, state, registryManager) {
    const adapter = adapters[sourceName];
    if (!adapter) {
        console.warn(`   ⚠️ Unknown adapter: ${sourceName}`);
        return [];
    }

    const currentOffset = state.lastRun[sourceName]?.offset || 0;
    const limit = sourceConfig.options.limit || 5000;
    const maxOffset = sourceConfig.options.maxOffset || 300000;
    const nextOffset = (currentOffset + limit > maxOffset) ? 0 : currentOffset + limit;

    console.log(`   🔄 Rotational Offset [${sourceName}]: ${currentOffset} → next: ${nextOffset}`);

    let entities;
    if (sourceName === 'huggingface' && sourceConfig.options.limit > 1000 && adapter.fetchMultiStrategy) {
        console.log(`   📊 Using multi-strategy for HuggingFace (limit: ${sourceConfig.options.limit})...`);
        const result = await adapter.fetchMultiStrategy({
            limitPerStrategy: Math.ceil(sourceConfig.options.limit / 4),
            full: sourceConfig.options.full !== false,
            registryManager,
            offset: currentOffset
        });
        entities = result.models;
    } else {
        entities = await adapter.fetch({
            ...sourceConfig.options,
            registryManager,
            offset: currentOffset
        });
    }

    // Update rotational state
    if (!state.lastRun[sourceName]) state.lastRun[sourceName] = {};
    state.lastRun[sourceName].offset = nextOffset;
    state.lastRun[sourceName].timestamp = new Date().toISOString();

    return entities;
}
