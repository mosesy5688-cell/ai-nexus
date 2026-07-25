import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { ArxivRecoveryState } from '../../scripts/ingestion/adapters/arxiv-recovery-state.js';
// @ts-ignore
import { PROCESS_RUN_SCOPE, createRunScope } from '../../scripts/ingestion/adapters/arxiv-run-admission.js';
// @ts-ignore
import { ARXIV_STEP_TIMEOUT_MS, TERMINALIZATION_RESERVE_MS, ADMISSION_DEADLINE_MS, FORESEEABLE_TAIL_MS, FORESEEABLE_TAIL_WORST_MS, TOKEN_BACKOFF_MS, attemptTimeoutMs } from '../../scripts/ingestion/adapters/arxiv-recovery-envelope.js';

// NBF-1 (ordinary page requests are gated), NBF-3 (the production run-scope branch
// has a regression barrier) and the FORESEEABLE_TAIL_MS contribution to the gate.
// Every clock/sleep injected; nothing waits in real time.

const PAGE = (id: string, token?: string) =>
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' +
    '<record><header><datestamp>2026-07-01</datestamp></header>' +
    `<metadata><arXiv><id>${id}</id><categories>cs.LG</categories>` +
    `<title>P ${id}</title><abstract>A ${id}.</abstract></arXiv></metadata></record>` +
    (token ? `<resumptionToken>${token}</resumptionToken>` : '') + '</ListRecords></OAI-PMH>';
const OK = (xml: string) => ({ ok: true, status: 200, text: async () => xml, headers: { get: () => null } });

function seam(t0 = 0) {
    let t = t0;
    const sleeps: number[] = [];
    return {
        sleeps, now: () => t, tick: (ms: number) => { t += ms; },
        sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    };
}

/** A perfectly ordinary healthy page: 90s transport, 50s ar5iv, 20s pacing. */
function healthyWalk(adapter: any, s: ReturnType<typeof seam>, pages: number) {
    let n = 0;
    vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
    vi.spyOn(adapter, 'enrichBatch').mockImplementation(async () => { s.tick(50000); });
    return vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
        n++; s.tick(90000);
        return OK(PAGE(`h.${n}`, n >= pages ? undefined : `T${n}`)) as any;
    });
}

describe('NBF-1 — ordinary page requests are wall-clock admitted', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; });
    afterEach(() => { vi.restoreAllMocks(); });

    // THE REVIEWER'S EXACT SCENARIO. Anchored 100s before the admission line, then 12
    // ordinary healthy pages. Before NBF-1 this consulted the gate ZERO times and ran
    // 1,503,000ms (25min) past the 180-minute step, dying as an evidence-free runner
    // kill with the transport budget barely touched. It must now stop fail-loud.
    it('NBF1 a purely HEALTHY walk near the deadline terminates fail-loud instead of overrunning the step', async () => {
        const s = seam(ADMISSION_DEADLINE_MS - 100000); // 100s of admissible time left
        const scope = createRunScope();
        scope.startedAtMs = 0;
        const fetchSpy = healthyWalk(adapter, s, 12);
        let err: any = null;
        try { await adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, { ...s, runScope: scope }); } catch (e) { err = e; }
        // Fail loud, with the admission evidence that justifies the stop.
        expect(err?.name).toBe('FetchError');
        expect(err.meta.terminal).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        expect(err.meta.run_elapsed_ms).toBe(ADMISSION_DEADLINE_MS - 100000);
        expect(err.meta.projected_completion_ms).toBe(ADMISSION_DEADLINE_MS - 100000 + 120000 + FORESEEABLE_TAIL_WORST_MS);
        expect(err.meta.admission_deadline_ms).toBe(ADMISSION_DEADLINE_MS);
        // NOT ONE request was issued past the line, and the step was never overrun.
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(s.now()).toBeLessThan(ARXIV_STEP_TIMEOUT_MS);
        // The transport budget is untouched — proving the budget could never have
        // caught this; only the wall-clock gate can.
        expect(err.meta.elapsedTransportMs).toBe(0);
    });

    // The same walk with room completes all 12 pages: the gate adds no latency and
    // refuses nothing while there is genuinely time.
    it('NBF1 the identical healthy walk with ample time completes all 12 pages, never refused', async () => {
        const s = seam(0);
        const scope = createRunScope();
        scope.startedAtMs = 0;
        healthyWalk(adapter, s, 12);
        const out = await adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, { ...s, runScope: scope });
        expect(out.length).toBe(12);
        expect(s.sleeps).toEqual([]);                       // no backoff, no gate latency
        expect(s.now()).toBeLessThan(ADMISSION_DEADLINE_MS); // and it stayed inside the line
    });

    // Mid-walk stop: pages are admitted until the remaining time runs out, then the
    // walk halts with everything accepted so far intact and NO partial-success claim.
    it('NBF1 a walk that runs out of time mid-way stops at the last admissible page', async () => {
        // Room for a few pages only: each ordinary page costs 90000+50000+20000+250.
        const s = seam(ADMISSION_DEADLINE_MS - 700000);
        const scope = createRunScope();
        scope.startedAtMs = 0;
        const fetchSpy = healthyWalk(adapter, s, 50);
        let err: any = null;
        try { await adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, { ...s, runScope: scope }); } catch (e) { err = e; }
        expect(err.meta.terminal).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        // STRADDLES the pricing: each page costs 160250 of wall clock from 9800000.
        // Bound pricing (290250+reserve) admits while elapsed < 10209750 -> EXACTLY 3
        // pages. Floor pricing (190250) would admit 4; dropping the tail term, 4.
        expect(fetchSpy.mock.calls.length).toBe(3);
        expect(s.now()).toBeLessThan(ARXIV_STEP_TIMEOUT_MS);     // never past the step
        expect(err.meta.projected_completion_ms).toBeGreaterThan(ADMISSION_DEADLINE_MS);
    });

    // ITEM 1: the tail term must actually decide. Sized so the request window alone
    // WOULD fit and only the tail pushes it over — deleting the tail term from the
    // cost flips this case from refuse to admit.
    it('TAIL the foreseeable pacing/enrichment tail alone decides admit vs refuse', async () => {
        // Remaining is between (window + reserve) and (window + worst tail + reserve).
        const withoutTail = attemptTimeoutMs(1) + TERMINALIZATION_RESERVE_MS;    // 420000
        const withTail = withoutTail + FORESEEABLE_TAIL_WORST_MS;                // 590250
        const remaining = Math.floor((withoutTail + withTail) / 2);              // 505125
        const scope = createRunScope();
        scope.startedAtMs = 0;
        const st = new ArxivRecoveryState({ now: () => ARXIV_STEP_TIMEOUT_MS - remaining, sleep: async () => undefined, runScope: scope });
        // WITHOUT the tail term this cost is admitted...
        expect(st.admit(attemptTimeoutMs(1))).toBeNull();
        // ...and WITH it, the very same moment is refused. Only the tail differs.
        expect(st.admitNextPage()).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        expect(withTail - withoutTail).toBe(FORESEEABLE_TAIL_WORST_MS);
    });

    // THE BOUND, NOT THE FLOOR. Sized so that ONLY the 100000ms difference between the
    // expected tail (70250) and the bounded tail (170250) decides: a floor-priced gate
    // ADMITS here, a bound-priced gate REFUSES. Reverting the gate to the floor tail
    // therefore reds this test and nothing else can mask it.
    it('BOUND the gate prices the WORST tail, not the expected one', () => {
        const floorCost = attemptTimeoutMs(1) + FORESEEABLE_TAIL_MS + TERMINALIZATION_RESERVE_MS;  // 490250
        const boundCost = attemptTimeoutMs(1) + FORESEEABLE_TAIL_WORST_MS + TERMINALIZATION_RESERVE_MS; // 590250
        expect(boundCost - floorCost).toBe(100000); // exactly the ar5iv latency term
        const remaining = Math.floor((floorCost + boundCost) / 2); // 540250: fits the floor, not the bound
        const scope = createRunScope();
        scope.startedAtMs = 0;
        const st = new ArxivRecoveryState({ now: () => ARXIV_STEP_TIMEOUT_MS - remaining, sleep: async () => undefined, runScope: scope });
        // A gate that priced the EXPECTED tail would admit at this instant...
        expect(st.admit(attemptTimeoutMs(1) + FORESEEABLE_TAIL_MS)).toBeNull();
        // ...the real gate, pricing the BOUND, refuses.
        expect(st.admitNextPage()).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        // The RETRY path must price the same bound. Sized so ONLY the 100000ms tail
        // difference decides there too: a retry costs 60000 wait + 300000 attempt-2
        // window + tail + 300000 reserve, i.e. 730250 at the floor vs 830250 at the
        // bound, and 780000 remains — the floor would admit, the bound must refuse.
        const retryFloor = TOKEN_BACKOFF_MS[0] + attemptTimeoutMs(2) + FORESEEABLE_TAIL_MS + TERMINALIZATION_RESERVE_MS;
        const retryBound = TOKEN_BACKOFF_MS[0] + attemptTimeoutMs(2) + FORESEEABLE_TAIL_WORST_MS + TERMINALIZATION_RESERVE_MS;
        expect([retryFloor, retryBound]).toEqual([730250, 830250]);
        const st2 = new ArxivRecoveryState({ now: () => ARXIV_STEP_TIMEOUT_MS - 780000, sleep: async () => undefined, runScope: createRunScope() });
        st2.runScope.startedAtMs = 0;
        st2.beginToken('B1'); // attempt 1 failed; the proposed retry is attempt 2
        // A floor-priced retry cost WOULD be admitted at this instant...
        expect(st2.admit(TOKEN_BACKOFF_MS[0] + attemptTimeoutMs(2) + FORESEEABLE_TAIL_MS)).toBeNull();
        // ...and the real retry decision, pricing the bound, refuses.
        return st2.requestRetry().then((t: any) => {
            expect(t).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
            expect(st2.runScope.thirdAttemptTokens.size).toBe(0); // and spends no quota
        });
    });
});

describe('Item 3 — the wall-clock gate is checked BEFORE the third-attempt quota', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    // The quota is spent irrevocably, so a gate refusal must not burn the run's only
    // third-attempt slot on an action that never happens.
    it('ORDER a gate refusal at the third attempt does NOT consume the quota', async () => {
        const scope = createRunScope();
        scope.startedAtMs = 0;
        // beginToken runs TWICE, so the proposed retry is attempt 3: the wait is
        // attemptBackoffMs(2) = 300000, not 60000. Cost = 300000 wait + 300000
        // attempt-3 window + 170250 bounded tail + 300000 reserve = 1070250.
        const st = new ArxivRecoveryState({ now: () => ADMISSION_DEADLINE_MS - 100000, sleep: async () => undefined, runScope: scope });
        st.beginToken('TOK-ORDER'); st.beginToken('TOK-ORDER'); // now on attempt 2
        expect(await st.requestRetry()).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        expect(scope.thirdAttemptTokens.size).toBe(0);   // slot NOT spent
        expect(st.terminalError('RUN_WALL_CLOCK_BUDGET_EXHAUSTED', 5).meta.third_attempt_tokens_used).toBe(0);
        // With time available the very same state DOES consume it, so the slot is real.
        const scope2 = createRunScope();
        scope2.startedAtMs = 0;
        const st2 = new ArxivRecoveryState({ now: () => 0, sleep: async () => undefined, runScope: scope2 });
        st2.beginToken('TOK-ORDER'); st2.beginToken('TOK-ORDER');
        expect(await st2.requestRetry()).toBeNull();
        expect(scope2.thirdAttemptTokens.size).toBe(1);
    });
});

describe('NBF-3 — the PRODUCTION run-scope branch has a regression barrier', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    // The production leg: no deps at all (and the sleep-only shape the adapter builds)
    // must land on the shared PROCESS_RUN_SCOPE, or the per-RUN quota silently becomes
    // per-arbiter. No test exercised this branch before, so N1 shipped green.
    it('N1 two arbiters built the production way SHARE PROCESS_RUN_SCOPE', () => {
        const a = new ArxivRecoveryState();
        const b = new ArxivRecoveryState();
        expect(a.runScope).toBe(PROCESS_RUN_SCOPE);
        expect(b.runScope).toBe(PROCESS_RUN_SCOPE);
        expect(a.runScope).toBe(b.runScope);
        // The adapter's real construction shape is {sleep} only — still production.
        const c = new ArxivRecoveryState({ sleep: async () => undefined });
        expect(c.runScope).toBe(PROCESS_RUN_SCOPE);
        // The quota ledger is therefore genuinely shared between them.
        a.runScope.thirdAttemptTokens.add('__nbf3_probe__');
        expect(c.runScope.thirdAttemptTokens.has('__nbf3_probe__')).toBe(true);
        a.runScope.thirdAttemptTokens.delete('__nbf3_probe__');
        // An INJECTED clock is a distinct time domain and gets its own scope.
        expect(new ArxivRecoveryState({ now: () => 0 }).runScope).not.toBe(PROCESS_RUN_SCOPE);
        // ...unless the caller supplies one explicitly.
        const shared = createRunScope();
        expect(new ArxivRecoveryState({ now: () => 0, runScope: shared }).runScope).toBe(shared);
    });

    // Source-level pin of the ternary's FALSE branch: `deps.runScope || createRunScope()`
    // (dropping PROCESS_RUN_SCOPE) must not be able to ship silently.
    it('N1-SRC the run-scope default is pinned to PROCESS_RUN_SCOPE in source', () => {
        const src = fs.readFileSync('scripts/ingestion/adapters/arxiv-recovery-state.js', 'utf8');
        expect(src).toContain('this.runScope = deps.runScope || (deps.now ? createRunScope() : PROCESS_RUN_SCOPE);');
        expect(src).not.toMatch(/this\.runScope = deps\.runScope \|\| createRunScope\(\)/);
        // And the ledger really is module-scoped (one object per process, not per call).
        const adm = fs.readFileSync('scripts/ingestion/adapters/arxiv-run-admission.js', 'utf8');
        expect(adm).toContain('export const PROCESS_RUN_SCOPE = createRunScope();');
    });
});
