import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { ArxivRecoveryState } from '../../scripts/ingestion/adapters/arxiv-recovery-state.js';
// @ts-ignore
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { createRunScope } from '../../scripts/ingestion/adapters/arxiv-run-admission.js';
// @ts-ignore
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';
// @ts-ignore
import { ADMISSION_DEADLINE_MS } from '../../scripts/ingestion/adapters/arxiv-recovery-envelope.js';

// Founder-ruling evidence items 4/5/6: the two run-policy terminals must be
// AUDITABLE (admission numbers), must not masquerade as request timeouts, and must
// surface the raw Retry-After the cap overrode. Split out of the page-admission
// suite for the CES ceiling. Injected clock; no network, no real sleep.

function seam(t0 = 0) {
    let t = t0;
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

describe('Transport accounting is EXACT (pacing / enrichment / polite never charged)', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    // TEST2 catches only a mis-charged ENRICHMENT (it has to cross 6300000 to show).
    // This pins the number itself, so charging pacing (20000/page), polite spacing
    // (250/page) or enrichment (7000/page) to the transport budget all red here.
    it('EXACT elapsedTransportMs equals the injected transport time and nothing else', async () => {
        const adapter: any = new ArXivAdapter();
        process.env.ENABLE_AR5IV = 'false';
        const s = seam();
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); }); // 250 + 20000
        vi.spyOn(adapter, 'enrichBatch').mockImplementation(async () => { s.tick(7000); });
        const PAGE = (id: string, token?: string) =>
            '<?xml version="1.0"?><OAI-PMH><ListRecords>' +
            '<record><header><datestamp>2026-07-01</datestamp></header>' +
            `<metadata><arXiv><id>${id}</id><categories>cs.LG</categories>` +
            `<title>P ${id}</title><abstract>A ${id}.</abstract></arXiv></metadata></record>` +
            (token ? `<resumptionToken>${token}</resumptionToken>` : '') + '</ListRecords></OAI-PMH>';
        const OK = (xml: string) => ({ ok: true, status: 200, text: async () => xml, headers: { get: () => null } });
        let n = 0;
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            n++;
            if (n === 1) { s.tick(1000); return OK(PAGE('t.1', 'T1')) as any; }
            if (n === 2) { s.tick(2000); return OK(PAGE('t.2', 'T2')) as any; }
            s.tick(3000); return OK('<?xml version="1.0"?><OAI-PMH><error code="badArgument">x</error></OAI-PMH>') as any;
        });
        let err: any = null;
        try { await adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, s); } catch (e) { err = e; }
        expect(err.meta.terminal).toBe('OAI_ERROR');
        // 1000 + 2000 + 3000 of real transport. Pacing (2 x 20000), polite (3 x 250)
        // and enrichment (2 x 7000) all happened and NONE of them may appear here.
        expect(err.meta.elapsedTransportMs).toBe(6000);
        expect(s.now()).toBe(6000 + 2 * 20000 + 3 * 250 + 2 * 7000); // they DID occur
    });
});

describe('Items 4/5/6 - the run-policy terminals are auditable and honestly labelled', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    // P7: an absent value must stay an honest null, never a fabricated 0. A 0 elapsed
    // or a 0 HTTP status reads as "measured and it was zero", which is a lie.
    it('NULL-HONESTY absent admission evidence and absent HTTP status are null, never 0', () => {
        const corrupt = { thirdAttemptTokens: new Set(), startedAtMs: NaN }; // unusable run start
        const st = new ArxivRecoveryState({ now: () => 5000, sleep: async () => undefined, runScope: corrupt as any });
        expect(st.admit(1000)).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED'); // fails closed
        st.beginToken('TN');
        st.recordAttemptFailure('abort'); // a local timeout: there IS no HTTP status
        const meta = st.terminalError('RUN_WALL_CLOCK_BUDGET_EXHAUSTED', 7).meta;
        for (const k of ['run_elapsed_ms', 'projected_completion_ms', 'last_http_status', 'last_retry_after_raw_ms']) {
            expect(Object.prototype.hasOwnProperty.call(meta, k)).toBe(true); // present...
            expect(meta[k]).toBeNull();                                       // ...and honestly null
            expect(meta[k]).not.toBe(0);                                      // never fabricated
        }
        // The honest kind reclassification costs neither the specific reason nor exit code.
        expect(meta.terminal).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        expect(st.terminalError('RUN_WALL_CLOCK_BUDGET_EXHAUSTED', 7).kind).toBe('fetch');
        expect(meta.admission_deadline_ms).toBe(ADMISSION_DEADLINE_MS); // a real constant stays real
    });

    // Items 4/5/6 — the two Founder-ruled terminals must be AUDITABLE, must not
    // masquerade as request timeouts, and must surface the raw Retry-After they capped.
    it('META the run-policy terminals carry admission evidence, honest status, and the raw Retry-After', async () => {
        const s = seam();
        const scope = createRunScope();
        scope.startedAtMs = 0; s.tick(1000);
        const st = new ArxivRecoveryState({ ...s, runScope: scope });
        st.beginToken('TQ'); st.plannedWaitMs(6300 * 1000); // a 6300s header, capped to 300s
        st.admit(999);                                       // record an admission decision
        const meta = st.terminalError('RUN_WALL_CLOCK_BUDGET_EXHAUSTED', 42).meta;
        expect(meta.run_elapsed_ms).toBe(1000);              // elapsed IS the evidence
        expect(meta.projected_completion_ms).toBe(1999);
        expect(meta.admission_deadline_ms).toBe(ADMISSION_DEADLINE_MS);
        expect(meta.third_attempt_tokens_used).toBe(0);
        expect(meta.last_retry_after_raw_ms).toBe(6300000);  // raw, readable, never slept
        // Item 5: NOT kind 'abort', so harvest-single records status=failed and does
        // NOT stamp timeout_kind=request_timeout on a quota / wall-clock stop.
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        for (const t of ['RUN_WALL_CLOCK_BUDGET_EXHAUSTED', 'THIRD_ATTEMPT_QUOTA_EXHAUSTED']) {
            const err = st.terminalError(t, 42);
            expect(err.kind).toBe('fetch');
            const fake = { entityTypes: ['paper'], fetch: async () => { throw err; }, normalize: (r: any) => r };
            const res = await harvestSingle('arxiv', { limit: 5, skipBridge: true, _adapter: fake });
            expect(res.error).toBeTruthy();                  // still fail loud, non-zero
            const state = captureHarvestState(logSpy);
            expect(state.status).toBe('failed');             // not 'timeout'
            expect(state.terminal_meta.timeout_kind).toBeUndefined();
            expect(state.terminal_meta.run_elapsed_ms).toBe(1000);
            logSpy.mockClear();
        }
    });
});
