import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore -- JS ESM modules (no .d.ts); tested for their runtime contract.
import { SemanticScholarAdapter } from '../../scripts/ingestion/adapters/semanticscholar-adapter.js';
// @ts-ignore
import { FetchError, RateLimitExceededError } from '../../scripts/ingestion/adapters/base-adapter.js';
// @ts-ignore
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';
// @ts-ignore
import { MAX_REQUESTS_PER_PAGE, TERMINAL, FAILURE_KIND, RETRYABLE_STATUSES } from '../../scripts/ingestion/adapters/s2-retry-envelope.js';
// @ts-ignore
import { classifyBulkBody } from '../../scripts/ingestion/adapters/s2-bulk-search.js';
// @ts-ignore
import { evaluateFloorGate, DEFAULT_FLOORS } from '../../scripts/ingestion/harvest-floors.js';

// 2026-07-26 Factory 1/4 S2 incident (natural cron run 30189935455).
//
// Ecosystem FAILED while Academic/GitHub/HuggingFace succeeded and established
// their own R2 authority; `Merge & Upload` was SKIPPED and nothing was published.
// The defect was NOT the fail-closed chain -- it was that the Semantic Scholar
// adapter destroyed the cause. A throw from fetchWithTimeout() was `console.error`
// + `break`, an HTTP 500 was `console.warn` + `break`, and the adapter then
// returned []. harvest-single.js consequently emitted
//   { status: "floor_violation", had_adapter_error: false,
//     errors: ["floor violation: 0 < 300"] }
// -- a MISCLASSIFICATION manufactured by the swallow.
//
// These tests pin the repaired contract at the level the audit found untested:
// that the ADAPTER ITSELF surfaces a typed error, not merely that something
// downstream reddens. NOTE: nothing here asserts anything about whether the real
// Semantic Scholar service has recovered; that remains unverified and irrelevant
// to the contract.

/** A page body in the documented bulk-search shape. */
function page(ids: string[], token: string | null = null) {
    return { total: ids.length, token, data: ids.map((id) => ({ paperId: id, title: `T ${id}`, abstract: 'a' })) };
}

function ok(body: any) {
    return { ok: true, status: 200, statusText: 'OK', json: async () => body, headers: { get: () => null } };
}

function bad(status: number, body: any = {}) {
    return { ok: false, status, statusText: `E${status}`, json: async () => body, headers: { get: () => null } };
}

function abortError() {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
}

/** An adapter with zero real waiting: no ladder backoff, no 5s inter-page pacing. */
function fastAdapter() {
    const adapter: any = new SemanticScholarAdapter();
    adapter.retryDeps = { sleep: async () => undefined };
    vi.spyOn(adapter, 'delay').mockResolvedValue(undefined as any);
    return adapter;
}

/** Capture the `HARVEST_STATE <json>` machine line harvest-state.js always prints. */
function captureSidecars() {
    const seen: any[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
        const first = typeof args[0] === 'string' ? args[0] : '';
        if (first.startsWith('HARVEST_STATE ')) seen.push(JSON.parse(first.slice('HARVEST_STATE '.length)));
    });
    return { seen, spy };
}

describe('S2 adapter -- every transport/parse/exhaustion outcome surfaces a FetchError, never a clean []', () => {
    let adapter: any;

    beforeEach(() => {
        adapter = fastAdapter();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ---- TEST 1: four consecutive HTTP 500s -------------------------------
    it('1. four consecutive HTTP 500s -> FetchError with the status + topic, bounded to 4 requests', async () => {
        const f = vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(bad(500) as any);

        let caught: any;
        try {
            await adapter.fetch({ limit: 100, topics: ['machine learning'] });
        } catch (e) { caught = e; }

        expect(caught).toBeInstanceOf(FetchError);
        expect(caught.name).toBe('FetchError');
        expect(caught.source).toBe('semanticscholar');
        expect(caught.kind).toBe('fetch');
        // Bounded: the initial request plus MAX_REQUESTS_PER_PAGE-1 retries. NOT more.
        expect(f).toHaveBeenCalledTimes(MAX_REQUESTS_PER_PAGE);
        expect(caught.meta.terminal).toBe(TERMINAL.ATTEMPTS_EXHAUSTED);
        expect(caught.meta.failure_kind).toBe(FAILURE_KIND.HTTP_STATUS);
        expect(caught.meta.last_http_status).toBe(500);
        expect(caught.meta.failed_topic).toBe('machine learning');
        expect(caught.meta.source_complete).toBe(false);
    });

    it('1b. the retry repeats the EXACT same url -- never restarts, never skips the topic', async () => {
        const f = vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(bad(502) as any);
        await adapter.fetch({ limit: 100, topics: ['nlp'] }).catch(() => undefined);
        const urls = f.mock.calls.map((c: any[]) => c[0]);
        expect(urls).toHaveLength(MAX_REQUESTS_PER_PAGE);
        expect(new Set(urls).size).toBe(1);
        expect(urls[0]).toContain('query=nlp');
    });

    // ---- TEST 2: mixed success plus one failed topic ----------------------
    it('2. mixed success + ONE failed topic -> still throws; the partial yield is recorded, not published', async () => {
        const onBatch = vi.fn();
        let call = 0;
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: any) => {
            call++;
            if (String(url).includes('query=good')) return ok(page(['g' + call])) as any;
            return bad(500) as any;
        });

        let caught: any;
        try {
            await adapter.fetch({ limit: 40, topics: ['good', 'bad'], onBatch });
        } catch (e) { caught = e; }

        expect(caught).toBeInstanceOf(FetchError);
        // Work from the healthy topic was really done...
        expect(onBatch).toHaveBeenCalled();
        expect(caught.meta.accepted_unique_ids).toBeGreaterThan(0);
        // ...and the evidence names the topic that broke, plus states incompleteness.
        expect(caught.meta.failed_topic).toBe('bad');
        expect(caught.meta.source_complete).toBe(false);
    });

    // ---- TEST 3: request timeout ------------------------------------------
    it('3. request timeout (AbortError) -> FetchError kind="abort" (a TIMEOUT, not a generic fetch error)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockRejectedValue(abortError());
        let caught: any;
        try {
            await adapter.fetch({ limit: 100, topics: ['cv'] });
        } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(FetchError);
        expect(caught.kind).toBe('abort');
        expect(caught.meta.failure_kind).toBe(FAILURE_KIND.TIMEOUT);
        // HONESTY: no HTTP status line existed, so none is synthesized.
        expect(caught.meta.last_http_status).toBeNull();
    });

    it('3b. a network failure is a DISTINCT kind from a timeout (the two are never collapsed)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockRejectedValue(new TypeError('fetch failed'));
        let caught: any;
        try {
            await adapter.fetch({ limit: 100, topics: ['cv'] });
        } catch (e) { caught = e; }
        expect(caught.kind).toBe('fetch');
        expect(caught.meta.failure_kind).toBe(FAILURE_KIND.NETWORK);
    });

    // ---- TEST 4: malformed JSON / body ------------------------------------
    it('4. malformed JSON body -> FetchError kind="parse", and NOT retried', async () => {
        const f = vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue({
            ok: true, status: 200, statusText: 'OK',
            json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
            headers: { get: () => null },
        } as any);
        let caught: any;
        try {
            await adapter.fetch({ limit: 100, topics: ['t'] });
        } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(FetchError);
        expect(caught.kind).toBe('parse');
        expect(caught.meta.terminal).toBe(TERMINAL.NON_RETRYABLE_PARSE);
        expect(f).toHaveBeenCalledTimes(1); // deterministic failure; repetition is pointless.
    });

    it('4b. HTTP 200 whose body is missing its records array -> parse failure, NOT a quiet zero', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(ok({ total: 4321 }) as any);
        await expect(adapter.fetch({ limit: 100, topics: ['t'] }))
            .rejects.toMatchObject({ name: 'FetchError', kind: 'parse' });
    });

    it('4c. classifyBulkBody keeps the legitimate zero-result shape distinct from malformed', () => {
        expect(classifyBulkBody({ total: 0 })).toBe('empty');
        expect(classifyBulkBody({ total: 0, data: [] })).toBe('empty');
        expect(classifyBulkBody({ data: [{ paperId: 'x' }] })).toBe('ok');
        expect(classifyBulkBody({ total: 5 })).toBe('malformed');
        expect(classifyBulkBody({ data: 'nope' })).toBe('malformed');
        expect(classifyBulkBody(null)).toBe('malformed');
    });

    // ---- TEST 5: retry recovery to a healthy 200 -------------------------
    it('5. 500, 500, then 200 -> recovers on the SAME query and resolves normally', async () => {
        let n = 0;
        const f = vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            n++;
            return (n <= 2 ? bad(503 - 3) : ok(page(['a', 'b']))) as any; // 500 twice, then 200
        });
        const out = await adapter.fetch({ limit: 2, topics: ['ml'] });
        expect(Array.isArray(out)).toBe(true);
        expect(out).toHaveLength(2);
        expect(f).toHaveBeenCalledTimes(3);
        // Same url every time -- the recovery re-issued the query, it did not restart it.
        expect(new Set(f.mock.calls.map((c: any[]) => c[0])).size).toBe(1);
    });

    // ---- TEST 6: retry exhaustion (budget, not just attempts) -------------
    it('6. exhausted bounded WAIT BUDGET terminates loud (RETRY_BUDGET_EXHAUSTED), without a clipped wait', async () => {
        const slim: any = new SemanticScholarAdapter();
        vi.spyOn(slim, 'delay').mockResolvedValue(undefined as any);
        // A budget smaller than the first backoff: the arbiter must refuse rather than
        // sleep a partial wait and call it a retry.
        slim.retryDeps = { sleep: async () => undefined };
        const f = vi.spyOn(slim, 'fetchWithTimeout').mockResolvedValue(bad(500) as any);
        // Drain the budget by pre-charging the arbiter through a first full ladder.
        await slim.fetch({ limit: 10, topics: ['a'] }).catch(() => undefined);
        expect(f).toHaveBeenCalledTimes(MAX_REQUESTS_PER_PAGE);

        // And prove the budget branch itself: force it directly on the arbiter.
        const { S2RetryState } = await import('../../scripts/ingestion/adapters/s2-retry-state.js');
        const st: any = new S2RetryState({ sleep: async () => undefined });
        st.beginRequest('u');
        st.retryWaitMs = 1; // budget effectively spent below the next full backoff
        (st as any).remainingRetryBudgetMs = () => 1;
        expect(await st.requestRetry()).toBe(TERMINAL.RETRY_BUDGET_EXHAUSTED);
        expect(st.totalRetries).toBe(0); // nothing was slept, nothing was charged
    });
});
