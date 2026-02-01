/**
 * Cache Manager Module V16.7.2
 * Delegates to cache-core (static) and registry-io (sharded)
 */

import { loadWithFallback, saveWithBackup } from './cache-core.js';
export { loadWithFallback, saveWithBackup };
export {
    loadGlobalRegistry, saveGlobalRegistry,
    loadFniHistory, saveFniHistory,
    loadDailyAccum, saveDailyAccum,
    syncCacheState
} from './registry-io.js';

// Legacy compatibility for old scripts
// (Removed redundant import that caused conflict)

export async function loadEntityChecksums() {
    return loadWithFallback('entity-checksums.json', {});
}

export async function saveEntityChecksums(checksums) {
    await saveWithBackup('entity-checksums.json', checksums);
}
