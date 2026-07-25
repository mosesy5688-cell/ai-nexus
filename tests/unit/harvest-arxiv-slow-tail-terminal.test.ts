import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';
// @ts-ignore
import { ArxivRecoveryState } from '../../scripts/ingestion/adapters/arxiv-recovery-state.js';
// @ts-ignore
import { ATTEMPT_TIMEOUTS_MS, TOKEN_BACKOFF_MS, TOTAL_BUDGET_MS, WORST_CASE_TOKEN_MS, RECOVERY_ENVELOPE_VERSION, ADMISSION_DEADLINE_MS } from '../../scripts/ingestion/adapters/arxiv-recovery-envelope.js';
// @ts-ignore
import { createRunScope } from '../../scripts/ingestion/adapters/arxiv-run-admission.js';

// 2026-07-25 arXiv P0 — matrix cases D (exhaustion fail-loud), G (budget + outer
// deadlines), H (downstream conclusion gates) + the terminal-metadata contract.
// Companion: harvest-arxiv-slow-tail-envelope.test.ts (A/B/C/E/F). Fully hermetic.

const PAGE = (id: string, token?: string) =>
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' +
    '<record><header><datestamp>2026-07-01</datestamp></header>' +
    `<metadata><arXiv><id>${id}</id><categories>cs.LG</categories>` +
    `<title>P ${id}</title><abstract>A ${id}.</abstract></arXiv></metadata></record>` +
    (token ? `<resumptionToken>${token}</resumptionToken>` : '') + '</ListRecords></OAI-PMH>';
const OK = (xml: string) => ({ ok: true, status: 200, text: async () => xml, headers: { get: () => null } });
const HTTP = (status: number) => ({ ok: false, status, text: async () => '', headers: { get: () => null } });
const ABORT = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
const DEEP_TOKEN = 'TOK-DEEP-867-RECORDS-IN';

function seam() {
    let t = 0;
    const sleeps: number[] = [];
    return {
        sleeps, now: () => t, tick: (ms: number) => { t += ms; },
        sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    };
}

function captureHarvestState(logSpy: any): any | null {
    for (const call of logSpy.mock.calls) {
        const line = String(call[0] ?? '');
        if (line.startsWith('HARVEST_STATE ')) return JSON.parse(line.slice('HARVEST_STATE '.length));
    }
    return null;
}

describe('arXiv P0 slow-tail — D exhaustion fails loud, partial never persisted', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; });
    afterEach(() => { vi.restoreAllMocks(); });

    // D — three eligible failures on ONE token: fail-loud terminal, the failed page is
    // never handed downstream, and the metadata leaks no reusable continuation token.
    it('D three eligible failures -> PAGE_TIMEOUT_EXHAUSTED fail-loud; failed page never committed or checkpointed', async () => {
        const s = seam();
        const batches: string[][] = [];
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, ms: number) => {
            if (url.includes('resumptionToken')) { s.tick(ms); throw ABORT(); }
            s.tick(3000); return OK(PAGE('d.1', DEEP_TOKEN)) as any;
        });
        let err: any = null;
        try {
            await adapter.fetchOAI({
                limit: 100000, from: '2026-07-01',
                onBatch: async (b: any[]) => { batches.push(b.map((p) => p.arxiv_id)); },
            }, s);
        } catch (e) { err = e; }
        // Fail-loud, non-zero terminal status (harvest-single exits 1 on result.error).
        expect(err?.name).toBe('FetchError');
        expect(err.kind).toBe('abort');
        expect(err.meta.terminal).toBe('PAGE_TIMEOUT_EXHAUSTED');
        // The failed token window produced NO completed page: only the pre-failure page.
        expect(batches).toEqual([['d.1']]);
        expect(err.meta.acceptedPages).toBe(1);
        // No durable/reusable continuation checkpoint: the raw token bytes never appear.
        expect(JSON.stringify(err.meta)).not.toContain(DEEP_TOKEN);
        expect(err.meta.tokenFingerprint).toMatch(/^tok#[0-9a-f]+$/);
        // Never converted into success/soft-success/degraded Academic authority.
        expect(JSON.stringify(err.meta)).not.toMatch(/success|degraded|authority|publishable/i);
    });

    // D (chokepoint half) — the same fail-loud terminal reaches harvest-single as a HARD
    // failure with result.error set, status timeout, yield 0: merge/upload cannot proceed.
    it('D2 exhaustion reaches harvest-single as a hard failure (result.error, status=timeout, never valid_zero)', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        // The REAL arbiter builds the terminal error (not a hand-written stand-in).
        const st = new ArxivRecoveryState(seam());
        st.beginToken(DEEP_TOKEN); st.recordAttemptFailure('abort');
        const realErr = st.terminalError('PAGE_TIMEOUT_EXHAUSTED', 867);
        const fake = { entityTypes: ['paper'], fetch: async () => { throw realErr; }, normalize: (r: any) => r };
        const result = await harvestSingle('arxiv', { limit: 5, skipBridge: true, _adapter: fake });
        expect(result.error).toBeTruthy();
        expect(result.count).toBe(0);
        const state = captureHarvestState(logSpy);
        expect(state.status).toBe('timeout');           // never success / partial / valid_zero
        expect(state.had_adapter_error).toBe(true);
        expect(state.terminal_meta.terminal).toBe('PAGE_TIMEOUT_EXHAUSTED');
        expect(state.terminal_meta.recovery_envelope_version).toBe(RECOVERY_ENVELOPE_VERSION);
        expect(state.terminal_meta.attempt_timeouts_ms).toEqual([...ATTEMPT_TIMEOUTS_MS]);
        expect(state.terminal_meta.attempt_backoffs_ms).toEqual([...TOKEN_BACKOFF_MS]);
    });

    // TERMINAL METADATA honesty: a LOCAL timeout has no HTTP status -> null, never invented.
    it('META local timeout carries last_error_kind=abort with last_http_status NULL (never invented)', () => {
        const st = new ArxivRecoveryState(seam());
        st.beginToken(DEEP_TOKEN);
        st.recordAttemptFailure('abort'); // AbortError: no HTTP response existed at all
        const meta = st.terminalError('PAGE_TIMEOUT_EXHAUSTED', 867).meta;
        expect(meta.last_error_kind).toBe('abort');
        expect(meta.last_http_status).toBeNull();
        expect(Object.prototype.hasOwnProperty.call(meta, 'last_http_status')).toBe(true);
        expect(meta.slow_tail_recovery_count).toBe(0); // attempts are NOT recoveries
        // A real HTTP status IS recorded when one genuinely exists.
        st.recordAttemptFailure('http', 503);
        const httpMeta = st.terminalError('RATE_LIMIT_EXHAUSTED', 12).meta;
        expect(httpMeta.last_error_kind).toBe('http');
        expect(httpMeta.last_http_status).toBe(503);
    });


    // slow_tail_recovery_count counts COMPLETED recoveries only, and resets its
    // per-token slow-tail flag when the token advances.
    it('META slow_tail_recovery_count counts completed recoveries, not attempts', () => {
        const st = new ArxivRecoveryState(seam());
        st.beginToken('T1'); st.recordAttemptFailure('abort');
        expect(st.slowTailRecoveries).toBe(0);              // a failed attempt is not a recovery
        st.beginToken('T1');                                 // retry the SAME token
        expect(st.acceptPage({ newProductYield: 1, rawNewIds: 1, pageFingerprint: 'f1', nextToken: 'T2' })).toBeNull();
        expect(st.slowTailRecoveries).toBe(1);              // committed after a slow tail -> 1
        st.beginToken('T2');                                 // fresh token, first attempt
        expect(st.acceptPage({ newProductYield: 1, rawNewIds: 1, pageFingerprint: 'f2', nextToken: 'T3' })).toBeNull();
        expect(st.slowTailRecoveries).toBe(1);              // clean page does NOT increment
        expect(st.tokenSlowTail).toBe(false);               // flag cleared on token advance
    });

    // BF-4(b) — a retry driven by a NON-abort failure is a recovery, but NOT a
    // SLOW-TAIL recovery. Without this, dropping `&& tokenSlowTail` stayed green.
    it('META a non-abort (HTTP 503) retry that commits does NOT increment slow_tail_recovery_count', () => {
        const st = new ArxivRecoveryState(seam());
        st.beginToken('T5'); st.recordAttemptFailure('http', 503); // transient HTTP, not a stall
        st.beginToken('T5');                                        // retry the SAME token
        expect(st.acceptPage({ newProductYield: 1, rawNewIds: 1, pageFingerprint: 'f5', nextToken: 'T6' })).toBeNull();
        expect(st.tokenAttempts).toBe(2);        // it WAS a second-attempt commit...
        expect(st.slowTailRecoveries).toBe(0);   // ...but not a SLOW-TAIL one
        expect(st.terminalError('OAI_ERROR', 3).meta.slow_tail_recovery_count).toBe(0);
    });
});

describe('arXiv P0 slow-tail — G budget enforced, outer deadlines intact', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; });
    afterEach(() => { vi.restoreAllMocks(); });

    // G — the ACTIVE-TRANSPORT budget was NOT raised by the widening, and the widened
    // worst case for one token still fits inside it and inside the outer job deadlines.
    it('G the 6300000ms budget is unchanged and bounds the widened worst case (18min per token)', () => {
        expect(TOTAL_BUDGET_MS).toBe(6300000);              // NOT raised by the widening
        expect(WORST_CASE_TOKEN_MS).toBe(1080000);          // 120+60+300+300+300 s
        expect(WORST_CASE_TOKEN_MS).toBeLessThan(TOTAL_BUDGET_MS);
        expect(TOTAL_BUDGET_MS).toBeLessThan(180 * 60 * 1000); // 105min < 180min arXiv step
        expect(TOTAL_BUDGET_MS).toBeLessThan(300 * 60 * 1000); // 105min < 300min Academic job
        // Every backoff is charged to the SAME budget as the requests (no free waiting).
        const st = new ArxivRecoveryState({ now: () => 0, sleep: async () => undefined });
        st.beginToken('TB');
        return st.executeRetryWait().then((ok: boolean) => {
            expect(ok).toBe(true);
            expect(st.transportActiveMs).toBe(TOKEN_BACKOFF_MS[0]);
            expect(st.remainingTransportBudget()).toBe(TOTAL_BUDGET_MS - TOKEN_BACKOFF_MS[0]);
        });
    });

    // NBF-2 — D-68 terminal precedence for a NON-RETRYABLE HTTP status. The existing
    // D-68 suite only exercises retryable statuses, so the http branch's leading budget
    // check could be short-circuited away unnoticed: budget exhaustion then surfaced as
    // FETCH_ERROR/kind=fetch and the sidecar recorded a transport error, not a timeout.
    it('G5 non-retryable HTTP with the budget exhausted -> TOTAL_BUDGET_EXHAUSTED (not FETCH_ERROR)', async () => {
        const s = seam();
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, ms: number) => {
            if (url.includes('resumptionToken')) { s.tick(ms); return HTTP(404) as any; } // consumes the remainder
            s.tick(TOTAL_BUDGET_MS - 40000); return OK(PAGE('n.1', 'TOK-N')) as any;
        });
        let err: any = null;
        try { await adapter.fetchOAI({ limit: 100000, from: '2026-07-01' }, s); } catch (e) { err = e; }
        expect(err.meta.terminal).toBe('TOTAL_BUDGET_EXHAUSTED'); // budget beats the transport label
        expect(err.kind).toBe('abort');                           // -> sidecar status=timeout
        expect(err.meta.last_http_status).toBe(404);              // the observed status stays honest
    });

    // Anti-vacuity for G5: with budget REMAINING the same 404 is a genuine FETCH_ERROR.
    it('G5b the same non-retryable HTTP with budget remaining is still FETCH_ERROR', async () => {
        const s = seam();
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken')) { s.tick(1000); return HTTP(404) as any; }
            s.tick(1000); return OK(PAGE('n.1', 'TOK-N')) as any;
        });
        let err: any = null;
        try { await adapter.fetchOAI({ limit: 100000, from: '2026-07-01' }, s); } catch (e) { err = e; }
        expect(err.meta.terminal).toBe('FETCH_ERROR');
        expect(err.kind).toBe('fetch');
    });

    // G — exhaustion STOPS the walk: no further request is issued once the budget is gone.
    it('G2 budget exhaustion prevents any further request and clips the attempt window', async () => {
        const s = seam();
        const timeouts: number[] = [];
        let calls = 0;
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, ms: number) => {
            timeouts.push(ms); calls++;
            if (url.includes('resumptionToken')) { s.tick(ms); throw ABORT(); } // consumes the remainder
            s.tick(TOTAL_BUDGET_MS - 40000); return OK(PAGE('g.1', 'TOK-G')) as any; // 40s left
        });
        await expect(adapter.fetchOAI({ limit: 100000, from: '2026-07-01' }, s))
            .rejects.toMatchObject({ name: 'FetchError', detail: expect.stringContaining('TOTAL_BUDGET_EXHAUSTED') });
        expect(timeouts[1]).toBe(40000); // attempt window CLIPPED to remaining budget, not 120000
        expect(calls).toBe(2);           // exhausted -> no third request, no backoff attempted
        expect(s.sleeps).toEqual([]);
    });

    // BF-4(a) — REFUSED-DUE-TO-BUDGET must be a real refusal, not a wait that
    // happens to end at the same terminal. Deleting the guard used to stay green
    // because both routes land on TOTAL_BUDGET_EXHAUSTED; this separates them.
    it('G4 a retry wait that cannot fit the remainder sleeps NOTHING and charges NOTHING', async () => {
        const s = seam();
        const st = new ArxivRecoveryState(s);
        st.beginToken('TOK-REFUSE');
        st.startSpan(); s.tick(TOTAL_BUDGET_MS - 5000); st.endSpan(); // 5000ms left < 60000ms backoff
        const chargedBefore = st.transportActiveMs;
        const ok = await st.executeRetryWait();
        expect(ok).toBe(false);                                   // refused
        expect(s.sleeps).toEqual([]);                             // nothing was slept
        expect(st.transportActiveMs).toBe(chargedBefore);         // nothing was charged
        expect(st.totalRetries).toBe(0);                          // not counted as a retry
        expect(st.remainingTransportBudget()).toBe(5000);         // ceiling NOT breached
        // A wait that DOES fit still executes and is charged (anti-vacuity).
        const st2 = new ArxivRecoveryState(seam());
        st2.beginToken('TOK-FITS');
        expect(await st2.executeRetryWait()).toBe(true);
        expect(st2.transportActiveMs).toBe(TOKEN_BACKOFF_MS[0]);
    });
});
