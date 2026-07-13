/**
 * Compare route budget envelope (B7).
 *
 * /api/v1/compare was the only read endpoint with ZERO timeout protection: an
 * un-bounded Promise.all over shard groups, each serialized behind the global
 * sqlite-engine withLock (the wa-sqlite Asyncify guard — untouchable). A cold
 * shard open/SQL is ~3.5-4s additive; paper ids fan to 3-4 shards each
 * (generatePaperCandidates), so a handful of cold papers deterministically
 * blew past CF's ~30s wall-clock ceiling into an HTTP-000 dead connection
 * (and, via mcp.ts, a thrown MCP tool error / dead connection).
 *
 * This module bounds the cold fan-out the same way the entity API does
 * (src/pages/api/v1/entity/[...id].ts + op-timeout.ts):
 *   - a wall-clock LOOP budget (COMPARE_BUDGET_MS) checked between shards,
 *   - a per-op firewall (OP_TIMEOUT_MS) on each cold open / SQL step, and
 *   - a hard cap (MAX_COLD_SHARDS) on the number of distinct shards a single
 *     request may open (papers are the multiplier).
 * On budget/cap exhaustion the caller returns an honest retryable 503 — never
 * a ride to a dead connection, never fake completeness.
 *
 * Like op-timeout.ts, the per-op race does NOT cancel the loser: the in-flight
 * SQLite op must finish so it releases the promise-chain lock via its own
 * `finally` and warms the connection cache for the retry. Force-releasing would
 * reintroduce the Asyncify re-entrancy bug. Leave the global lock alone.
 */
import { withOpTimeout, isOpTimeout } from './op-timeout.js';

// Wall-clock budget for the cold-shard query LOOP. Mirrors the entity API's
// PROBE_BUDGET_MS (6000): one cold shard is ~3.5-4s additive (serialized by the
// global lock), so this admits ~1 cold shard plus warm-cache hits before bailing
// — and the worst-case total response stays far under CF's ~30s ceiling. Bailing
// yields a retryable 503, never a hard "found:false" miss (a slow/transient shard
// is not "absent"). Kept identical to entity so the two cold-path budgets agree.
export const COMPARE_BUDGET_MS = 6000;

// Per-op firewall. COMPARE_BUDGET_MS bounds the loop BETWEEN shards; this bounds
// a SINGLE cold op that hangs (a stalled R2 range read inside one connection-open
// or SQL step), so one hung op cannot eat the whole budget or hang past it. Must
// stay <= COMPARE_BUDGET_MS. On timeout the op is NOT cancelled (op-timeout.ts
// header) — it finishes in the background, releases its SQLite lock, and warms the
// cache for the retry. Identical to the entity API's OP_TIMEOUT_MS.
export const OP_TIMEOUT_MS = 5000;

// Cold fan-out cap: the max distinct shards one compare request may open. Papers
// are the multiplier — generatePaperCandidates fans a single paper id to 3-4
// stored forms, each on its OWN shard, so a 25-id request of cold papers could
// otherwise try to open ~50+ cold shards serially (CF ~50-subrequest limit + the
// ~30s ceiling). 8 distinct cold shards at ~3.5-4s each ≈ 28-32s — already at the
// edge — so the COMPARE_BUDGET_MS loop bail is the primary bound and this cap is
// the structural belt-and-suspenders that stops a pathological fan-out from ever
// queueing dozens of cold opens behind the global lock. Exceeded -> honest 503.
export const MAX_COLD_SHARDS = 8;

/** Outcome of the budgeted shard scan. `exhausted` => caller returns 503. */
export interface ShardScanResult {
    /** Map of row.id and row.slug -> row, for id-resolution by the caller. */
    entityMap: Map<string, any>;
    /**
     * C4 Stage 1 — CANDIDATE-PRESERVING slug index: row.slug -> ALL rows sharing
     * that slug (deduped by id), NOT the last-write-wins single row that
     * `entityMap` keeps. A slug can be shared by two typed twins co-resident on
     * one shard; the old `entityMap.set(row.slug, row)` silently dropped the
     * earlier twin, so a bare-slug compare id resolved to an arbitrary rowid
     * winner. The caller uses this to detect a bare-slug ambiguity explicitly
     * while EXACT typed ids still resolve to their own twin via `entityMap`.
     */
    slugMap: Map<string, any[]>;
    /** True if the loop bailed on budget, op-timeout, or the fan-out cap. */
    exhausted: boolean;
    /** Why it bailed (telemetry / 503 body hint). */
    reason: 'budget' | 'fanout_cap' | 'op_timeout' | null;
    /** Distinct shards actually opened (telemetry). */
    probedShards: number;
}

/**
 * Sequentially query each shard group with the budget + per-op + fan-out-cap
 * envelope. Sequential (not Promise.all) because the global sqlite lock
 * serializes every op anyway, so a flat loop with a between-shards budget check
 * is the only way to bail cold BEFORE the ~30s ceiling. Each shard's open + SQL
 * is wrapped in withOpTimeout; a per-op timeout or transient shard error is
 * treated as a failed shard and the loop continues honestly (a missed shard ≠
 * "absent"), but it also flips `exhausted` so the caller never reports a
 * partial scan as a clean/complete result.
 *
 * @param shardGroups  shardIdx -> set of candidate keys hashed to that shard
 * @param openShard    opens (or returns cached) the engine for a shard db name
 * @param runSql       runs the compare SELECT against an opened engine + keys
 */
export async function scanShardsBudgeted(
    shardGroups: Map<number, Set<string>>,
    openShard: (dbName: string) => Promise<any>,
    runSql: (engine: any, keys: string[]) => Promise<any[]>,
    start: number,
): Promise<ShardScanResult> {
    const entityMap = new Map<string, any>();
    const slugMap = new Map<string, any[]>();
    let probedShards = 0;
    let exhausted = false;
    let reason: ShardScanResult['reason'] = null;

    // Hard fan-out cap BEFORE any open: a single request fanning to more than
    // MAX_COLD_SHARDS distinct shards is a pathological multi-paper request that
    // cannot complete inside the budget — fail honestly rather than queue dozens
    // of cold opens behind the global lock and ride to a dead connection.
    if (shardGroups.size > MAX_COLD_SHARDS) {
        return { entityMap, slugMap, exhausted: true, reason: 'fanout_cap', probedShards: 0 };
    }

    for (const [shardIdx, queryKeys] of shardGroups.entries()) {
        // Between-shards wall-clock check: bail before opening the next cold
        // shard if the budget is spent (a slow/transient miss, not "absent").
        if (Date.now() - start > COMPARE_BUDGET_MS) { exhausted = true; reason = 'budget'; break; }
        probedShards++;
        const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
        const keys = [...queryKeys];
        try {
            const engine = await withOpTimeout(openShard(dbName), OP_TIMEOUT_MS, `open:${dbName}`);
            const rows = await withOpTimeout(runSql(engine, keys), OP_TIMEOUT_MS, `sql:${dbName}`);
            for (const row of rows) {
                entityMap.set(row.id, row);
                // entityMap keeps the legacy slug key (last-write-wins) for
                // back-compat; slugMap is the candidate-preserving twin index.
                if (row.slug) {
                    entityMap.set(row.slug, row);
                    const arr = slugMap.get(row.slug);
                    if (arr) { if (!arr.some((r: any) => r.id === row.id)) arr.push(row); }
                    else slugMap.set(row.slug, [row]);
                }
            }
        } catch (e: any) {
            // A hung/transient shard is treated as failed and the loop continues
            // (another shard may satisfy other ids), but the scan is now partial:
            // flag exhausted so the caller cannot report a clean/complete result.
            console.warn(`[COMPARE] shard ${isOpTimeout(e) ? 'timeout' : 'error'}`, dbName, e?.message);
            exhausted = true;
            if (!reason) reason = isOpTimeout(e) ? 'op_timeout' : 'budget';
        }
    }
    return { entityMap, slugMap, exhausted, reason, probedShards };
}
