/**
 * B4 — id-index absence oracle + index-driven candidate resolution.
 *
 * The slim v2 id-index (data/id-index.bin, id-index-generator.js) keys EVERY
 * resolvable form (id / slug / umid, lowercased) of EVERY corpus entity to the
 * single meta-shard the packer wrote it to. Because it enumerates every
 * resolvable key, a successfully-completed index lookup is a COMPLETE absence
 * oracle:
 *
 *   - lookup ok AND a candidate hits  -> the entity exists; probe the 1-2
 *     shards the index resolves FIRST (a real entity is found on the first
 *     probe), then the rest of the original fan-out. indexResolved=true tells
 *     the caller that an all-shards miss is INCONCLUSIVE (503), never a 404:
 *     shard handles are cached per isolate and not revalidated across publishes
 *     (sqlite-engine dbCache by dbName, r2-vfs size/etag + chunk caches), so a
 *     clean miss on a stale handle must not be read as absence (ENT-503 review F1).
 *   - lookup ok AND NO candidate hits -> the entity is GENUINELY absent in the
 *     index version read (coherent with the served manifest); return
 *     an honest 404 with ZERO cold-shard probes (10 cold opens can never finish
 *     inside PROBE_BUDGET_MS, so without this the clean-exhaustion 404 branch is
 *     structurally unreachable and real misses 503).
 *   - index absent / unreadable / timed out / changed mid-lookup -> DEGRADE to
 *     the prior behavior EXACTLY: the original shardForms order, full fan-out,
 *     budget-gated probe.
 *
 * The index NEVER decides DATA: a resolved shard is still probed with the real
 * SELECT, so an index hash collision only mis-routes. The only NEW power is the
 * all-miss verdict, gated on a completed AND build-id-coherent lookup.
 *
 * ENT-503 (I-1): the lookup no longer loads the whole index into the isolate
 * (that load was refused once the append-only corpus pushed the file past the
 * reader's 30 MB guard, so this oracle was dead in production from 2026-10-08).
 * id-index-reader.ts lookupForms reads the header + small etag-pinned key-table
 * windows (interpolation search) instead; the lookup is raced against
 * INDEX_LOAD_TIMEOUT_MS so its own I/O can never consume the probe budget.
 *
 * Shared by /api/v1/entity/[...id].ts and utils/vfs-metadata-provider.ts (the
 * paper / detail-page resolver) so paper pages benefit through this code path,
 * NOT a page-specific patch.
 *
 * FAN-OUT GATE. Gated on the PRE-oracle unique shard fan-out (distinct shards
 * across all candidates, computed BEFORE any oracle consultation):
 *   fan-out <= 2 : do NOT consult the index (no index I/O). Behave EXACTLY as
 *                  the degrade path: original order, full fan-out, full budget.
 *                  (The former "already warm in this isolate" shortcut is gone
 *                  with the resident index; this is what production has done
 *                  since the index was refused.)
 *   fan-out >= 3 : await the bounded lookup (shrink + absence + degrade).
 * The gate never widens the budget, splits it, or probes-everything-then-404.
 */
import { lookupForms, type IdIndexHit, type IndexStatus, type IndexLookup } from './id-index-reader.js';
import { withOpTimeout } from './op-timeout.js';

// B4 VERSION-COHERENCE GATE (Founder, locked):
//   "id-index may prove absence only when id-index build-id and served shard
//    manifest build-id are verified coherent for the same request."
// absenceProofAllowed === (indexBuildId === manifestBuildId), both non-empty, for
// THIS request. Under ANY incoherence (mismatch / either build_id missing / index
// missing / parse fail / manifest missing / stale-unprovable) the index may STILL
// reorder candidates (non-destructive: every original shard is still probed) but
// MUST NOT prove absence (no zero-probe 404) and MUST NOT destructively shrink
// (dropping un-resolved candidate shards while incoherent could hide a real
// entity baked into a newer served shard the stale index never enumerated).
// ENT-503: indexBuildId is the token of the EXACT object version searched (every
// range read is etag-pinned to the header read), never a cached guess.
function isCoherent(indexBuildId: string | null, manifestBuildId: string | null): boolean {
    return !!indexBuildId && !!manifestBuildId && indexBuildId === manifestBuildId;
}

// Bound the index lookup's own I/O so it cannot eat the probe budget. On miss
// we degrade to the fan-out (the index is best-effort, never on the critical
// path). Comfortably under PROBE_BUDGET_MS (6000ms) so even a slow lookup leaves
// room for at least one real shard probe. Unchanged by ENT-503.
export const INDEX_LOAD_TIMEOUT_MS = 2500;

// Pre-oracle unique-shard fan-out at/below which we do NOT consult the index.
// <=2 distinct shards already fit the full probe budget without it. Threshold is
// the count BEFORE any oracle consultation (never post-shrink).
export const ORACLE_FANOUT_THRESHOLD = 2;

export interface ShardResolution {
    /**
     * Shard entries to probe, in order: the full original fan-out, at most
     * NON-DESTRUCTIVELY reordered so resolved shard(s) are probed first (empty
     * only when absence is proven). Nothing is ever dropped (ENT-503 review F1).
     */
    orderedShards: [number, string[]][];
    /** True iff the index lookup completed ('ok') for this request. */
    indexLoaded: boolean;
    /**
     * True ONLY when the lookup completed, is build-id-COHERENT with the served
     * manifest for THIS request, AND no candidate resolved in it. The caller may
     * then return an honest 404 with NO shard probes.
     */
    absenceProven: boolean;
    /** ENT-503 attribution: ok / absent / bad_header / r2_error / version_changed /
     *  search_exhausted / timeout / not_consulted. */
    indexStatus: IndexStatus;
    /** ENT-503 attribution: lookup ok AND build_id === served manifest's. */
    coherent: boolean;
    /**
     * True when a COHERENT index resolved a candidate: the entity exists in the
     * served build, so if no probed shard returns a row the caller MUST answer
     * inconclusive (503), never 404 (stale shard handle / collision).
     */
    indexResolved: boolean;
    /** Attribution: build_id of the index version read, the served manifest's,
     *  index object size, lookup wall time, cached-header age. */
    diag: { indexBuildId: string | null; manifestBuildId: string | null; size: number; ms: number; headerAgeMs: number };
}

/** One-line attribution for the caller's inconclusive log (kept out of the route for CES). */
export function describeResolution(r: ShardResolution): string {
    const d: Partial<Diag> = r.diag ?? {};
    return `idx=${r.indexLoaded} ist=${r.indexStatus} coh=${r.coherent} res=${r.indexResolved} ` +
        `ibid=${d.indexBuildId ?? '-'} mbid=${d.manifestBuildId ?? '-'} isz=${d.size} ims=${d.ms} iage=${d.headerAgeMs}`;
}

type Diag = ShardResolution['diag'];

function degrade(entries: [number, string[]][], indexStatus: IndexStatus, diag: Diag): ShardResolution {
    return { orderedShards: entries, indexLoaded: false, absenceProven: false, indexStatus, coherent: false, indexResolved: false, diag };
}

/**
 * Apply a completed lookup to the candidate plan, split on build-id coherence:
 *   - COHERENT   : resolved shard(s) first + indexResolved, OR prove absence
 *                  (zero-probe 404) when nothing resolves.
 *   - INCOHERENT : NEVER prove absence, NEVER drop a candidate shard. Only a
 *                  NON-DESTRUCTIVE reorder: resolved shard(s) first, then every
 *                  remaining original shard in its insertion order.
 */
function applyIndex(
    shardForms: Map<number, string[]>,
    candidates: string[],
    hits: Map<string, IdIndexHit | null>,
    coherent: boolean,
    diag: Diag,
): ShardResolution {
    // A resolved shard not in shardForms is still probed with this candidate so
    // a real entity is never made unreachable.
    const resolved: [number, string[]][] = [];
    const seenShard = new Set<number>();
    for (const c of candidates) {
        const hit = hits.get(String(c).toLowerCase());
        if (!hit || seenShard.has(hit.shardIdx)) continue;
        seenShard.add(hit.shardIdx);
        resolved.push([hit.shardIdx, shardForms.get(hit.shardIdx) ?? [c]]);
    }
    const base = { indexLoaded: true, indexStatus: 'ok' as IndexStatus, coherent, diag };
    if (coherent && resolved.length === 0) {
        // COHERENT completed lookup, zero hits across all candidates -> proven absence.
        return { ...base, orderedShards: [], absenceProven: true, indexResolved: false };
    }
    const tail = [...shardForms.entries()].filter(([s]) => !seenShard.has(s));
    return {
        ...base, orderedShards: [...resolved, ...tail], absenceProven: false,
        indexResolved: coherent && resolved.length > 0,
    };
}

/**
 * Resolve the shard set to probe for a candidate plan, using the id-index as
 * BOTH a candidate-set reducer and an absence oracle. See module header.
 *
 * @param shardForms       candidate-form -> shard map (Map insertion order = the
 *                         caller's highest-probability-first fan-out order).
 * @param candidates       the ordered candidate forms (same forms as shardForms).
 * @param env              CF env (R2 binding).
 * @param manifestBuildId  build_id of the served shards_manifest.json the CALLER
 *                         loaded for THIS request; null/undefined -> incoherent.
 * @param indexBlobKey     MF-4 pinned id-index blob key (undefined in legacy_only).
 */
export async function resolveShardsForCandidates(
    shardForms: Map<number, string[]>,
    candidates: string[],
    env: any,
    manifestBuildId?: string | null,
    indexBlobKey?: string,
): Promise<ShardResolution> {
    const entries = [...shardForms.entries()];
    const t0 = Date.now();
    const diag = (r?: IndexLookup): Diag => ({
        indexBuildId: r?.buildId ?? null, manifestBuildId: manifestBuildId ?? null,
        size: r?.size ?? 0, ms: Date.now() - t0, headerAgeMs: r?.headerAgeMs ?? 0,
    });
    if (shardForms.size <= ORACLE_FANOUT_THRESHOLD) return degrade(entries, 'not_consulted', diag());

    let res: IndexLookup;
    try {
        res = await withOpTimeout(lookupForms(env, candidates, indexBlobKey), INDEX_LOAD_TIMEOUT_MS, 'idindex:lookup');
    } catch {
        return degrade(entries, 'timeout', diag()); // never block on the index
    }
    if (res.status !== 'ok') return degrade(entries, res.status, diag(res));
    return applyIndex(shardForms, candidates, res.hits, isCoherent(res.buildId, manifestBuildId ?? null), diag(res));
}
