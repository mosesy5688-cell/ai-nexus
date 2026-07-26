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
// THIS FILE pins the NON-REGRESSION half: that the healthy 200 path, the genuine
// zero, and the pre-existing 403/429/503 ownership by BaseAdapter.handleRateLimit
// are all UNCHANGED by the repair. The failure half lives in
// harvest-s2-error-propagation.test.ts. Split to stay under the CES 250-line
// ceiling. NOTE: nothing here asserts anything about whether the real Semantic
// Scholar service has recovered; that remains unverified.

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
describe('S2 adapter -- healthy behaviour and the rate-limit taxonomy are UNCHANGED', () => {
    let adapter: any;

    beforeEach(() => {
        adapter = fastAdapter();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ---- TEST 10: healthy behaviour unchanged ----------------------------
    it('10. healthy 200s across every topic -> resolves, no throw, and the walk is complete', async () => {
        const f = vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: any) => {
            const t = String(url).match(/query=([^&]+)/)![1];
            return ok(page([`${t}-1`, `${t}-2`])) as any;
        });
        const out = await adapter.fetch({ limit: 8, topics: ['a', 'b'] });
        expect(out).toHaveLength(4);
        expect(f).toHaveBeenCalledTimes(2); // one page per topic, no retries
        expect(adapter.terminalMeta).toBeNull(); // nothing claims incompleteness
    });

    it('10b. a genuinely empty result (HTTP 200, well-formed, zero records) still resolves [] and stays success', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(ok({ total: 0, data: [] }) as any);
        const out = await adapter.fetch({ limit: 10, topics: ['a'] });
        expect(out).toEqual([]);
    });

    it('10b-i. the S2 natural end is TOKEN exhaustion, not a status code', async () => {
        // WHY THIS MATTERS. huggingface-adapter.js:249-253 treats HTTP 400 as the HF
        // API's natural pagination CEILING ("400 = HF API pagination ceiling
        // (~4000-5000 offset)") because that API is skip/offset-based. A blanket
        // non-2xx -> FetchError rule applied there would redden every healthy HF run.
        // The S2 bulk-search API is TOKEN-based: the pre-repair adapter ended a topic
        // on `token = data.token; if (!token) break;` (origin/main
        // semanticscholar-adapter.js:118-119) and had NO 400 branch at all. So for S2
        // the natural end is token exhaustion, and a 400 is a genuine bad request.
        // This test pins the natural end so the distinction cannot rot.
        let n = 0;
        const f = vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            n++;
            return ok(n === 1
                ? { total: 2, token: 'nextpage', data: [{ paperId: 'a', title: 'A' }] }
                : { total: 2, token: null, data: [{ paperId: 'b', title: 'B' }] }) as any;
        });
        const out = await adapter.fetch({ limit: 50, topics: ['a'] });
        expect(out).toHaveLength(2);
        expect(f).toHaveBeenCalledTimes(2); // page 2 carried token=null -> clean end
        expect(adapter.completion.completion_status).toBe('complete');
    });

    it('10b-ii. an S2 HTTP 400 IS a hard error (S2 has no 400 pagination ceiling)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(bad(400) as any);
        let caught: any;
        try {
            await adapter.fetch({ limit: 50, topics: ['a'] });
        } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(FetchError);
        expect(caught.meta.terminal).toBe(TERMINAL.NON_RETRYABLE_HTTP);
        expect(caught.meta.last_http_status).toBe(400);
        // ...and it is NOT retried: repetition cannot make a bad request valid.
        expect((adapter.fetchWithTimeout as any).mock.calls).toHaveLength(1);
    });

    it('10c. 403/429/503 remain the property of BaseAdapter.handleRateLimit (not the 5xx ladder)', async () => {
        expect(RETRYABLE_STATUSES).not.toContain(429);
        expect(RETRYABLE_STATUSES).not.toContain(403);
        expect(RETRYABLE_STATUSES).not.toContain(503);
        let n = 0;
        const rl = vi.spyOn(adapter, 'handleRateLimit').mockImplementation(async () => {
            n++;
            return n === 1; // wait+retry once, then decline
        });
        vi.spyOn(adapter, 'fetchWithTimeout')
            .mockResolvedValueOnce(bad(429) as any)
            .mockResolvedValue(ok(page(['z'])) as any);
        const out = await adapter.fetch({ limit: 1, topics: ['a'] });
        expect(rl).toHaveBeenCalled();
        expect(out).toHaveLength(1);
    });

    it('10d. the rate-limit breaker stays a NON-hard error but is no longer swallowed', async () => {
        vi.spyOn(adapter, 'handleRateLimit').mockRejectedValue(new RateLimitExceededError('semanticscholar', '6 attempts'));
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(bad(429) as any);
        let caught: any;
        try {
            await adapter.fetch({ limit: 100, topics: ['a', 'b'] });
        } catch (e) { caught = e; }
        // NOT converted to a FetchError (that would break the documented tolerance)...
        expect(caught).toBeInstanceOf(RateLimitExceededError);
        expect(caught).not.toBeInstanceOf(FetchError);
        // ...but the source is explicitly marked INCOMPLETE so the run cannot be
        // classified `success` (2026-07-26 partial-above-floor requirement).
        expect(adapter.terminalMeta).toMatchObject({
            source_complete: false, incomplete_reason: 'rate_limit_early_finish',
        });
    });
});
