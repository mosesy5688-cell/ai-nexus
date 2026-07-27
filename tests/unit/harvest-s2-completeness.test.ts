import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The NDJSON bridge is mocked so this suite can PROVE it is not reached on an
// incomplete run (the gate must sit above it), without writing shard files.
vi.mock('../../scripts/ingestion/ndjson-sharder.js', () => ({
    shardNDJSON: vi.fn(async () => ({ shards: 0 })),
}));

// @ts-ignore -- JS ESM modules (no .d.ts); tested for their runtime contract.
import { shardNDJSON } from '../../scripts/ingestion/ndjson-sharder.js';
// @ts-ignore
import { SemanticScholarAdapter } from '../../scripts/ingestion/adapters/semanticscholar-adapter.js';
// @ts-ignore
import { RateLimitExceededError, FetchError } from '../../scripts/ingestion/adapters/base-adapter.js';
// @ts-ignore
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';
// @ts-ignore
import { COMPLETION_STATUS, TERMINATION_REASON, isComplete, buildCompletionRecord, evaluateCompletionGate } from '../../scripts/ingestion/harvest-completion.js';
// @ts-ignore
import { TERMINAL, TOTAL_RETRY_BUDGET_MS } from '../../scripts/ingestion/adapters/s2-retry-envelope.js';
// @ts-ignore
import { DEFAULT_FLOORS } from '../../scripts/ingestion/harvest-floors.js';

// Founder ruling, 2026-07-26 (Factory 1/4 S2 incident, run 30189935455).
//
// A required source that abandoned planned work must satisfy ALL FOUR of:
//     mark incomplete  AND  exit non-zero  AND  block bridge  AND  block authority
// Marking `terminalMeta`/`partial` while still exiting 0 is NOT a repair -- that is
// exactly the hole, because the bridge and the (non-`always()`) R2 source-authority
// step then run and publish a partial harvest as the authoritative record.
//
// THE BLOCKING COUNTEREXAMPLE: 4 planned topics, 3 completed, ~2,250 rows, floor
// 300. The floor is ~10% of a 3,000 target -- an anti-zero control, not a
// completeness gate -- so it passes and the run looks healthy.

function page(ids: string[], token: string | null = null) {
    return { total: ids.length, token, data: ids.map((id) => ({ paperId: id, title: `T ${id}`, abstract: 'a' })) };
}
const ok = (body: any) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, headers: { get: () => null } });
const bad = (status: number) => ({ ok: false, status, statusText: `E${status}`, json: async () => ({}), headers: { get: () => null } });

function rows(topic: string, n: number) {
    return page(Array.from({ length: n }, (_, i) => `${topic}-${i}`));
}

function fastAdapter() {
    const a: any = new SemanticScholarAdapter();
    a.retryDeps = { sleep: async () => undefined };
    vi.spyOn(a, 'delay').mockResolvedValue(undefined as any);
    return a;
}

function captureSidecars() {
    const seen: any[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
        const f = typeof args[0] === 'string' ? args[0] : '';
        if (f.startsWith('HARVEST_STATE ')) seen.push(JSON.parse(f.slice('HARVEST_STATE '.length)));
    });
    return { seen, spy };
}

/** Run the REAL S2 adapter through the REAL chokepoint. Bridge NOT skipped. */
async function run(mock: (url: any) => Promise<any>, limit: number, adapter = fastAdapter()) {
    vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(mock as any);
    const cap = captureSidecars();
    const result = await harvestSingle('semanticscholar', { limit, _adapter: adapter });
    cap.spy.mockRestore();
    return { result, sidecar: cap.seen[cap.seen.length - 1], adapter };
}

const topicOf = (url: any) => decodeURIComponent(String(url).match(/query=([^&]+)/)![1]);
describe('S2 required-source completeness -- incomplete => exit non-zero, no bridge, no authority', () => {
    beforeEach(() => {
        (shardNDJSON as any).mockClear();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    // ---- COMPLETE endings ------------------------------------------------
    it('4/4 topics cleanly exhausted -> success, completion_status=complete, bridge RUNS', async () => {
        const { result, sidecar } = await run(async (url) => ok(rows(topicOf(url), 400)), 4000);
        expect(result.error).toBeUndefined();
        expect(sidecar.status).toBe('success');
        expect(sidecar.completion_status).toBe(COMPLETION_STATUS.COMPLETE);
        expect(sidecar.terminal_meta.planned_topics).toBe(4);
        expect(sidecar.terminal_meta.completed_topics).toBe(4);
        expect(sidecar.terminal_meta.limit_satisfied).toBe(false);
        expect(sidecar.terminal_meta.termination_reason).toBe(TERMINATION_REASON.ALL_UNITS_EXHAUSTED);
        expect(shardNDJSON).toHaveBeenCalled(); // the bridge is reached on a complete run
    });

    it('configured limit satisfied before all topics -> success (limit_satisfied is a COMPLETE ending)', async () => {
        // limit 500: topic 1 alone delivers 600 rows, so topics 2-4 are never walked.
        const { result, sidecar } = await run(async (url) => ok(rows(topicOf(url), 600)), 500);
        expect(result.error).toBeUndefined();
        expect(sidecar.status).toBe('success');
        expect(sidecar.completion_status).toBe(COMPLETION_STATUS.COMPLETE);
        expect(sidecar.terminal_meta.limit_satisfied).toBe(true);
        expect(sidecar.terminal_meta.completed_topics).toBeLessThan(sidecar.terminal_meta.planned_topics);
        expect(sidecar.terminal_meta.termination_reason).toBe(TERMINATION_REASON.LIMIT_SATISFIED);
    });

    it('retry recovery (500,500,200) -> complete success, not merely "not failed"', async () => {
        const seen: Record<string, number> = {};
        const { result, sidecar } = await run(async (url) => {
            const t = topicOf(url);
            seen[t] = (seen[t] || 0) + 1;
            return seen[t] <= 2 ? bad(500) : ok(rows(t, 400));
        }, 4000);
        expect(result.error).toBeUndefined();
        expect(sidecar.status).toBe('success');
        expect(sidecar.completion_status).toBe(COMPLETION_STATUS.COMPLETE);
        expect(sidecar.terminal_meta.completed_topics).toBe(4);
    });

    // ---- THE BLOCKING COUNTEREXAMPLE -------------------------------------
    it('3/4 topics, ~2,250 rows, floor 300 -> NOT success, incomplete, result.error, NO bridge', async () => {
        const healthy = ['machine learning', 'artificial intelligence', 'nlp'];
        const { result, sidecar } = await run(async (url) => {
            const t = topicOf(url);
            return healthy.includes(t) ? ok(rows(t, 750)) : bad(500);
        }, 4000);

        expect(sidecar.yield).toBe(2250);                                    // the exact counterexample
        expect(sidecar.yield).toBeGreaterThan(DEFAULT_FLOORS.semanticscholar); // floor passes
        expect(sidecar.floor_violated).toBe(false);
        expect(sidecar.status).not.toBe('success');
        expect(sidecar.completion_status).toBe(COMPLETION_STATUS.INCOMPLETE);
        expect(sidecar.terminal_meta.completed_topics).toBe(3);
        expect(sidecar.terminal_meta.planned_topics).toBe(4);
        expect(sidecar.terminal_meta.limit_satisfied).toBe(false);
        expect(sidecar.terminal_meta.failed_topic).toBe('computer vision');
        expect(sidecar.terminal_meta.last_http_status).toBe(500);
        expect(result.error).toBeTruthy();          // -> harvest-cli exits 1
        expect(shardNDJSON).not.toHaveBeenCalled(); // -> no bridge shards
        // This stop DID carry a hard error, so had_adapter_error is honestly true.
        expect(sidecar.had_adapter_error).toBe(true);
    });

    // ---- NON-HARD early stops still block --------------------------------
    it('rate-limit breaker after partial yield -> incomplete, result.error, exit 1, had_adapter_error=false', async () => {
        const adapter = fastAdapter();
        const healthy = ['machine learning', 'artificial intelligence', 'nlp'];
        let tripped = false;
        vi.spyOn(adapter, 'handleRateLimit').mockImplementation(async () => {
            tripped = true;
            throw new RateLimitExceededError('semanticscholar', '6 attempts');
        });
        const { result, sidecar } = await run(async (url) => {
            const t = topicOf(url);
            return healthy.includes(t) ? ok(rows(t, 750)) : bad(429);
        }, 4000, adapter);

        expect(tripped).toBe(true);
        expect(sidecar.yield).toBe(2250);
        expect(sidecar.floor_violated).toBe(false);
        // The taxonomy is PRESERVED: a rate limit is not a hard adapter error...
        expect(sidecar.had_adapter_error).toBe(false);
        // ...but it no longer buys authority eligibility.
        expect(sidecar.status).not.toBe('success');
        expect(sidecar.status).toBe('rate_limited');
        expect(sidecar.completion_status).toBe(COMPLETION_STATUS.INCOMPLETE);
        expect(sidecar.terminal_meta.termination_reason).toBe(TERMINATION_REASON.RATE_LIMIT_BREAKER);
        expect(sidecar.terminal_meta.completed_topics).toBe(3);
        expect(result.error).toBeTruthy();
        expect(shardNDJSON).not.toHaveBeenCalled();
    });

    it('a NON-throwing early stop is blocked too (the seam does not depend on an error)', async () => {
        // The general case the counterexample generalises to: an adapter that stops
        // early, resolves cleanly, and publishes an incomplete claim. No throw at all.
        const fake: any = {
            entityTypes: ['paper'],
            normalize: (r: any) => r,
            completion: null,
            fetch: async (opts: any) => {
                await opts.onBatch(Array.from({ length: 2250 }, (_, i) => ({ id: `x${i}` })));
                fake.completion = buildCompletionRecord({
                    plannedTopics: 4, completedTopics: 3, limitSatisfied: false,
                    terminationReason: TERMINATION_REASON.RETRY_BUDGET_EXHAUSTED,
                });
                return [];
            },
        };
        const cap = captureSidecars();
        const result = await harvestSingle('semanticscholar', { limit: 4000, _adapter: fake });
        cap.spy.mockRestore();
        const sidecar = cap.seen[cap.seen.length - 1];

        expect(sidecar.yield).toBe(2250);
        expect(sidecar.status).not.toBe('success');
        expect(sidecar.status).toBe('partial');
        expect(sidecar.had_adapter_error).toBe(false);
        expect(sidecar.floor_violated).toBe(false);
        expect(sidecar.completion_status).toBe(COMPLETION_STATUS.INCOMPLETE);
        expect(result.error).toBeTruthy();
        expect(shardNDJSON).not.toHaveBeenCalled();
    });

    it('bounded WAIT-BUDGET exhaustion mid-walk -> incomplete + exit 1 (real adapter, real arbiter)', async () => {
        // Each topic costs one full recovered ladder (2000+8000 = 10000ms charged) via
        // 500,500,200. After enough topics the run-scoped budget is spent, and the next
        // 5xx is refused rather than slept -> RETRY_BUDGET_EXHAUSTED.
        const perTopicCharge = 10000;
        const topics = Array.from({ length: Math.ceil(TOTAL_RETRY_BUDGET_MS / perTopicCharge) + 4 }, (_, i) => `topic${i}`);
        const adapter = fastAdapter();
        const seen: Record<string, number> = {};
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: any) => {
            const t = topicOf(url);
            seen[t] = (seen[t] || 0) + 1;
            return (seen[t] <= 2 ? bad(500) : ok(rows(t, 5))) as any;
        });

        let caught: any;
        try {
            await adapter.fetch({ limit: 100000, topics });
        } catch (e) { caught = e; }

        expect(caught).toBeInstanceOf(FetchError);
        expect(caught.meta.terminal).toBe(TERMINAL.RETRY_BUDGET_EXHAUSTED);
        expect(adapter.completion.completion_status).toBe(COMPLETION_STATUS.INCOMPLETE);
        expect(adapter.completion.termination_reason).toBe(TERMINATION_REASON.RETRY_BUDGET_EXHAUSTED);
        expect(adapter.completion.completed_topics).toBeGreaterThan(0);
        expect(adapter.completion.completed_topics).toBeLessThan(topics.length);
    });
});
