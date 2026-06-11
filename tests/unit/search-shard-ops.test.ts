import { describe, it, expect, vi } from 'vitest';
import { queryShardBatchBudgeted, hydrateCandidatesBudgeted } from '../../src/lib/search-shard-ops.js';
import { SearchBudget, SEARCH_BUDGET_MS, SHARD_OP_TIMEOUT_MS, MAX_BROWSE_SHARDS } from '../../src/lib/search-budget.js';

// B8 — budgeted cold-shard ops for the search route. Both browse (queryShardBatch)
// and keyword/fallback hydration open cold meta-NN.db shards + run SQL serialized
// behind the global sqlite lock; an unbounded Promise.all rode to CF's ~30s ceiling
// -> HTTP-000. These prove the per-op firewall (a hung open times out and is
// treated as a FAILED shard, not a throw), the between-batch route-budget bail,
// and the distinct-shard fan-out cap — all flagging `exhausted` so the route can
// tell a budget-degraded partial from a genuine empty (a transient must never
// masquerade as an empty result).

const COLS = 'e.id, e.name';
const runSql = async (_e: any, _sql: string, _p: any[]) => [{ id: 'row-1' }];

describe('queryShardBatchBudgeted — per-op timeout firewall', () => {
    it('a shard whose open hangs is a FAILED shard (not a throw); loop continues, exhausted=true', async () => {
        vi.useFakeTimers();
        try {
            const open = vi.fn((dbName: string) =>
                dbName.includes('meta-00') || dbName === 's0'
                    ? new Promise(() => {})                 // hangs -> times out
                    : Promise.resolve({ sqlite3: {}, db: {} }));
            const budget = new SearchBudget(Date.now());
            const p = queryShardBatchBudgeted(['s0', 's1'], 'SELECT 1', [], null, false, budget, open as any, runSql);
            await vi.advanceTimersByTimeAsync(SHARD_OP_TIMEOUT_MS + 20);
            const res = await p;
            expect(res.exhausted).toBe(true);               // a shard failed -> partial
            expect(res.rows).toEqual([{ id: 'row-1' }]);    // s1 still resolved (no throw)
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('queryShardBatchBudgeted — fan-out cap + budget loop', () => {
    it('drops cold shards beyond MAX_BROWSE_SHARDS and flags exhausted (never queues dozens of opens)', async () => {
        const open = vi.fn(async () => ({ sqlite3: {}, db: {} }));
        const dbs = Array.from({ length: MAX_BROWSE_SHARDS + 3 }, (_, i) => `s${i}`);
        const budget = new SearchBudget(Date.now());
        const res = await queryShardBatchBudgeted(dbs, 'SELECT 1', [], null, false, budget, open, runSql);
        expect(res.exhausted).toBe(true);                   // some shards were dropped
        expect(open).toHaveBeenCalledTimes(MAX_BROWSE_SHARDS); // capped, not all 11 opened
    });

    it('over-budget before the first batch -> opens nothing, exhausted=true', async () => {
        const open = vi.fn(async () => ({ sqlite3: {}, db: {} }));
        const past = new SearchBudget(Date.now() - (SEARCH_BUDGET_MS + 100)); // already spent
        const res = await queryShardBatchBudgeted(['s0', 's1'], 'SELECT 1', [], null, false, past, open, runSql);
        expect(res.exhausted).toBe(true);
        expect(open).not.toHaveBeenCalled();
    });

    it('warm fast scan -> complete, NOT exhausted, rows collected', async () => {
        const open = vi.fn(async () => ({ sqlite3: {}, db: {} }));
        const res = await queryShardBatchBudgeted(['s0', 's1'], 'SELECT 1', [], null, false, new SearchBudget(Date.now()), open, runSql);
        expect(res.exhausted).toBe(false);
        expect(res.rows.length).toBe(2);                    // one row per shard
    });
});

describe('hydrateCandidatesBudgeted — per-op timeout + warm scan', () => {
    const candidates = [
        { umid: 'a', score: 90, shard: 1 },
        { umid: 'b', score: 80, shard: 2 },
    ];

    it('warm hydration -> rows sorted by score, _score stripped, not exhausted', async () => {
        const open = vi.fn(async () => ({ sqlite3: {}, db: {} }));
        const run = vi.fn(async (_e: any, _sql: string, ids: string[]) => ids.map((id) => ({ id })));
        const res = await hydrateCandidatesBudgeted(candidates, null, false, new SearchBudget(Date.now()), COLS, open, run);
        expect(res.exhausted).toBe(false);
        expect(res.rows.map((r: any) => r.id)).toEqual(['a', 'b']); // score-desc order
        expect('_score' in res.rows[0]).toBe(false);               // internal field stripped
    });

    it('a hung shard open -> failed shard (no throw), exhausted=true', async () => {
        vi.useFakeTimers();
        try {
            const open = vi.fn(() => new Promise(() => {}));        // every shard hangs
            const run = vi.fn(async () => [{ id: 'x' }]);
            const p = hydrateCandidatesBudgeted(candidates, null, false, new SearchBudget(Date.now()), COLS, open as any, run);
            await vi.advanceTimersByTimeAsync(SHARD_OP_TIMEOUT_MS + 20);
            const res = await p;
            expect(res.exhausted).toBe(true);
            expect(res.rows).toEqual([]);                          // nothing resolved -> route 503s
        } finally {
            vi.useRealTimers();
        }
    });
});
