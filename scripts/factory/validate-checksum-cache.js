#!/usr/bin/env node
/**
 * D-364/D-366/D-370: entity-checksum cache OWNER-BOUNDARY RECONCILE CLI.
 *
 * Operates ONLY on cache/entity-checksums.json.zst (never task-checksums, never
 * R2). Keeps a valid artifact; LOCAL-invalidates an invalid one (turning a poisoned
 * hit into an honest cache-miss). Exits NON-ZERO only when local invalidation could
 * not be verified (CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED) — fail-closed, never a
 * silently-reported success. Removed-invalid / kept-valid / absent all exit 0.
 *
 * D-370 triple-reconcile: factory-harvest.yml invokes this SAME CLI three times, each
 * with a --stage label: post_restore (right after the combined restore),
 * post_owner_load_pre_carrier (after Merge Batches, before the cycle-cache save +
 * both R2 backups), and pre_post_save (last step, before the combined post-save).
 * The reconciler emits a STRUCTURED TRACE (stage + status + reason + size bytes only —
 * never checksum keys, entity ids, or file content).
 */
import {
    reconcileEntityChecksumCache,
    CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED,
} from './lib/cache-manager.js';

function parseStage() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--stage' && args[i + 1]) return args[i + 1];
        if (args[i].startsWith('--stage=')) return args[i].slice('--stage='.length);
    }
    return 'unspecified';
}

const stage = parseStage();

reconcileEntityChecksumCache({ stage }).catch((e) => {
    const msg = e && e.message ? e.message : String(e);
    // Fail-closed trace (status/reason only — no keys/ids/content) + the raw signal.
    console.error(`[CHECKSUM-CACHE-TRACE] stage=${stage} status=fail_closed reason=local_invalidation_failed`);
    console.error(`[CHECKSUM-CACHE] ${msg}`);
    if (msg.includes(CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED)) process.exit(2);
    process.exit(1);
});
