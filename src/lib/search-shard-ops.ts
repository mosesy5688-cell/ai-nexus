/**
 * Budgeted shard ops for the search route (B8), extracted from
 * src/pages/api/search.ts to keep that route under the CES Art 5.1 250-line cap
 * and to give the cold VFS/SQL tiers the same per-op + route-budget firewall the
 * compare API has (compare-budget.ts).
 *
 * Both `queryShardBatch` (browse) and `hydrateCandidates` (keyword + fallback)
 * open cold meta-NN.db shards and run SQL, each serialized behind the global
 * sqlite-engine lock. A cold open/SQL is ~3.5-4s additive, so an unbounded
 * Promise.all over cold shards rides to CF's ~30s ceiling -> HTTP-000. Here every
 * open + SQL is wrapped in withOpTimeout(SHARD_OP_TIMEOUT_MS, capped by the
 * remaining route budget) and the loop checks the route budget between batches.
 *
 * `exhausted` propagates UP so the route can distinguish a budget-degraded
 * partial/empty result from a genuine empty one (Founder: a transient must never
 * masquerade as an empty result). The per-op race does NOT cancel the loser
 * (op-timeout.ts header) — the
 * in-flight SQLite op finishes, releases its lock, and warms the cache.
 */
import { withOpTimeout, isOpTimeout, SHARD_OP_TIMEOUT_MS, MAX_BROWSE_SHARDS, type SearchBudget } from './search-budget.js';
import { groupByShard } from './term-index-engine.js';

/** Result of a budgeted shard scan. `exhausted` => the route saw a transient. */
export interface ShardOpResult {
    rows: any[];
    /** True if any batch bailed on budget or a per-op timeout (partial scan). */
    exhausted: boolean;
}

/** Per-op deadline = min(shard op cap, route's remaining budget). */
function opDeadline(budget: SearchBudget): number {
    return budget.opBudget(SHARD_OP_TIMEOUT_MS);
}

/**
 * Browse-mode shard query with bounded concurrency + route-budget loop + per-op
 * firewall + a hard cap on distinct cold shards. Over budget / over cap -> stop
 * and flag exhausted (the route returns a retryable 503 rather than a 000).
 */
export async function queryShardBatchBudgeted(
    dbs: string[], sql: string, params: any[], r2Bucket: any, shouldSimulate: boolean,
    budget: SearchBudget,
    openShard: (dbName: string) => Promise<any>,
    runSql: (engine: any, sql: string, params: any[]) => Promise<any[]>,
): Promise<ShardOpResult> {
    const CONCURRENCY_LIMIT = 4;
    // Cap distinct cold opens BEFORE looping: a pathological priority+expansion
    // set could queue dozens of cold opens behind the global lock. Excess shards
    // are dropped (honest partial) rather than ridden to the ceiling.
    const capped = dbs.slice(0, MAX_BROWSE_SHARDS);
    let exhausted = dbs.length > capped.length;
    let rows: any[] = [];
    for (let i = 0; i < capped.length; i += CONCURRENCY_LIMIT) {
        if (budget.over()) { exhausted = true; break; }
        const chunk = capped.slice(i, i + CONCURRENCY_LIMIT);
        const chunkResults = await Promise.all(chunk.map(async (dbName) => {
            try {
                const engine = await withOpTimeout(openShard(dbName), opDeadline(budget), `browse:open:${dbName}`);
                return await withOpTimeout(runSql(engine, sql, params), opDeadline(budget), `browse:sql:${dbName}`);
            } catch (err: any) {
                // A hung/transient shard ≠ "absent": treat as a failed shard and
                // flag the scan partial so the route never reports a clean result.
                console.warn(`[SSR Search] browse shard ${isOpTimeout(err) ? 'timeout' : 'failed'} ${dbName}: ${err?.message}`);
                exhausted = true;
                return [];
            }
        }));
        rows = rows.concat(chunkResults.flat());
    }
    return { rows, exhausted };
}

/**
 * Hydrate candidate UMIDs from meta shards, budgeted. Groups by shard, opens only
 * the needed shards, queries by id. Same firewall as browse. `displayCols` is
 * passed in so the SELECT column contract stays owned by the route.
 */
export async function hydrateCandidatesBudgeted(
    candidates: { umid: string; score: number; shard: number }[],
    r2Bucket: any, shouldSimulate: boolean,
    budget: SearchBudget, displayCols: string,
    openShard: (dbName: string) => Promise<any>,
    runSql: (engine: any, sql: string, params: any[]) => Promise<any[]>,
): Promise<ShardOpResult> {
    const shardGroups = groupByShard(candidates);
    const scoreMap = new Map(candidates.map(c => [c.umid, c.score]));
    const entries = [...shardGroups.entries()].slice(0, MAX_BROWSE_SHARDS);
    let exhausted = shardGroups.size > entries.length;
    const HYDRATION_CONCURRENCY = 4;
    const collected: any[][] = [];
    for (let i = 0; i < entries.length; i += HYDRATION_CONCURRENCY) {
        if (budget.over()) { exhausted = true; break; }
        const batch = entries.slice(i, i + HYDRATION_CONCURRENCY);
        const batchResults = await Promise.all(batch.map(async ([shardIdx, umids]) => {
            const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
            const placeholders = umids.map(() => '?').join(',');
            const sql = `SELECT ${displayCols} FROM entities e WHERE e.id IN (${placeholders})`;
            try {
                const engine = await withOpTimeout(openShard(dbName), opDeadline(budget), `hydrate:open:${dbName}`);
                const r = await withOpTimeout(runSql(engine, sql, umids), opDeadline(budget), `hydrate:sql:${dbName}`);
                for (const row of r) row._score = scoreMap.get(row.id) ?? 0;
                return r;
            } catch (err: any) {
                console.warn(`[SSR Search] hydration shard ${isOpTimeout(err) ? 'timeout' : 'failed'} ${dbName}: ${err?.message}`);
                exhausted = true;
                return [];
            }
        }));
        collected.push(...batchResults);
    }
    const allRows: any[] = [];
    for (const r of collected) allRows.push(...r);
    allRows.sort((a, b) => (b._score || 0) - (a._score || 0));
    for (const r of allRows) delete r._score;
    return { rows: allRows, exhausted };
}
