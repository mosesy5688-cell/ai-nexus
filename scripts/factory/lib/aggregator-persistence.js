/**
 * Aggregator Persistence V16.11 (CES Compliant)
 * Handles sharded registry saving + final cache sync.
 * D-295: the redundant output/meta/backup local mirror was removed (Component 2/3).
 */

import path from 'path';
import { saveGlobalRegistry, syncCacheState } from './cache-manager.js';

/**
 * Persist the global registry and mirror artifacts for distribution
 */
export async function persistRegistry(rankedEntities, outputDir, cacheDir, rankingsMap, scoreMap) {
    console.log(`[AGGREGATOR] 💾 Persisting sharded registry...`);

    if (!rankedEntities && !rankingsMap) {
        // V25.9: Streaming mode — shards already saved during streaming finalization pass.
        // Skip entity serialization, proceed to mirroring/backup only.
        console.log(`[AGGREGATOR] 💾 Streaming mode: shards already persisted. Mirroring only.`);
    } else if (!rankedEntities && rankingsMap) {
        // V55.9: High-Fidelity Shard Patching (Binary shards only, no monolith)
        // Monolith streaming removed — createZstdCompressStream buffers ALL data
        // in memory before compressing, causing OOM on 416k+ entities with READMEs.
        // Binary shards (NXVF + AES + Zstd) are the authoritative format.
        const { loadRegistryShardsSequentially } = await import('./registry-loader.js');
        const { saveRegistryShard } = await import('./registry-saver.js');

        let shardsPatched = 0, totalShards = 0;
        await loadRegistryShardsSequentially(async (entities, shardIdx) => {
            totalShards++;
            for (const e of entities) {
                e.fni_percentile = rankingsMap.get(e.id) || 0;
                if (scoreMap && scoreMap.has(e.id)) {
                    const finalFni = scoreMap.get(e.id);
                    e.fni_score = finalFni;
                    e.fni = finalFni;
                }
            }
            await saveRegistryShard(shardIdx, entities);
            shardsPatched++;
            if (global.gc && shardsPatched % 50 === 0) global.gc();
        }, { slim: false });

        if (shardsPatched < totalShards) {
            throw new Error(`[PERSISTENCE] Split-brain: only ${shardsPatched}/${totalShards} shards patched.`);
        }
        console.log(`[AGGREGATOR] ✅ HF Shard Patching Complete (${shardsPatched} shards).`);
    } else {
        // Satellite or Legacy mode: Persistence of provided (usually slim) entities
        await saveGlobalRegistry({
            entities: rankedEntities,
            count: (rankedEntities || []).length,
            lastUpdated: new Date().toISOString()
        });
    }

    // 2. Local output/meta/backup mirror ELIMINATED (D-295 Component 2/3).
    // The prior per-dir copy of cache/{registry,fni-history,daily-accum,mesh,
    // relations,knowledge} + monoliths + reports into output/meta/backup/ was a
    // redundant SAME-JOB round-trip: the "Consolidate Final Artifacts & Context"
    // step copied output/meta/backup/* straight back to cache/. It was the ~2x
    // finalization-disk driver AND its per-copy `catch {}` silently swallowed a
    // mid-mirror ENOSPC. Authoritative durability is unaffected: cache/ is the
    // source of truth and R2 backups (`backup-dir cache/registry/`,
    // `backup-dir cache/fni-history/`, etc. in the persist/harvest jobs) read
    // cache/ DIRECTLY — never this local mirror. Removing the mirror deletes the
    // swallow-catches with it (Component 3): no silent ENOSPC/short-copy remains.

    // 3. Final Cache Sync (V17.6: Avoid EINVAL by skipping redundant sync).
    // Fail-loud: a copy/sync failure here must surface (no swallow), so an ENOSPC
    // during finalization goes RED instead of producing a silently-partial cache.
    if (path.resolve(cacheDir) !== path.resolve('./cache')) {
        try {
            await syncCacheState(cacheDir, './cache');
        } catch (e) {
            throw new Error(`[PERSISTENCE] Fatal: cache sync ${cacheDir} -> ./cache failed: ${e.message}`);
        }
    }
}
