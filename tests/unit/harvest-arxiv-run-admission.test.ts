import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { ArxivRecoveryState } from '../../scripts/ingestion/adapters/arxiv-recovery-state.js';
// @ts-ignore
import { createRunScope, admitThirdAttempt, admitWallClock, effectiveRetryAfterMs } from '../../scripts/ingestion/adapters/arxiv-run-admission.js';
// @ts-ignore
import { parseRetryAfterMs } from '../../scripts/ingestion/adapters/arxiv-oai-client.js';
// @ts-ignore
import { ARXIV_STEP_TIMEOUT_MS, TERMINALIZATION_RESERVE_MS, TOKEN_BACKOFF_MS, MAX_RETRY_AFTER_MS } from '../../scripts/ingestion/adapters/arxiv-recovery-envelope.js';

// Founder ruling 2026-07-25 (BF-1 third-attempt quota + runtime wall-clock admission,
// BF-2 Retry-After cap). All clocks/sleeps injected; nothing waits in real time.

const PAGE = (id: string, token?: string) =>
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' +
    '<record><header><datestamp>2026-07-01</datestamp></header>' +
    `<metadata><arXiv><id>${id}</id><categories>cs.LG</categories>` +
    `<title>P ${id}</title><abstract>A ${id}.</abstract></arXiv></metadata></record>` +
    (token ? `<resumptionToken>${token}</resumptionToken>` : '') + '</ListRecords></OAI-PMH>';
const OK = (xml: string, hdr: Record<string, string> = {}) => ({
    ok: true, status: 200, text: async () => xml,
    headers: { get: (k: string) => hdr[k.toLowerCase()] ?? null },
});
const HTTP = (status: number, hdr: Record<string, string> = {}) => ({
    ok: false, status, text: async () => '',
    headers: { get: (k: string) => hdr[k.toLowerCase()] ?? null },
});
const ABORT = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };

function seam(t0 = 0) {
    let t = t0;
    const sleeps: number[] = [];
    return {
        sleeps, now: () => t, tick: (ms: number) => { t += ms; },
        sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    };
}

describe('BF-1A — third-attempt token quota (one token per run, never refunded)', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; });
    afterEach(() => { vi.restoreAllMocks(); });

    // Admitted for the FIRST token, then REFUSED for the second BEFORE any fetch —
    // and a SUCCESSFUL third attempt does not hand the slot back.
    it('QUOTA first token gets attempt 3; a second token is refused BEFORE fetching (success does not refund)', async () => {
        const s = seam();
        const urls: string[] = [];
        const n: Record<string, number> = { 'TOK-1': 0, 'TOK-2': 0 };
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, ms: number) => {
            urls.push(url);
            for (const tok of ['TOK-1', 'TOK-2']) {
                if (url.includes(`resumptionToken=${tok}`)) {
                    n[tok]++;
                    if (n[tok] <= 2) { s.tick(ms); throw ABORT(); }
                    s.tick(4000); return OK(PAGE('q.2', 'TOK-2')) as any; // TOK-1 recovers on 3
                }
            }
            s.tick(3000); return OK(PAGE('q.1', 'TOK-1')) as any;
        });
        let err: any = null;
        try { await adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, s); } catch (e) { err = e; }
        expect(n['TOK-1']).toBe(3);                 // first token spent the run's only slot
        expect(n['TOK-2']).toBe(2);                 // second token NEVER reached a third fetch
        expect(urls.filter((u) => u.includes('TOK-2')).length).toBe(2);
        expect(err.meta.terminal).toBe('THIRD_ATTEMPT_QUOTA_EXHAUSTED');
        expect(err.kind).toBe('fetch');             // fail loud, but NOT a request timeout
        expect(err.meta.slow_tail_recovery_count).toBe(1); // TOK-1's recovery did happen
    });

    // A FAILED third attempt is equally non-refundable.
    it('QUOTA a failed third attempt does not refund the slot either', () => {
        const scope = createRunScope();
        expect(admitThirdAttempt(scope, 'TOKEN-A')).toBe(true);
        // TOKEN-A's third attempt now fails; nothing gives the slot back.
        expect(admitThirdAttempt(scope, 'TOKEN-B')).toBe(false);
        expect(admitThirdAttempt(scope, 'TOKEN-C')).toBe(false);
        expect(scope.thirdAttemptTokens.size).toBe(1);
        // Re-admitting the SAME token is idempotent, never a second spend.
        expect(admitThirdAttempt(scope, 'TOKEN-A')).toBe(true);
        expect(scope.thirdAttemptTokens.size).toBe(1);
    });

    // The ledger is RUN-scoped, not arbiter-scoped: rebuilding the arbiter (loop
    // reconstruction / exception re-entry) must not hand the slot back.
    it('QUOTA cannot reset through arbiter re-initialisation or exception re-entry', async () => {
        const scope = createRunScope();
        const mk = () => new ArxivRecoveryState({ ...seam(), runScope: scope });
        const a = mk(); a.beginToken('A'); a.beginToken('A');   // A is on attempt 2
        expect(await a.requestRetry()).toBeNull();               // admits attempt 3, consumes
        const b = mk(); b.beginToken('B'); b.beginToken('B');   // brand-new arbiter, same run
        expect(await b.requestRetry()).toBe('THIRD_ATTEMPT_QUOTA_EXHAUSTED');
        const again = mk(); again.beginToken('A'); again.beginToken('A');
        expect(await again.requestRetry()).toBeNull();           // same token still holds it
        expect(scope.thirdAttemptTokens.size).toBe(1);
        // A FRESH run (new scope) starts with the quota available again.
        const fresh = new ArxivRecoveryState({ ...seam(), runScope: createRunScope() });
        fresh.beginToken('B'); fresh.beginToken('B');
        expect(await fresh.requestRetry()).toBeNull();
    });

    // Attempt 2 must never consume or be gated by the quota (only attempt 3 is).
    it('QUOTA attempt 2 is never gated by the third-attempt quota', async () => {
        const scope = createRunScope();
        scope.thirdAttemptTokens.add('SOMEONE-ELSE'); // quota already gone
        const st = new ArxivRecoveryState({ ...seam(), runScope: scope });
        st.beginToken('Z');                            // attempt 1 failed -> retry = attempt 2
        expect(await st.requestRetry()).toBeNull();
    });
});

describe('BF-1B — runtime wall-clock admission gate (terminalization reserve)', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; });
    afterEach(() => { vi.restoreAllMocks(); });

    // The decisive property for the RETRY path: when the proposed action's BOUNDED
    // cost cannot fit with the reserve intact, nothing sleeps and nothing is fetched.
    it('GATE insufficient remainder -> NO sleep, NO further fetch, non-zero terminal', async () => {
        // 802500ms left. An ordinary page costs 120000+170250+300000 reserve = 590250
        // (admitted twice, consuming 22500), so the RETRY is proposed with 780000 left.
        // A retry costs 60000 wait + 300000 attempt-2 window + tail + 300000 reserve:
        // 830250 at the BOUND (refuses) vs 730250 at the floor (would admit) -- 780000
        // sits strictly between them, so this straddles the tail pricing too.
        const s = seam(ARXIV_STEP_TIMEOUT_MS - 802500);
        const scope = createRunScope();
        scope.startedAtMs = 0;
        let calls = 0;
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            calls++;
            if (url.includes('resumptionToken')) { s.tick(1000); throw ABORT(); }
            s.tick(1000); return OK(PAGE('w.1', 'TOK-W')) as any;
        });
        let err: any = null;
        try { await adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, { ...s, runScope: scope }); } catch (e) { err = e; }
        expect(err.meta.terminal).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        expect(err.kind).toBe('fetch'); // a run stop, NOT a request timeout
        expect(s.sleeps).toEqual([]);  // the backoff was NEVER slept
        expect(calls).toBe(2);         // initial + ONE token attempt; no second request
    });

    // Anti-vacuity: with room, the identical scenario is admitted and does retry.
    it('GATE the identical scenario with room IS admitted (the gate is not always-refusing)', async () => {
        const s = seam(0);
        const scope = createRunScope();
        scope.startedAtMs = 0;
        let deep = 0;
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken')) {
                deep++;
                if (deep === 1) { s.tick(1000); throw ABORT(); }
                s.tick(1000); return OK(PAGE('w.2')) as any;
            }
            s.tick(1000); return OK(PAGE('w.1', 'TOK-W')) as any;
        });
        const out = await adapter.fetchOAI({ limit: 1000, from: '2026-07-01' }, { ...s, runScope: scope });
        expect(out.length).toBe(2);
        expect(s.sleeps).toEqual([TOKEN_BACKOFF_MS[0]]);
    });

    // A healthy fast walk with AMPLE remaining time is never refused and pays no
    // latency for the gate. Near the deadline it IS now refused (NBF-1) — that
    // refusal is the whole point; proven in harvest-arxiv-page-admission.test.ts.
    it('GATE a healthy fast walk with ample remaining time is never refused', async () => {
        const s = seam(0);
        const scope = createRunScope();
        scope.startedAtMs = 0;
        let n = 0;
        vi.spyOn(adapter, 'delay').mockImplementation(async () => undefined);
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            n++; return OK(PAGE(`ok.${n}`, n >= 3 ? undefined : `T${n}`)) as any;
        });
        const out = await adapter.fetchOAI({ limit: 100, from: '2026-07-01' }, { ...s, runScope: scope });
        expect(out.length).toBe(3);   // completes normally; every page admitted
        expect(s.sleeps).toEqual([]);
    });

    // The gate is REAL arithmetic against the reserve, and FAILS CLOSED on a bad clock.
    it('GATE reserve is preserved exactly, and a missing/corrupt run start fails closed', () => {
        const scope = { thirdAttemptTokens: new Set(), startedAtMs: 0 } as any;
        const fits = ARXIV_STEP_TIMEOUT_MS - TERMINALIZATION_RESERVE_MS - 1;
        expect(admitWallClock(scope, 0, fits)).toBeNull();          // 1ms inside the line
        expect(admitWallClock(scope, 0, fits + 1)).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED'); // exactly on it
        expect(admitWallClock(scope, 0, ARXIV_STEP_TIMEOUT_MS)).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        // Elapsed time counts against the window, not just the pending cost.
        expect(admitWallClock(scope, fits, 1)).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        // FAIL CLOSED rather than guess.
        expect(admitWallClock({ startedAtMs: undefined } as any, 0, 1)).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        expect(admitWallClock({ startedAtMs: NaN } as any, 0, 1)).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        expect(admitWallClock(scope, NaN, 1)).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
        expect(admitWallClock(scope, 0, NaN)).toBe('RUN_WALL_CLOCK_BUDGET_EXHAUSTED');
    });
});

describe('BF-2 — Retry-After is capped at the repo-wide 5-minute safety policy', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; });
    afterEach(() => { vi.restoreAllMocks(); });

    it('CAP delta-seconds 3600 / 6300 / 301 / 300 all resolve to 300000ms', () => {
        for (const secs of [3600, 6300, 301, 300]) {
            expect(effectiveRetryAfterMs(secs * 1000)).toBe(300000);
        }
        expect(MAX_RETRY_AFTER_MS).toBe(300000);
    });

    it('CAP a below-cap hint keeps its server-derived semantics', () => {
        expect(effectiveRetryAfterMs(7000)).toBe(7000);
        expect(effectiveRetryAfterMs(299999)).toBe(299999);
    });

    it('CAP an HTTP-date one hour out is capped; malformed/negative/past yield NO hint and never a negative wait', () => {
        const hourOut = new Date(Date.now() + 3600 * 1000).toUTCString();
        expect(effectiveRetryAfterMs(parseRetryAfterMs({ headers: { get: () => hourOut } }))).toBe(300000);
        const pastDate = new Date(Date.now() - 3600 * 1000).toUTCString();
        expect(parseRetryAfterMs({ headers: { get: () => pastDate } })).toBe(0); // clamped, never negative
        for (const bad of [null, undefined, NaN, Infinity, -1, -60000, 0]) {
            expect(effectiveRetryAfterMs(bad as any)).toBeNull(); // no hint -> configured backoff
        }
        expect(parseRetryAfterMs({ headers: { get: () => 'not-a-date' } })).toBeNull();
    });

    it('CAP the CAPPED value is what is slept, what is charged, and what the gate sees', async () => {
        const s = seam();
        let deep = 0;
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { s.tick(ms); });
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken')) {
                deep++;
                if (deep === 1) { s.tick(500); return HTTP(429, { 'retry-after': '3600' }) as any; }
                s.tick(500); return OK(PAGE('c.2')) as any;
            }
            s.tick(500); return OK(PAGE('c.1', 'TOK-C')) as any;
        });
        const out = await adapter.fetchOAI({ limit: 100, from: '2026-07-01' }, s);
        expect(out.length).toBe(2);
        expect(s.sleeps).toEqual([300000]);          // 300000, never the raw 3600000
        // ...and the CAPPED value is what was charged to the transport budget.
        const st = new ArxivRecoveryState(seam());
        st.beginToken('TC');
        expect(await st.executeRetryWait(3600 * 1000)).toBe(true);
        expect(st.transportActiveMs).toBe(300000);
        expect(st.lastRetryAfterRawMs).toBe(3600000); // raw retained, diagnostics only
    });
});
