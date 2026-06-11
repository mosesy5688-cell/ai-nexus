import { describe, it, expect, vi } from 'vitest';
import {
    SearchBudget, searchTransient503,
    SEARCH_BUDGET_MS, TERM_FETCH_TIMEOUT_MS, SHARD_OP_TIMEOUT_MS,
    EMBED_TIMEOUT_MS, FALLBACK_TIMEOUT_MS, MAX_BROWSE_SHARDS,
    type SearchReason,
} from '../../src/lib/search-budget.js';

// B8 — search route budget primitives. Search was the LAST read endpoint with
// ZERO timeout protection: term-index R2 fetches, cold VFS opens + SQL, and the
// Tier-2 cluster fallback (unbounded embed + 2 full-bin GETs) could each stall to
// CF's ~30s ceiling -> HTTP-000. These prove the budget tracker + honest-503
// builder behave (sane constants, per-op deadline = min(cap, remaining), 503 is
// no-store + Retry-After + machine-readable reason).

describe('search-budget — sane constants (cold-path parity)', () => {
    it('route budget matches compare/entity (6000) and every per-op cap <= it', () => {
        expect(SEARCH_BUDGET_MS).toBe(6000);
        for (const cap of [TERM_FETCH_TIMEOUT_MS, SHARD_OP_TIMEOUT_MS, EMBED_TIMEOUT_MS, FALLBACK_TIMEOUT_MS]) {
            expect(cap).toBeGreaterThan(0);
            expect(cap).toBeLessThanOrEqual(SEARCH_BUDGET_MS);
        }
        expect(MAX_BROWSE_SHARDS).toBeGreaterThan(0);
    });
});

describe('SearchBudget — wall-clock tracking', () => {
    it('over() flips once the route budget is spent; remaining() floors at 0', () => {
        const base = 1_000_000;
        let now = base;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const b = new SearchBudget(base);
            expect(b.over()).toBe(false);
            expect(b.remaining()).toBe(SEARCH_BUDGET_MS);
            now = base + SEARCH_BUDGET_MS + 50;          // budget spent
            expect(b.over()).toBe(true);
            expect(b.remaining()).toBe(0);               // never negative
        } finally {
            clock.mockRestore();
        }
    });

    it('opBudget = min(op cap, remaining budget), floored at 1ms', () => {
        const base = 1_000_000;
        let now = base;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const b = new SearchBudget(base);
            // Fresh: the op cap (4000) is the binding constraint, not the 6000 budget.
            expect(b.opBudget(TERM_FETCH_TIMEOUT_MS)).toBe(TERM_FETCH_TIMEOUT_MS);
            // Late in the request: only 800ms of budget left -> that caps the op.
            now = base + (SEARCH_BUDGET_MS - 800);
            expect(b.opBudget(SHARD_OP_TIMEOUT_MS)).toBe(800);
            // Budget fully spent -> still a positive (1ms) deadline, never 0/negative.
            now = base + SEARCH_BUDGET_MS + 10;
            expect(b.opBudget(SHARD_OP_TIMEOUT_MS)).toBe(1);
        } finally {
            clock.mockRestore();
        }
    });
});

describe('searchTransient503 — honest envelope', () => {
    it('503 carries no-store + Retry-After + machine-readable reason/tier; never cacheable', async () => {
        const reason: SearchReason = 'cluster_fallback_budget';
        const res = searchTransient503(reason, 'cluster_fallback');
        expect(res.status).toBe(503);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Retry-After')).toBe('2');
        const body = await res.json();
        expect(body.transient).toBe(true);
        expect(body.reason).toBe(reason);
        expect(body.tier).toBe('cluster_fallback');
        // Must read as transient, never as a clean empty result.
        expect(body.error).toMatch(/transient|budget/i);
        expect(body.results).toBeUndefined();
    });

    it('honors a custom Retry-After', async () => {
        const res = searchTransient503('search_budget_exceeded', 'browse', '5');
        expect(res.headers.get('Retry-After')).toBe('5');
    });
});
