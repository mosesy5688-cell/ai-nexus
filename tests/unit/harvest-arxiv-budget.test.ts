import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { FetchError } from '../../scripts/ingestion/adapters/base-adapter.js';
// @ts-ignore
import { TOTAL_BUDGET_MS } from '../../scripts/ingestion/adapters/arxiv-recovery-state.js';

// WO-3-A1 D-2026-0616-67 amendment — BLOCKERS A/B/C/D. Drives the real
// ArXivAdapter.fetchOAI through an injected fetchWithTimeout + clock/sleep seam;
// no live network, no real sleep. TRANSPORT RECOVERY ONLY (normalize/ar5iv/
// relations untouched). Companion: harvest-arxiv-recovery.test.ts (same-token +
// OAI envelope + correctness) and harvest-arxiv-terminal-meta.test.ts (BLOCKER E).

const REC = (id: string) =>
    `<record><header><datestamp>2026-06-01</datestamp></header>` +
    `<metadata><arXiv><id>${id}</id><categories>cs.LG</categories>` +
    `<title>Paper ${id}</title><abstract>Abstract ${id}.</abstract>` +
    '</arXiv></metadata></record>';
const REC_NONTARGET = (id: string) =>
    `<record><header><datestamp>2026-06-01</datestamp></header>` +
    `<metadata><arXiv><id>${id}</id><categories>math.AG</categories>` +
    `<title>Paper ${id}</title><abstract>Abstract ${id}.</abstract>` +
    '</arXiv></metadata></record>';
const PAGE = (id: string, token?: string) =>
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' + REC(id) +
    (token ? `<resumptionToken>${token}</resumptionToken>` : '') +
    '</ListRecords></OAI-PMH>';
const PAGE_NONTARGET = (id: string, token?: string) =>
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' + REC_NONTARGET(id) +
    (token ? `<resumptionToken>${token}</resumptionToken>` : '') +
    '</ListRecords></OAI-PMH>';
const FIRST_PAGE_WITH_TOKEN = PAGE('2606.00002', 'TOKEN-XYZ');
const SECOND_PAGE_NO_TOKEN = PAGE('2606.00003');
const EMPTY_OAI_XML = '<?xml version="1.0"?><OAI-PMH><ListRecords></ListRecords></OAI-PMH>';
const MISSING_LISTRECORDS = '<?xml version="1.0"?><OAI-PMH></OAI-PMH>';

const OK = (xml: string, headers: Record<string, string> = {}) => ({
    ok: true, status: 200, text: async () => xml,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
});
const HTTP = (status: number, headers: Record<string, string> = {}) => ({
    ok: false, status, text: async () => '',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
});
const NO_SLEEP = { sleep: async () => undefined, now: () => Date.now() };

describe('WO-3-A1 D-67 BLOCKER A — true OAI active-transport budget', () => {
    let adapter: any;
    beforeEach(() => { adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false'; });
    afterEach(() => { vi.restoreAllMocks(); });

    // TEST 1: a 60+ page healthy walk COMPLETES with 20s pacing + simulated
    // enrichment wall time PRESENT but EXCLUDED from the transport budget.
    it('TEST1 60+ page healthy walk completes (pacing + enrichment wall time present but EXCLUDED)', async () => {
        const PAGES = 62;
        let t = 0;
        const clock = { now: () => t, sleep: async () => undefined };
        vi.spyOn(adapter, 'delay').mockImplementation(async (ms: number) => { t += ms; }); // pacing OUTSIDE span
        vi.spyOn(adapter, 'enrichBatch').mockImplementation(async () => { t += 30000; }); // enrich OUTSIDE span
        let n = 0;
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            n++;
            t += 3000; // 3s ACTIVE transport per page (charged: 62*3s=186s << budget)
            return OK(PAGE(`2606.${String(n).padStart(5, '0')}`, n >= PAGES ? undefined : `T${n}`)) as any;
        });
        const result = await adapter.fetchOAI({ limit: 100000, from: '2026-01-01' }, clock);
        expect(result.length).toBe(PAGES);
        // ~3.3M ms of end-to-end wall time — FAR over the old 600000ms ceiling — yet
        // COMPLETES because only the 186s of active transport is charged.
        expect(t).toBeGreaterThan(600000);
    });

    // TEST 2: enrichment + normal page pacing do NOT consume the budget.
    it('TEST2 enrichment + 20s pacing do NOT consume the active-transport budget', async () => {
        let t = 0;
        const clock = { now: () => t, sleep: async () => undefined };
        vi.spyOn(adapter, 'delay').mockImplementation(async () => { t += 5_000_000; });
        vi.spyOn(adapter, 'enrichBatch').mockImplementation(async () => { t += 5_000_000; });
        let n = 0;
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            n++; t += 1000;
            return OK(PAGE(`x.${n}`, n >= 3 ? undefined : `T${n}`)) as any;
        });
        const result = await adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, clock);
        expect(result.length).toBe(3); // >20M ms pacing+enrich wall time; budget untouched
    });

    // TEST 3: request timeout is capped by remaining transport budget.
    it('TEST3 request timeout = min(120000, remaining transport budget)', async () => {
        let t = 0;
        const clock = { now: () => t, sleep: async () => undefined };
        vi.spyOn(adapter, 'delay').mockResolvedValue(undefined);
        const timeouts: number[] = [];
        let n = 0;
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (_u: string, _o: any, timeoutMs: number) => {
            timeouts.push(timeoutMs); n++;
            if (n === 1) t += (TOTAL_BUDGET_MS - 50000); // leave ~50000 remaining
            return OK(PAGE(`y.${n}`, n >= 2 ? undefined : `T${n}`)) as any;
        });
        await adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, clock);
        expect(timeouts[0]).toBe(120000);  // page 1: full deep envelope
        expect(timeouts[1]).toBe(50000);   // page 2: capped by remaining budget
        expect(timeouts[1]).toBeLessThan(120000);
    });

    // TEST 4: cumulative active-transport exhaustion -> TOTAL_BUDGET_EXHAUSTED.
    it('TEST4 cumulative active-transport exhaustion -> TOTAL_BUDGET_EXHAUSTED fail-loud', async () => {
        let t = 0;
        const clock = { now: () => t, sleep: async () => undefined };
        vi.spyOn(adapter, 'delay').mockResolvedValue(undefined);
        let n = 0;
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            n++; t += 1_000_000; // 7 pages * 1M ms > 6.3M budget
            return OK(PAGE(`z.${n}`, `T${n}`)) as any; // always a fresh advancing page
        });
        await expect(adapter.fetchOAI({ limit: 100000, from: '2026-01-01' }, clock))
            .rejects.toMatchObject({ name: 'FetchError', detail: expect.stringContaining('TOTAL_BUDGET_EXHAUSTED') });
    });
});

describe('WO-3-A1 D-67 BLOCKER B — structural missing ListRecords', () => {
    let adapter: any;
    beforeEach(() => {
        adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false';
        vi.spyOn(adapter, 'delay').mockResolvedValue(undefined);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    // TEST 5: tokened missing ListRecords -> fail-loud (NEVER COMPLETE).
    it('TEST5 tokened response missing <ListRecords> -> fail-loud (never COMPLETE)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) =>
            (url.includes('resumptionToken') ? OK(MISSING_LISTRECORDS) : OK(FIRST_PAGE_WITH_TOKEN)) as any);
        await expect(adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ name: 'FetchError', kind: 'parse', detail: expect.stringContaining('MALFORMED_XML') });
    });

    // TEST 6: initial structurally-invalid (missing ListRecords) -> fail-loud.
    it('TEST6 initial request missing <ListRecords> node -> MALFORMED_XML fail-loud', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(OK(MISSING_LISTRECORDS) as any);
        await expect(adapter.fetchOAI({ limit: 10, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ kind: 'parse', detail: expect.stringContaining('MALFORMED_XML') });
    });

    // TEST 7: initial valid empty ListRecords (PRESENT, zero records) -> clean-zero [].
    it('TEST7 initial valid empty ListRecords (present, zero records) -> clean-zero []', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(OK(EMPTY_OAI_XML) as any);
        const result = await adapter.fetchOAI({ limit: 10, from: '2026-01-01' }, NO_SLEEP);
        expect(result).toEqual([]);
    });
});

describe('WO-3-A1 D-67 BLOCKER C — rate-limit fully arbiter-owned', () => {
    let adapter: any;
    beforeEach(() => {
        adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false';
        vi.spyOn(adapter, 'delay').mockResolvedValue(undefined);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    // TEST 8: 403/429/503 retries remain same-token + stop at <=3/token.
    it.each([403, 429, 503])('TEST8 HTTP %s retries same-token, max 3/token (4th impossible), handleRateLimit NEVER self-sleeps', async (status) => {
        const handleSpy = vi.spyOn(adapter, 'handleRateLimit');
        const calledUrls: string[] = [];
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            calledUrls.push(url);
            if (url.includes('resumptionToken')) return HTTP(status) as any;
            return OK(FIRST_PAGE_WITH_TOKEN) as any;
        });
        await expect(adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, NO_SLEEP)).rejects.toBeInstanceOf(FetchError);
        const tokenCalls = calledUrls.filter(u => u.includes('resumptionToken'));
        expect(tokenCalls.length).toBe(3); // initial + 2 retries; 4th impossible
        expect(tokenCalls.every(u => u.includes('resumptionToken=TOKEN-XYZ'))).toBe(true);
        expect(handleSpy).not.toHaveBeenCalled(); // arbiter-owned, NOT the legacy self-sleep path
    });

    // TEST 9: Retry-After arbiter-owned + budget-charged.
    it('TEST9 Retry-After is arbiter-executed via the sleep seam + budget-charged', async () => {
        const sleeps: number[] = [];
        const clock = { now: () => Date.now(), sleep: async (ms: number) => { sleeps.push(ms); } };
        let n = 0;
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken')) {
                n++;
                if (n === 1) return HTTP(429, { 'retry-after': '7' }) as any; // 7s, then succeed
                return OK(SECOND_PAGE_NO_TOKEN) as any;
            }
            return OK(FIRST_PAGE_WITH_TOKEN) as any;
        });
        const result = await adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, clock);
        expect(result.length).toBe(2);
        expect(sleeps).toContain(7000); // arbiter executed the Retry-After (not the 15s default)
    });
});

describe('WO-3-A1 D-67 BLOCKER D — raw vs product progress + atomicity', () => {
    let adapter: any;
    beforeEach(() => {
        adapter = new ArXivAdapter(); process.env.ENABLE_AR5IV = 'false';
        vi.spyOn(adapter, 'delay').mockResolvedValue(undefined);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    // TEST 10: valid non-target-category but raw-progressing pages do NOT fire NO_PROGRESS.
    it('TEST10 non-target-category but raw-advancing pages do NOT fire false NO_PROGRESS', async () => {
        let n = 0;
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            n++;
            return OK(PAGE_NONTARGET(`nt.${n}`, n >= 5 ? undefined : `NT${n}`)) as any;
        });
        const result = await adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, NO_SLEEP);
        expect(result).toEqual([]); // 0 PRODUCT yield (all filtered out)
        expect(n).toBe(5);          // but all 5 raw-advancing pages were walked, no NO_PROGRESS
    });

    // TEST 11: duplicate raw page (same raw IDs, even if token text changes) -> no-progress.
    it('TEST11 replayed raw page (same raw ids, fresh token text each time) -> NO_PROGRESS fail-loud', async () => {
        let n = 0;
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            n++;
            return OK(PAGE('dup.id', `tok${n}`)) as any; // same raw id, new token each time
        });
        await expect(adapter.fetchOAI({ limit: 1000, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ detail: expect.stringContaining('NO_PROGRESS') });
    });

    // TEST 12: token-cycle rejection occurs BEFORE enrichment + before seenIds commit.
    it('TEST12 token-cycle rejection occurs BEFORE enrichBatch + before seenIds commit', async () => {
        const enrichSpy = vi.spyOn(adapter, 'enrichBatch');
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken=tokenA')) return OK(PAGE('id.B', 'tokenB')) as any;
            if (url.includes('resumptionToken=tokenB')) return OK(PAGE('id.A2', 'tokenA')) as any; // cycle
            return OK(PAGE('id.first', 'tokenA')) as any;
        });
        await expect(adapter.fetchOAI({ limit: 1000, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ detail: expect.stringContaining('TOKEN_CYCLE') });
        // enrichBatch ran exactly twice (the 2 pages accepted BEFORE the cycle); the
        // cycle page (id.A2) was rejected BEFORE enrichment + before its dedup commit.
        const calls = enrichSpy.mock.calls.map((c: any[]) => (c[0] as any[]).map((p: any) => p.arxiv_id));
        expect(calls).toEqual([['id.first'], ['id.B']]); // id.A2 (cycle) never enriched
    });
});
