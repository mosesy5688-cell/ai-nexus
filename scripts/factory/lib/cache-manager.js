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
    return loadWithFallback('entity-checksums.json.zst', {});
}

export async function saveEntityChecksums(checksums) {
    // V27.63: skip empty (header-only zstd 11B tripped r2-handoff guard; also
    // signals upstream regression since healthy cycles always have ≥1 checksum).
    if (!checksums || Object.keys(checksums).length === 0) {
        console.warn('[CACHE] entity-checksums empty — skipping save (upstream produced no entities?)');
        return;
    }
    await saveWithBackup('entity-checksums.json.zst', checksums, { compress: true });
}
