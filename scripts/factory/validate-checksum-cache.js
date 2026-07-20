#!/usr/bin/env node
/**
 * D-364/D-365/D-366: entity-checksum cache OWNER-BOUNDARY RECONCILE CLI.
 *
 * Operates ONLY on cache/entity-checksums.json.zst (never task-checksums, never
 * R2). Keeps a valid restored/merged artifact; LOCAL-invalidates an invalid one
 * (turning a poisoned hit into an honest cache-miss). Exits NON-ZERO only when
 * local invalidation could not be verified (CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED)
 * — a fail-closed, never a silently-reported success. A removed-invalid /
 * kept-valid / absent artifact all exit 0 (the cycle continues honestly).
 *
 * D-366 double-reconcile: factory-harvest.yml invokes this SAME CLI twice — once
 * at the owner boundary right after the combined "Restore Checksums" restore
 * (before Merge Batches + both R2 backups), and once as the LAST job step before
 * the combined action's post-if:success() post-save, so an artifact that is invalid
 * at job end is removed before it can be re-propagated to the next cycle. If the
 * second reconcile fails closed, the job fails and the post-save does not run.
 */
import {
    reconcileEntityChecksumCache,
    CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED,
} from './lib/cache-manager.js';

async function main() {
    const result = await reconcileEntityChecksumCache();
    console.log(`[CHECKSUM-CACHE] reconcile status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}`);
}

main().catch((e) => {
    const msg = e && e.message ? e.message : String(e);
    console.error(`[CHECKSUM-CACHE] ${msg}`);
    // Fail-closed: local invalidation could not be verified. A non-zero exit
    // here MUST redden the boundary/post-save step — do NOT report a cache-miss
    // success (and, for the second reconcile, keep the combined post-save from running).
    if (msg.includes(CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED)) {
        process.exit(2);
    }
    process.exit(1);
});
