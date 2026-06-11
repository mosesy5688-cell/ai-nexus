/**
 * B4 — id-index absence oracle + index-driven candidate resolution.
 *
 * The slim v2 id-index (data/id-index.bin, id-index-generator.js) keys EVERY
 * resolvable form (id / slug / umid, lowercased) of EVERY corpus entity to the
 * single meta-shard the packer wrote it to. Because it enumerates every
 * resolvable key, a successfully-loaded index is a COMPLETE absence oracle:
 *
 *   - index loaded AND a candidate hits  -> the entity exists; probe ONLY the
 *     1-2 shards the index resolves (shrink the bareword/slug AUTO_PREFIX
 *     fan-out from ~10 cold shards to the forms the index actually resolves).
 *   - index loaded AND NO candidate hits -> the entity is GENUINELY absent;
 *     return an honest 404 with ZERO cold-shard probes (the root cause of the
 *     paper-page 503s: 10 cold opens can never finish inside PROBE_BUDGET_MS,
 *     so the clean-exhaustion 404 branch was structurally unreachable and real
 *     misses 503'd forever).
 *   - index absent / unreadable / refused (stale / oversized / bad format) ->
 *     DEGRADE to the prior behavior EXACTLY: the original shardForms order,
 *     full fan-out, budget-gated probe (constructive zero regression).
 *
 * The index NEVER decides DATA: a resolved shard is still probed with the real
 * SELECT, so an index hash collision only mis-routes (then the caller's own
 * fallback covers it). The only NEW power is the all-miss verdict, and that is
 * gated on the index having loaded — when it has not, we never claim absence.
 *
 * Bounded load: loadIdIndex is raced against a short deadline so the index's
 * OWN cold-isolate load cost (one R2 GET + parse of a ~10-15 MB blob) can never
 * consume the probe budget. A load that misses the deadline degrades to the
 * fan-out path, never blocks the request.
 *
 * Shared by /api/v1/entity/[...id].ts and utils/vfs-metadata-provider.ts (the
 * paper / detail-page resolver) so paper pages benefit through this code path,
 * NOT a page-specific patch.
 */
import { loadIdIndex, lookup as idIndexLookup } from './id-index-reader.js';
import { withOpTimeout } from './op-timeout.js';

// Bound the index's own load so a cold-isolate fetch+parse cannot eat the probe
// budget. On miss we degrade to the fan-out (the index is best-effort warm
// tier, never on the critical path). Comfortably under PROBE_BUDGET_MS (6000ms)
// so even a slow load leaves room for at least one real shard probe.
export const INDEX_LOAD_TIMEOUT_MS = 2500;

export interface ShardResolution {
    /**
     * Shard entries to probe, in order. When the index resolved a candidate this
     * is shrunk to the resolved shard(s) first; otherwise it is the original
     * fan-out order (zero regression).
     */
    orderedShards: [number, string[]][];
    /** True iff loadIdIndex returned true (the index is present + parseable). */
    indexLoaded: boolean;
    /**
     * True ONLY when the index loaded AND no candidate resolved in it. The caller
     * may then return an honest 404 with NO shard probes. False whenever the
     * index is absent/refused (we never assert absence without the oracle) OR a
     * candidate did resolve.
     */
    absenceProven: boolean;
}

async function tryLoadIndex(env: any): Promise<boolean> {
    try {
        // loadIdIndex itself never throws, but a hung R2 GET on a cold isolate
        // could stall; the deadline turns that into a clean fan-out fallback.
        return await withOpTimeout(loadIdIndex(env), INDEX_LOAD_TIMEOUT_MS, 'idindex:load');
    } catch {
        return false; // timeout OR unexpected -> degrade, never block.
    }
}

/**
 * Resolve the shard set to probe for a candidate plan, using the id-index as
 * BOTH a candidate-set reducer (index-driven type resolution) and an absence
 * oracle. See module header for the three outcomes.
 *
 * @param shardForms  candidate-form -> shard map (each form already hashed to
 *                    its own shard by the caller; Map insertion order = the
 *                    caller's highest-probability-first fan-out order).
 * @param candidates  the ordered candidate forms (same forms as shardForms).
 * @param env         CF env (R2 binding) for loadIdIndex.
 */
export async function resolveShardsForCandidates(
    shardForms: Map<number, string[]>,
    candidates: string[],
    env: any,
): Promise<ShardResolution> {
    const entries = [...shardForms.entries()];
    const indexLoaded = await tryLoadIndex(env);
    if (!indexLoaded) {
        // Index unavailable: degrade to current behavior EXACTLY.
        return { orderedShards: entries, indexLoaded: false, absenceProven: false };
    }

    // Index is present + parseable -> it is authoritative over presence.
    // Collect the shard(s) the index resolves for any candidate. Restrict the
    // probe to the form that actually hashed to a resolved shard (the resolved
    // form is the stored one), shrinking the fan-out to the 1-2 real shards.
    const resolved: [number, string[]][] = [];
    const seenShard = new Set<number>();
    for (const c of candidates) {
        const hit = idIndexLookup(c);
        if (!hit) continue;
        // The index resolves a canonical write shard; probe that shard with the
        // candidate forms the CALLER mapped to it (preserves the existing SQL
        // binding). If the resolved shard is not among shardForms (a candidate
        // collision / form the caller did not hash there), still probe it with
        // this candidate so a real entity is never made unreachable.
        if (seenShard.has(hit.shardIdx)) continue;
        seenShard.add(hit.shardIdx);
        const formsForShard = shardForms.get(hit.shardIdx);
        resolved.push([hit.shardIdx, formsForShard ?? [c]]);
    }

    if (resolved.length > 0) {
        return { orderedShards: resolved, indexLoaded: true, absenceProven: false };
    }

    // Loaded index, zero hits across all candidates -> proven absence.
    return { orderedShards: [], indexLoaded: true, absenceProven: true };
}
