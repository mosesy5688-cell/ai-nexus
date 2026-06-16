import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';
// @ts-ignore
import { FetchError } from '../../scripts/ingestion/adapters/base-adapter.js';
// @ts-ignore
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { ArxivRecoveryState, NO_PROGRESS_WINDOW, TOTAL_BUDGET_MS } from '../../scripts/ingestion/adapters/arxiv-recovery-state.js';

// D-68 amendment helpers (sidecar + transport-precedence tests share this file to
// honor the CES 250-line cap on harvest-arxiv-budget.test.ts).
const D68_PAGE = (id: string, token?: string) =>
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' +
    `<record><header><datestamp>2026-06-01</datestamp></header>` +
    `<metadata><arXiv><id>${id}</id><categories>cs.LG</categories>` +
    `<title>P ${id}</title><abstract>A ${id}.</abstract></arXiv></metadata></record>` +
    (token ? `<resumptionToken>${token}</resumptionToken>` : '') + '</ListRecords></OAI-PMH>';
const D68_FIRST_TOKEN = D68_PAGE('2606.00002', 'TOKEN-XYZ');
const D68_OK = (xml: string) => ({ ok: true, status: 200, text: async () => xml, headers: { get: () => null } });
const D68_HTTP = (status: number) => ({ ok: false, status, text: async () => '', headers: { get: () => null } });
const D68_NO_SLEEP = { sleep: async () => undefined, now: () => Date.now() };
const D68_ABORT = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };

// WO-3-A1 D-67 BLOCKER E (observation propagation only): a hard arXiv FetchError
// carrying structured recovery metadata (err.meta) must be RECORDED into the
// EXISTING terminal_meta sidecar field as a HARD FAILURE (not success/partial).
// Hermetic: a fake adapter throws the FetchError; no network, no real sleep. We
// read the fixed machine line `HARVEST_STATE <json>` that emitTerminalState
// ALWAYS prints (it cannot fail the harvest), and assert the terminal_meta fields.

function captureHarvestState(logSpy: any): any | null {
    for (const call of logSpy.mock.calls) {
        const line = String(call[0] ?? '');
        if (line.startsWith('HARVEST_STATE ')) {
            return JSON.parse(line.slice('HARVEST_STATE '.length));
        }
    }
    return null;
}

describe('WO-3-A1 D-67 BLOCKER E — FetchError recovery meta reaches the sidecar', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    // TEST 13: FetchError recovery metadata (pages/retries/terminal/kind/yield)
    // reaches the terminal_meta sidecar, recorded as a HARD FAILURE.
    it('TEST13 FetchError.meta flows into terminal_meta sidecar; status=failed (hard failure)', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const err = new FetchError('arxiv', 'fetch', 'TOTAL_BUDGET_EXHAUSTED: 1200 accepted before failure');
        (err as any).meta = {
            terminal: 'TOTAL_BUDGET_EXHAUSTED',
            acceptedPages: 42,
            totalRetries: 5,
            uniqueIds: 1200,
            elapsedTransportMs: 6300000,
            tokenFingerprint: 'tok#deadbeef',
        };
        const fakeAdapter = {
            entityTypes: ['paper'],
            fetch: async () => { throw err; },
            normalize: (raw: any) => raw,
        };

        const result = await harvestSingle('arxiv', { limit: 5, skipBridge: true, _adapter: fakeAdapter });

        // Hard failure: result.error set (trips the exit gate), yield 0.
        expect(result.error).toBeTruthy();
        expect(result.count).toBe(0);

        const state = captureHarvestState(logSpy);
        expect(state).not.toBeNull();
        // Recorded as a HARD FAILURE, never success/partial/valid_zero.
        expect(state.status).toBe('failed');
        expect(state.had_adapter_error).toBe(true);
        // The structured recovery evidence is carried in terminal_meta.
        expect(state.terminal_meta).toMatchObject({
            terminal: 'TOTAL_BUDGET_EXHAUSTED',
            acceptedPages: 42,
            totalRetries: 5,
            uniqueIds: 1200,
            elapsedTransportMs: 6300000,
            tokenFingerprint: 'tok#deadbeef',
        });
    });

    it('abort FetchError.meta merges WITH timeout_kind=request_timeout in terminal_meta', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const err = new FetchError('arxiv', 'abort', 'PAGE_TIMEOUT_EXHAUSTED: 7 accepted before failure');
        (err as any).meta = { terminal: 'PAGE_TIMEOUT_EXHAUSTED', acceptedPages: 3, totalRetries: 2, uniqueIds: 7, elapsedTransportMs: 250000, tokenFingerprint: 'tok#abc' };
        const fakeAdapter = { entityTypes: ['paper'], fetch: async () => { throw err; }, normalize: (r: any) => r };

        const result = await harvestSingle('arxiv', { limit: 5, skipBridge: true, _adapter: fakeAdapter });
        expect(result.error).toBeTruthy();
        const state = captureHarvestState(logSpy);
        expect(state.status).toBe('timeout'); // abort -> request_timeout terminal
        expect(state.terminal_meta).toMatchObject({
            timeout_kind: 'request_timeout',
            terminal: 'PAGE_TIMEOUT_EXHAUSTED',
            acceptedPages: 3,
            totalRetries: 2,
        });
    });
});

describe('WO-3-A1 D-68 BLOCKER 1 — invalid page must not mutate recovery state (validate before commit)', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; vi.spyOn(adapter, 'delay').mockResolvedValue(undefined); });
    afterEach(() => { vi.restoreAllMocks(); });

    // DIRECT-ARBITER: a rejected TOKEN_CYCLE page leaves ZERO partial mutation.
    it('CYCLE-ZEROMUT acceptPage TOKEN_CYCLE rejection mutates NOTHING (pages/uids/fp-set/window/history/clock)', () => {
        const state = new ArxivRecoveryState({ now: () => 1000, sleep: async () => undefined });
        // Two genuinely-advancing accepted pages establish a pre-cycle baseline.
        expect(state.acceptPage({ newProductYield: 2, rawNewIds: 2, pageFingerprint: 'fpA', nextToken: 'tokA' })).toBeNull();
        state.beginToken('tokA');
        expect(state.acceptPage({ newProductYield: 3, rawNewIds: 3, pageFingerprint: 'fpB', nextToken: 'tokB' })).toBeNull();
        state.beginToken('tokB');
        const before = {
            pages: state.acceptedPages, uids: state.acceptedUniqueIds, fp: state.seenPageFingerprints.size,
            window: [...state.progressWindow], history: [...state.tokenHistory], last: state.lastProgressAt,
        };
        // A->B->A: nextToken 'tokA' already in history -> TOKEN_CYCLE, must reject pure.
        const terminal = state.acceptPage({ newProductYield: 9, rawNewIds: 9, pageFingerprint: 'fpA2', nextToken: 'tokA' });
        expect(terminal).toBe('TOKEN_CYCLE');
        // ZERO partial mutation: every arbiter field identical to the pre-cycle snapshot.
        expect(state.acceptedPages).toBe(before.pages);                  // pages NOT incremented
        expect(state.acceptedUniqueIds).toBe(before.uids);              // uids NOT added
        expect(state.seenPageFingerprints.size).toBe(before.fp);        // fpA2 NOT added
        expect(state.seenPageFingerprints.has('fpA2')).toBe(false);
        expect(state.progressWindow).toEqual(before.window);           // window unchanged
        expect(state.tokenHistory).toEqual(before.history);           // history unchanged
        expect(state.lastProgressAt).toBe(before.last);              // progress clock unchanged
        // snapshot()/terminalError carry the PRE-cycle acceptedPages (cycle excluded).
        expect(state.snapshot('TOKEN_CYCLE').accepted_pages).toBe(before.pages);
        expect(state.terminalError('TOKEN_CYCLE', 5).meta.acceptedPages).toBe(before.pages);
    });

    // DIRECT-ARBITER: a rejected NO_PROGRESS stall page is also pure (no window leak).
    it('NOPROG-ZEROMUT acceptPage NO_PROGRESS rejection mutates NOTHING (window/pages/history unchanged)', () => {
        const state = new ArxivRecoveryState({ now: () => 1, sleep: async () => undefined });
        // Seed 'dup' (fresh once -> progress=1), then commit REPLAYED 'dup' pages
        // (progress=0) so the committed window's trailing NO_PROGRESS_WINDOW-1 entries
        // are 0 -- one below dry-full. Tokens distinct + != current -> only NO_PROGRESS.
        expect(state.acceptPage({ newProductYield: 0, rawNewIds: 0, pageFingerprint: 'dup', nextToken: 's0' })).toBeNull();
        for (let i = 0; i < NO_PROGRESS_WINDOW - 1; i++) {
            state.beginToken(`s${i}`);
            expect(state.acceptPage({ newProductYield: 0, rawNewIds: 0, pageFingerprint: 'dup', nextToken: `s${i + 1}` })).toBeNull();
        }
        const bPages = state.acceptedPages, bWindow = [...state.progressWindow], bHistory = [...state.tokenHistory];
        const terminal = state.acceptPage({ newProductYield: 0, rawNewIds: 0, pageFingerprint: 'dup', nextToken: 'tN' });
        expect(terminal).toBe('NO_PROGRESS');
        expect(state.acceptedPages).toBe(bPages);      // stall page NOT counted
        expect(state.progressWindow).toEqual(bWindow);  // NO extra 0 pushed
        expect(state.tokenHistory).toEqual(bHistory);   // 'tN' NOT pushed
    });

    // ADAPTER-LEVEL: cycle page excluded from terminal_meta.acceptedPages + never enriched.
    it('CYCLE-META terminal_meta.acceptedPages EXCLUDES the cycle page; cycle page never enriched/committed', async () => {
        const enrichSpy = vi.spyOn(adapter, 'enrichBatch');
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken=tokenA')) return D68_OK(D68_PAGE('id.B', 'tokenB')) as any;
            if (url.includes('resumptionToken=tokenB')) return D68_OK(D68_PAGE('id.A2', 'tokenA')) as any; // cycle
            return D68_OK(D68_PAGE('id.first', 'tokenA')) as any;
        });
        let caught: any = null;
        try { await adapter.fetchOAI({ limit: 1000, from: '2026-01-01' }, D68_NO_SLEEP); } catch (e) { caught = e; }
        expect(caught?.meta?.terminal).toBe('TOKEN_CYCLE');
        expect(caught.meta.acceptedPages).toBe(2); // id.first + id.B; cycle page id.A2 excluded
        const enriched = enrichSpy.mock.calls.map((c: any[]) => (c[0] as any[]).map((p: any) => p.arxiv_id));
        expect(enriched).toEqual([['id.first'], ['id.B']]); // id.A2 never committed/enriched
    });
});

describe('WO-3-A1 D-68 BLOCKER 2 — budget-exhausted beats page-timeout (terminal precedence)', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; vi.spyOn(adapter, 'delay').mockResolvedValue(undefined); });
    afterEach(() => { vi.restoreAllMocks(); });

    // CASE (i): remaining budget < 120s; the tokened request aborts AT the clipped
    // timeout; endSpan consumes the remainder -> TOTAL_BUDGET_EXHAUSTED (not PAGE_TIMEOUT).
    it('BUDGET-i clipped-timeout abort consuming the remainder -> TOTAL_BUDGET_EXHAUSTED (not PAGE_TIMEOUT)', async () => {
        let t = 0; const clock = { now: () => t, sleep: async () => undefined };
        const timeouts: number[] = [];
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, timeoutMs: number) => {
            timeouts.push(timeoutMs);
            if (url.includes('resumptionToken')) { t += timeoutMs; throw D68_ABORT(); } // runs full clipped timeout then aborts
            t += (TOTAL_BUDGET_MS - 50000); // page 1 leaves ~50000ms remaining
            return D68_OK(D68_FIRST_TOKEN) as any;
        });
        await expect(adapter.fetchOAI({ limit: 100000, from: '2026-01-01' }, clock))
            .rejects.toMatchObject({ name: 'FetchError', detail: expect.stringContaining('TOTAL_BUDGET_EXHAUSTED') });
        expect(timeouts[1]).toBe(50000); // tokened request was clipped to remaining budget (< 120000)
    });

    // CASE (ii): AMPLE budget; three full 120s same-token aborts (attempts exhausted,
    // budget remaining) -> PAGE_TIMEOUT_EXHAUSTED.
    it('BUDGET-ii three full 120s same-token aborts with budget remaining -> PAGE_TIMEOUT_EXHAUSTED (not TOTAL_BUDGET)', async () => {
        let t = 0; const clock = { now: () => t, sleep: async () => undefined }; // backoff zeroed
        const tokenTimeouts: number[] = [];
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, timeoutMs: number) => {
            if (url.includes('resumptionToken')) { tokenTimeouts.push(timeoutMs); t += 120000; throw D68_ABORT(); }
            t += 3000; return D68_OK(D68_FIRST_TOKEN) as any;
        });
        await expect(adapter.fetchOAI({ limit: 100000, from: '2026-01-01' }, clock))
            .rejects.toMatchObject({ name: 'FetchError', kind: 'abort', detail: expect.stringContaining('PAGE_TIMEOUT_EXHAUSTED') });
        expect(tokenTimeouts).toEqual([120000, 120000, 120000]); // attempts, not budget, was the limit
    });

    // A retryable wait that cannot FIT the remaining budget -> TOTAL_BUDGET_EXHAUSTED
    // (not RATE_LIMIT/PAGE_TIMEOUT): the two terminals are never conflated.
    it('BUDGET-precedence a backoff/Retry-After wait that cannot fit budget -> TOTAL_BUDGET_EXHAUSTED', async () => {
        let t = 0; const clock = { now: () => t, sleep: async () => undefined };
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken')) return D68_HTTP(503) as any; // retryable, but wait can't fit
            t += (TOTAL_BUDGET_MS - 5000); // leave 5000ms < 15000ms first backoff -> wait refused
            return D68_OK(D68_FIRST_TOKEN) as any;
        });
        await expect(adapter.fetchOAI({ limit: 100000, from: '2026-01-01' }, clock))
            .rejects.toMatchObject({ detail: expect.stringContaining('TOTAL_BUDGET_EXHAUSTED') });
    });
});
