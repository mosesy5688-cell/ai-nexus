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
 *
 * FAN-OUT-GATED ORACLE AWAIT (B4 regression fix).
 * The bounded index load (INDEX_LOAD_TIMEOUT_MS) is a COLD R2 GET + parse of a
 * ~24 MB blob that, on a cold isolate, can consume up to 2.5s of the 6s probe
 * budget. High-fan-out lookups (paper multi-form, bareword ~10-shard) win big
 * from the shrink/absence proof and easily absorb that cost. But LOW-fan-out
 * lookups (canonical-id 2 shards, a model-page slug = 1 candidate) already fit
 * the full budget WITHOUT the index, and paying the cold load left them too few
 * ms for their cold shard opens -> they regressed to 503. So the await is now
 * gated on the PRE-oracle unique shard fan-out (distinct shards across all
 * candidates, computed BEFORE any oracle consultation, NOT post-shrink):
 *
 *   fan-out <= 2 : do NOT await the load (no cold I/O). Behave EXACTLY as the
 *                  degrade path: original insertion order, full fan-out, full
 *                  budget. EXCEPTION: if the index is ALREADY warm in this
 *                  isolate (a prior high-fan-out request loaded it; isIndexWarm()
 *                  peeks WITHOUT starting/awaiting a load), apply shrink/absence
 *                  for free.
 *   fan-out >= 3 : await the bounded load as before (shrink + absence + degrade).
 *
 * The gate is fan-out-COUNT based and type-blind (no paper special-casing). It
 * never widens the budget, splits it, or probes-everything-then-404; it only
 * decides whether to pay the index's own load cost up front.
 */
import { loadIdIndex, lookup as idIndexLookup, isIndexWarm } from './id-index-reader.js';
import { withOpTimeout } from './op-timeout.js';

// Bound the index's own load so a cold-isolate fetch+parse cannot eat the probe
// budget. On miss we degrade to the fan-out (the index is best-effort warm
// tier, never on the critical path). Comfortably under PROBE_BUDGET_MS (6000ms)
// so even a slow load leaves room for at least one real shard probe.
export const INDEX_LOAD_TIMEOUT_MS = 2500;

// Pre-oracle unique-shard fan-out at/below which we do NOT pay the index's cold
// load. <=2 distinct shards already fit the full probe budget without the index,
// so paying a cold ~2.5s load would starve their cold shard opens (the B4
// regression). >=3 distinct cold shards cannot all finish inside the budget, so
// the shrink/absence proof is worth the load. Threshold is the count BEFORE any
// oracle consultation (never post-shrink).
export const ORACLE_FANOUT_THRESHOLD = 2;

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
 * Apply the (already-loaded, authoritative) index to the candidate plan: shrink
 * the fan-out to the resolved shard(s), or prove absence when nothing resolves.
 * Pure + synchronous — only call after the index is confirmed resident
 * (tryLoadIndex true OR isIndexWarm()). Mirrors the original loaded-index branch
 * exactly, so the shrink/absence contract is identical on both the warm-peek and
 * the awaited path.
 */
function applyLoadedIndex(
    shardForms: Map<number, string[]>,
    candidates: string[],
): ShardResolution {
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

    // PRE-oracle unique shard fan-out: distinct shards across ALL candidates,
    // computed from the caller's map BEFORE any index consultation. This is the
    // gate input; it is NEVER recomputed from a post-shrink result.
    const fanOut = shardForms.size;

    if (fanOut <= ORACLE_FANOUT_THRESHOLD) {
        // LOW fan-out (<=2 shards): these already fit the full probe budget
        // without the index, so do NOT pay its cold load — behave EXACTLY as the
        // degrade path (original insertion order, full fan-out, no absence claim).
        // EXCEPTION: if a prior request already warmed the index in this isolate,
        // applying it costs no I/O wait, so take the shrink/absence for free.
        // isIndexWarm() peeks WITHOUT starting or awaiting a load.
        if (isIndexWarm()) {
            return applyLoadedIndex(shardForms, candidates);
        }
        return { orderedShards: entries, indexLoaded: false, absenceProven: false };
    }

    // HIGH fan-out (>=3 shards): the index's shrink/absence proof is worth its
    // own bounded cold load. Await as before; on absent/slow/refused/parse-fail
    // tryLoadIndex returns false and we degrade to the prior fan-out EXACTLY.
    const indexLoaded = await tryLoadIndex(env);
    if (!indexLoaded) {
        return { orderedShards: entries, indexLoaded: false, absenceProven: false };
    }

    // Index is present + parseable -> it is authoritative over presence.
    return applyLoadedIndex(shardForms, candidates);
}
