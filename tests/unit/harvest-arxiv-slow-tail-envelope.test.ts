import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { ArxivRecoveryState } from '../../scripts/ingestion/adapters/arxiv-recovery-state.js';
// @ts-ignore
import { ATTEMPT_TIMEOUTS_MS, TOKEN_BACKOFF_MS, MAX_REQUESTS_PER_TOKEN } from '../../scripts/ingestion/adapters/arxiv-recovery-envelope.js';

// 2026-07-25 arXiv P0 — slow-tail recovery envelope (attempt windows 120/300/300s,
// backoffs 60/300s, 3 requests per UNCHANGED continuation token, budget NOT raised).
// Matrix cases A/B/C/E/F; D/G/H live in harvest-arxiv-slow-tail-terminal.test.ts.
// Clock + sleep are INJECTED: nothing waits in real time and nothing touches the network.

const PAGE = (id: string, token?: string) =>
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' +
    '<record><header><datestamp>2026-07-01</datestamp></header>' +
    `<metadata><arXiv><id>${id}</id><categories>cs.LG</categories>` +
    `<title>P ${id}</title><abstract>A ${id}.</abstract></arXiv></metadata></record>` +
    (token ? `<resumptionToken>${token}</resumptionToken>` : '') + '</ListRecords></OAI-PMH>';
const OAI_STOP = '<?xml version="1.0"?><OAI-PMH><error code="badArgument">stop</error></OAI-PMH>';
const OK = (xml: string) => ({ ok: true, status: 200, text: async () => xml, headers: { get: () => null } });
const HTTP = (status: number) => ({ ok: false, status, text: async () => '', headers: { get: () => null } });
const ABORT = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };

// The ONE injected time seam. `sleeps` records arbiter-owned backoff ONLY (the
// adapter's pacing delay() is mocked separately), so "performs no backoff" is exact.
function seam() {
    let t = 0;
    const sleeps: number[] = [];
    return {
        sleeps, now: () => t, tick: (ms: number) => { t += ms; },
        sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    };
}

describe('arXiv P0 slow-tail envelope — per-token attempt windows + backoffs', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; });
    afterEach(() => { vi.restoreAllMocks(); });

    // A — NORMAL FAST PAGE. Non-vacuous: asserts the EXACT timeout passed to every
    // transport call, that the arbiter's sleep seam was never used at all, and that
    // an attempt-1 commit does not inflate the recovery counter.
    it('A normal fast page: attempt 1 = 120000ms, ZERO backoff, recovery count not inflated', async () => {
        const s = seam();
        let n = 0;
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); }); // pacing: outside spans
        const spy = vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            n++; s.tick(3000); // a FAST page: 3s, far inside the attempt-1 window
            return OK(PAGE(`a.${n}`, n >= 3 ? undefined : `TA${n}`)) as any;
        });
        const out = await adapter.fetchOAI({ limit: 100, from: '2026-07-01' }, s);
        expect(out.map((p: any) => p.arxiv_id)).toEqual(['a.1', 'a.2', 'a.3']);
        expect(spy.mock.calls.map((c: any[]) => c[2])).toEqual([120000, 120000, 120000]);
        expect(ATTEMPT_TIMEOUTS_MS[0]).toBe(120000); // the fast path cost is UNCHANGED
        expect(s.sleeps).toEqual([]);                // no arbiter backoff on a healthy walk
        // Arbiter: a page committed on attempt 1 is NOT a slow-tail recovery.
        const st = new ArxivRecoveryState(seam());
        st.beginToken('TA1');
        expect(st.acceptPage({ newProductYield: 1, rawNewIds: 1, pageFingerprint: 'fp1', nextToken: 'TA2' })).toBeNull();
        expect(st.slowTailRecoveries).toBe(0);
    });

    // B — ONE SLOW-TAIL RECOVERY (the 2026-07-25 incident shape, now survivable).
    it('B one slow-tail recovery: 120s stall -> 60s backoff -> 300s retry on the SAME token bytes, committed once, counted once', async () => {
        const s = seam();
        const urls: string[] = [];
        let deep = 0;
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        const enrich = vi.spyOn(adapter, 'enrichBatch');
        const spy = vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, ms: number) => {
            urls.push(url);
            if (url.includes('resumptionToken=TOK-A')) {
                deep++;
                if (deep === 1) { s.tick(ms); throw ABORT(); } // stalls the FULL attempt-1 window
                s.tick(90000); return OK(PAGE('b.2', 'TOK-B')) as any; // clears inside the 300s window
            }
            if (url.includes('resumptionToken=TOK-B')) { s.tick(1000); return OK(OAI_STOP) as any; }
            s.tick(3000); return OK(PAGE('b.1', 'TOK-A')) as any;
        });
        let err: any = null;
        try { await adapter.fetchOAI({ limit: 100, from: '2026-07-01' }, s); } catch (e) { err = e; }
        // SAME continuation-token bytes on both attempts of the recovered window.
        const deepUrls = urls.filter((u) => u.includes('resumptionToken=TOK-A'));
        expect(deepUrls.length).toBe(2);
        expect(deepUrls[0]).toBe(deepUrls[1]);
        // 120s attempt 1 -> 60s arbiter backoff -> 300s attempt 2 (then a fresh token at 120s).
        expect(spy.mock.calls.map((c: any[]) => c[2])).toEqual([120000, 120000, 300000, 120000]);
        expect(s.sleeps).toEqual([TOKEN_BACKOFF_MS[0]]); // exactly one 60000ms wait
        // Committed EXACTLY once: the recovered page is enriched once, never twice.
        expect(enrich.mock.calls.map((c: any[]) => (c[0] as any[]).map((p: any) => p.arxiv_id)))
            .toEqual([['b.1'], ['b.2']]);
        // Counted EXACTLY once, on the single commit (surfaced by the LATER terminal).
        expect(err.meta.terminal).toBe('OAI_ERROR');
        expect(err.meta.slow_tail_recovery_count).toBe(1);
        expect(err.meta.totalRetries).toBe(1);
    });

    // C — THIRD-ATTEMPT RECOVERY. The window stays locked to one token for all three
    // requests, the backoffs are 60s then 300s, and a FOURTH request is impossible.
    it('C third-attempt recovery: aborts at 120s then 300s, backoffs 60s/300s, third request 300s, NO fourth request', async () => {
        const s = seam();
        const urls: string[] = [];
        let deep = 0;
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        const spy = vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, ms: number) => {
            urls.push(url);
            if (url.includes('resumptionToken=TOK-C')) {
                deep++;
                if (deep <= 2) { s.tick(ms); throw ABORT(); } // stalls the FULL window twice
                s.tick(5000); return OK(PAGE('c.2')) as any;  // clears on attempt 3 -> clean end
            }
            s.tick(3000); return OK(PAGE('c.1', 'TOK-C')) as any;
        });
        const out = await adapter.fetchOAI({ limit: 100, from: '2026-07-01' }, s);
        expect(out.map((p: any) => p.arxiv_id)).toEqual(['c.1', 'c.2']); // recovered, not failed
        const deepUrls = urls.filter((u) => u.includes('resumptionToken=TOK-C'));
        expect(deepUrls.length).toBe(MAX_REQUESTS_PER_TOKEN);          // exactly 3, no 4th
        expect(new Set(deepUrls).size).toBe(1);                        // same token/window locked
        expect(spy.mock.calls.map((c: any[]) => c[2])).toEqual([120000, 120000, 300000, 300000]);
        expect(s.sleeps).toEqual([...TOKEN_BACKOFF_MS]);               // 60000 then 300000
        expect(urls.length).toBe(4);                                   // 1 initial + 3 token requests
    });
});

describe('arXiv P0 slow-tail envelope — token immutability + single recovery arbiter', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; });
    afterEach(() => { vi.restoreAllMocks(); });

    // E — NO RESTART / NO REWIND. A failed deep token must never re-query the initial
    // window nor any token that already completed.
    it('E a failed deep token never re-queries the initial window or an already-completed token', async () => {
        const s = seam();
        const urls: string[] = [];
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, ms: number) => {
            urls.push(url);
            if (url.includes('resumptionToken=TOK-2')) { s.tick(ms); throw ABORT(); } // stalls to exhaustion
            if (url.includes('resumptionToken=TOK-1')) { s.tick(3000); return OK(PAGE('e.2', 'TOK-2')) as any; }
            s.tick(3000); return OK(PAGE('e.1', 'TOK-1')) as any;
        });
        await expect(adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, s))
            .rejects.toMatchObject({ name: 'FetchError', kind: 'abort' });
        expect(urls.filter((u) => u.includes('metadataPrefix')).length).toBe(1); // initial window queried ONCE
        expect(urls.filter((u) => u.includes('resumptionToken=TOK-1')).length).toBe(1); // completed token never re-walked
        expect(urls.filter((u) => u.includes('resumptionToken=TOK-2')).length).toBe(MAX_REQUESTS_PER_TOKEN);
        expect(urls.slice(1).every((u) => u.includes('resumptionToken='))).toBe(true); // no rewind to the window origin
    });

    // E(d) — the token and its partial state do NOT survive a run boundary.
    it('E2 token state never persists across runs: the next run starts from the initial window', async () => {
        const runOneUrls: string[] = [];
        const runTwoUrls: string[] = [];
        let target = runOneUrls;
        const s = seam();
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, ms: number) => {
            target.push(url);
            if (url.includes('resumptionToken')) { s.tick(ms); throw ABORT(); }
            s.tick(3000); return OK(PAGE('p.1', 'TOK-P')) as any;
        });
        await expect(adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, s)).rejects.toBeTruthy();
        target = runTwoUrls; // SAME adapter instance: a second run must not inherit TOK-P
        await expect(adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, seam())).rejects.toBeTruthy();
        expect(runOneUrls.length).toBeGreaterThan(1);
        expect(runTwoUrls[0]).toContain('metadataPrefix');
        expect(runTwoUrls[0]).not.toContain('resumptionToken');
    });

    // F — EXACTLY ONE RECOVERY ARBITER. Mixed eligible failure kinds for ONE token
    // still cap at 3 requests: the count cannot multiply through a second retry owner.
    it('F mixed abort/503 failures for one token still cap at 3 requests; no second retry owner exists', async () => {
        const s = seam();
        const urls: string[] = [];
        let deep = 0;
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        const rateLimit = vi.spyOn(adapter, 'handleRateLimit');
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, ms: number) => {
            urls.push(url);
            if (url.includes('resumptionToken=TOK-F')) {
                deep++;
                if (deep === 2) { s.tick(500); return HTTP(503) as any; } // transient HTTP, eligible
                s.tick(ms); throw ABORT();                                // slow-tail stall
            }
            s.tick(3000); return OK(PAGE('f.1', 'TOK-F')) as any;
        });
        await expect(adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, s))
            .rejects.toMatchObject({ name: 'FetchError', kind: 'abort' });
        expect(urls.filter((u) => u.includes('resumptionToken=TOK-F')).length).toBe(MAX_REQUESTS_PER_TOKEN);
        expect(s.sleeps).toEqual([...TOKEN_BACKOFF_MS]); // ONE backoff schedule, not two interleaved
        expect(rateLimit).not.toHaveBeenCalled();        // the legacy self-sleeping retry owner stays dead
    });

    // BF-4(b) end-to-end — a token recovered from a TRANSIENT HTTP failure is a
    // retry but NOT a slow-tail recovery: the counter must distinguish them through
    // the real adapter, not just in the arbiter.
    it('F3 a 503-then-success token counts a retry but NOT a slow-tail recovery', async () => {
        const s = seam();
        let deep = 0;
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken=TOK-H')) {
                deep++;
                if (deep === 1) { s.tick(500); return HTTP(503) as any; } // transient, NOT a stall
                s.tick(2000); return OK(PAGE('h.2', 'TOK-I')) as any;     // recovers on attempt 2
            }
            if (url.includes('resumptionToken=TOK-I')) { s.tick(500); return OK(OAI_STOP) as any; }
            s.tick(3000); return OK(PAGE('h.1', 'TOK-H')) as any;
        });
        let err: any = null;
        try { await adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, s); } catch (e) { err = e; }
        expect(s.sleeps).toEqual([TOKEN_BACKOFF_MS[0]]); // a real retry DID happen
        expect(err.meta.totalRetries).toBe(1);           // ...and is counted as a retry
        expect(err.meta.slow_tail_recovery_count).toBe(0); // but NOT as a slow-tail recovery
        expect(err.meta.last_error_kind).toBe('oai');
    });

    // F (structural) — the transport module owns no retry/sleep/attempt surface, and
    // the adapter's pagination path has exactly one loop. A nested retry owner reds here.
    it('F2 structural: the transport module owns no retry surface and the adapter has one pagination loop', () => {
        const client = fs.readFileSync('scripts/ingestion/adapters/arxiv-oai-client.js', 'utf8');
        expect(client).not.toMatch(/executeRetryWait|canRetryToken|handleRateLimit|recordAttemptFailure/);
        expect(client).not.toMatch(/setTimeout|while \(|for \(let attempt/);
        const adapterSrc = fs.readFileSync('scripts/ingestion/adapters/arxiv-adapter.js', 'utf8');
        expect(adapterSrc).not.toMatch(/this\.handleRateLimit\(/); // never INVOKED (comment mention only)
        expect((adapterSrc.match(/while \(/g) || []).length).toBe(1);
        // Retry advancement is owned SOLELY by the arbiter's per-token attempt counter.
        const arbiter = fs.readFileSync('scripts/ingestion/adapters/arxiv-recovery-state.js', 'utf8');
        expect((arbiter.match(/this\.tokenAttempts\+\+/g) || []).length).toBe(1);
        // The run-admission policy is reachable ONLY through the arbiter. Any other
        // runtime importer would be a second retry owner; the adapter must go through
        // state.requestRetry(), never call the decision or the ledger itself.
        const importers = fs.readdirSync('scripts/ingestion/adapters')
            .filter((f) => f.endsWith('.js') && fs.readFileSync(`scripts/ingestion/adapters/${f}`, 'utf8')
                .includes("from './arxiv-run-admission.js'"));
        expect(importers.sort()).toEqual(['arxiv-recovery-state.js', 'arxiv-terminal-meta.js']);
        expect(adapterSrc).not.toMatch(/retryDecision|admitThirdAttempt|admitWallClock|RUN_SCOPE/);
        expect((adapterSrc.match(/await state\.requestRetry\(/g) || []).length).toBe(3); // http/fetch/parse
        expect((adapterSrc.match(/state\.admitNextPage\(\)/g) || []).length).toBe(1); // NBF-1 loop gate
    });
});
