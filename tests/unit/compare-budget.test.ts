import { describe, it, expect, vi } from 'vitest';
import {
    scanShardsBudgeted,
    COMPARE_BUDGET_MS,
    OP_TIMEOUT_MS,
    MAX_COLD_SHARDS,
} from '../../src/lib/compare-budget.js';

// B7 — compare route budget envelope. /api/v1/compare was the only read endpoint
// with ZERO timeout protection: an un-bounded fan-out over shard groups, each
// serialized behind the global sqlite lock. A handful of cold papers (3-4 shards
// each) deterministically blew past CF's ~30s ceiling -> HTTP-000 dead connection.
// These prove the budgeted scan bails honestly (budget / per-op timeout / fan-out
// cap) WITHOUT cancelling the in-flight op (Asyncify guard untouched), and that a
// fast warm scan still returns a complete result with the envelope unchanged.

function shardGroup(n: number): Map<number, Set<string>> {
    const m = new Map<number, Set<string>>();
    for (let i = 0; i < n; i++) m.set(i, new Set([`key-${i}`]));
    return m;
}

describe('scanShardsBudgeted — sane constants', () => {
    it('per-op timeout never exceeds the loop budget (entity-API parity)', () => {
        expect(OP_TIMEOUT_MS).toBeLessThanOrEqual(COMPARE_BUDGET_MS);
        // Matches the entity API's 6000/5000 pair so both cold-path budgets agree.
        expect(COMPARE_BUDGET_MS).toBe(6000);
        expect(OP_TIMEOUT_MS).toBe(5000);
        expect(MAX_COLD_SHARDS).toBeGreaterThan(0);
    });
});

describe('scanShardsBudgeted — budget exhaustion', () => {
    it('bails on the wall-clock budget between cold shards, returns exhausted+reason', async () => {
        // start is already past the budget -> the very first between-shards check
        // bails before opening any shard. exhausted=true so the caller 503s.
        const open = vi.fn(async () => ({ sqlite3: {}, db: {} }));
        const run = vi.fn(async () => []);
        const past = Date.now() - (COMPARE_BUDGET_MS + 100);
        const res = await scanShardsBudgeted(shardGroup(3), open, run, past);
        expect(res.exhausted).toBe(true);
        expect(res.reason).toBe('budget');
        expect(res.probedShards).toBe(0);
        expect(open).not.toHaveBeenCalled();
    });

    it('queries the first shard within budget, then bails once budget is spent', async () => {
        // First shard opens + runs fast and resolves its row (honest partial). A
        // controllable clock then reports elapsed > budget, so the between-shards
        // check bails BEFORE opening the second shard. exhausted=true, reason=budget.
        const base = 1_000_000;
        let now = base;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            let opens = 0;
            const open = vi.fn(async () => { opens++; return { sqlite3: {}, db: {} }; });
            const run = vi.fn(async () => {
                // Simulate the first shard's SQL consuming the whole budget.
                now = base + COMPARE_BUDGET_MS + 50;
                return [{ id: 'a', slug: 'a-slug' }];
            });
            const res = await scanShardsBudgeted(shardGroup(3), open, run, base);
            expect(opens).toBe(1);            // only the first shard opened
            expect(res.exhausted).toBe(true);
            expect(res.reason).toBe('budget');
            expect(res.entityMap.get('a')).toBeTruthy();   // honest partial
        } finally {
            clock.mockRestore();
        }
    });
});

describe('scanShardsBudgeted — per-op timeout firewall', () => {
    it('a hung shard op is treated as a FAILED shard (not a throw); loop continues honestly', async () => {
        // Shard 0 hangs forever -> withOpTimeout rejects at OP_TIMEOUT_MS. The scan
        // must NOT throw: it records the shard as failed (exhausted=true) and keeps
        // going so other shards can still resolve their ids. We shorten the wait by
        // racing a deterministic slow op > OP_TIMEOUT_MS is too slow for a unit
        // test, so we assert the firewall via a never-resolving op + fake timers.
        vi.useFakeTimers();
        try {
            const open = vi.fn((dbName: string) =>
                dbName.includes('00')
                    ? new Promise(() => {})           // shard 0: never resolves -> times out
                    : Promise.resolve({ sqlite3: {}, db: {} }));
            const run = vi.fn(async () => [{ id: 'b', slug: 'b-slug' }]);
            const p = scanShardsBudgeted(shardGroup(2), open as any, run, Date.now());
            // Advance past the per-op deadline so shard 0's open rejects.
            await vi.advanceTimersByTimeAsync(OP_TIMEOUT_MS + 10);
            const res = await p;
            expect(res.exhausted).toBe(true);          // a shard failed
            expect(res.reason).toBe('op_timeout');
            // Shard 1 still ran and resolved its row -> loop continued, no throw.
            expect(res.entityMap.get('b')).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('scanShardsBudgeted — cold fan-out cap', () => {
    it('a request fanning to more than MAX_COLD_SHARDS distinct shards 503s before any open', async () => {
        const open = vi.fn(async () => ({ sqlite3: {}, db: {} }));
        const run = vi.fn(async () => []);
        const res = await scanShardsBudgeted(shardGroup(MAX_COLD_SHARDS + 1), open, run, Date.now());
        expect(res.exhausted).toBe(true);
        expect(res.reason).toBe('fanout_cap');
        expect(res.probedShards).toBe(0);
        expect(open).not.toHaveBeenCalled();          // never queued cold opens
    });

    it('exactly MAX_COLD_SHARDS is allowed (boundary, not exceeded)', async () => {
        const open = vi.fn(async () => ({ sqlite3: {}, db: {} }));
        const run = vi.fn(async () => []);
        const res = await scanShardsBudgeted(shardGroup(MAX_COLD_SHARDS), open, run, Date.now());
        expect(res.reason).not.toBe('fanout_cap');
        expect(open).toHaveBeenCalledTimes(MAX_COLD_SHARDS);
    });
});

describe('scanShardsBudgeted — normal warm scan', () => {
    it('all shards resolve fast -> complete, not exhausted, rows mapped by id AND slug', async () => {
        const open = vi.fn(async () => ({ sqlite3: {}, db: {} }));
        const run = vi.fn(async (_e: any, keys: string[]) => [{ id: keys[0], slug: `${keys[0]}-slug` }]);
        const res = await scanShardsBudgeted(shardGroup(2), open, run, Date.now());
        expect(res.exhausted).toBe(false);
        expect(res.reason).toBeNull();
        expect(res.probedShards).toBe(2);
        expect(res.entityMap.get('key-0')).toBeTruthy();
        expect(res.entityMap.get('key-0-slug')).toBeTruthy();   // indexed by slug too
    });
});
