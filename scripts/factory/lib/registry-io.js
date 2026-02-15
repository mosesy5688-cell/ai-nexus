/**
 * Registry IO Module V16.7.2 (V18.2.11 Facade)
 * Constitution Reference: Art 3.1 (Aggregator), Art 5.1 (Modular)
 * 
 * Handles sharded storage operations for 1M+ entities to prevent OOM
 * Delegated implementation to sub-modules to comply with 250-line limit.
 */

// Implementation delegated to sub-modules (CES compliant)
export { loadGlobalRegistry } from './registry-loader.js';
export { saveGlobalRegistry } from './registry-saver.js';

// Re-exports from legacy children
export { loadFniHistory, saveFniHistory } from './registry-history.js';
export { loadDailyAccum, saveDailyAccum } from './registry-accum.js';
export { syncCacheState, purgeStaleShards } from './registry-utils.js';
