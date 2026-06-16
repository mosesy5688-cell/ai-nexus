import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { FetchError } from '../../scripts/ingestion/adapters/base-adapter.js';

// WO-3-A1 (arXiv OAI Transport Recovery Core). REPLACES the old window-origin
// restart (which discarded a failing resumptionToken and re-issued a fresh
// first-page query). The new contract: a failing resumption page RETAINS its
// exact token and retries the SAME token within ONE single-arbiter transport
// budget (max 3 requests/token = initial + 2 retries); the token advances ONLY
// after a complete valid page is accepted. The deep-page timeout is 120000 on
// EVERY attempt (D-65: resumption timeout 60000 -> 120000) so a 65-90s page
// clears on its first attempt. All non-COMPLETE outcomes fail loud (FetchError),
// never a green healthy-partial.

const PAGE = (id: string, token?: string) =>
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' +
    `<record><header><datestamp>2026-06-01</datestamp></header>` +
    `<metadata><arXiv><id>${id}</id><categories>cs.LG</categories>` +
    `<title>Paper ${id}</title><abstract>Abstract ${id}.</abstract>` +
    '</arXiv></metadata></record>' +
    (token ? `<resumptionToken>${token}</resumptionToken>` : '') +
    '</ListRecords></OAI-PMH>';

const ONE_TARGET_PAGE = PAGE('2606.00001');
const FIRST_PAGE_WITH_TOKEN = PAGE('2606.00002', 'TOKEN-XYZ');
const SECOND_PAGE_NO_TOKEN = PAGE('2606.00003');
const EMPTY_OAI_XML =
    '<?xml version="1.0"?><OAI-PMH><ListRecords></ListRecords></OAI-PMH>';
const OAI_ERR = (code: string) =>
    `<?xml version="1.0"?><OAI-PMH><error code="${code}">bad</error></OAI-PMH>`;

const OK = (xml: string) => ({
    ok: true, status: 200, text: async () => xml, headers: { get: () => null },
});

function makeAbortError() {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
}

// Zeroed clock+sleep seam so the arbiter's bounded backoff never really sleeps.
const NO_SLEEP = { sleep: async () => undefined, now: () => Date.now() };

describe('ArXiv OAI transport recovery — same-token retry (WO-3-A1)', () => {
    let adapter: any;
    beforeEach(() => {
        adapter = new ArXivAdapter();
        process.env.ENABLE_AR5IV = 'false';
        vi.spyOn(adapter, 'delay').mockResolvedValue(undefined);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('healthy: initial + multiple resumption pages + last no-token -> exact parity', async () => {
        const fetchSpy = vi.spyOn(adapter, 'fetchWithTimeout')
            .mockResolvedValueOnce(OK(PAGE('2606.01', 'T1')) as any)
            .mockResolvedValueOnce(OK(PAGE('2606.02', 'T2')) as any)
            .mockResolvedValueOnce(OK(PAGE('2606.03')) as any);
        const result = await adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, NO_SLEEP);
        expect(result.map((p: any) => p.arxiv_id)).toEqual(['2606.01', '2606.02', '2606.03']);
        expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('same-token recovery: resumption page times out once then succeeds -> SAME token, accepted once', async () => {
        let firstCallUrl = '';
        let retryCallUrl = '';
        let call = 0;
        const fetchSpy = vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken')) {
                call++;
                if (call === 1) { firstCallUrl = url; throw makeAbortError(); } // token page fails once
                retryCallUrl = url;
                return OK(SECOND_PAGE_NO_TOKEN) as any; // retry: succeeds, no next token
            }
            return OK(FIRST_PAGE_WITH_TOKEN) as any; // first page -> TOKEN-XYZ
        });
        const result = await adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, NO_SLEEP);
        // Page accepted exactly once: 3 unique ids total (first + the retried page).
        expect(result.map((p: any) => p.arxiv_id)).toEqual(['2606.00002', '2606.00003']);
        // BOTH token requests used the EXACT same token (identity), never a fresh first page.
        expect(firstCallUrl).toContain('resumptionToken=TOKEN-XYZ');
        expect(retryCallUrl).toContain('resumptionToken=TOKEN-XYZ');
        expect(firstCallUrl).toBe(retryCallUrl);
        expect(fetchSpy).toHaveBeenCalledTimes(3); // first + failed-token + retried-token
    });

    it('deep-page timeout is 120000 on EVERY attempt (initial + same-token retry; D-65 60000->120000)', async () => {
        let tokenCall = 0;
        const fetchSpy = vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken')) {
                tokenCall++;
                if (tokenCall === 1) throw makeAbortError();
                return OK(SECOND_PAGE_NO_TOKEN) as any;
            }
            return OK(FIRST_PAGE_WITH_TOKEN) as any;
        });
        await adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, NO_SLEEP);
        // calls: [0]=first(120000), [1]=deep initial(120000), [2]=deep retry(120000)
        expect(fetchSpy.mock.calls[0][2]).toBe(120000);
        expect(fetchSpy.mock.calls[1][2]).toBe(120000);
        expect(fetchSpy.mock.calls[2][2]).toBe(120000);
    });

    it('first page AND first attempt of a resumption page both use 120000ms (raised, paired with retry)', async () => {
        const fetchSpy = vi.spyOn(adapter, 'fetchWithTimeout')
            .mockResolvedValueOnce(OK(FIRST_PAGE_WITH_TOKEN) as any)
            .mockResolvedValueOnce(OK(SECOND_PAGE_NO_TOKEN) as any);
        const result = await adapter.fetchOAI({ limit: 10, from: '2026-01-01' }, NO_SLEEP);
        expect(result.length).toBe(2);
        expect(fetchSpy.mock.calls[0][2]).toBe(120000);
        expect(fetchSpy.mock.calls[1][2]).toBe(120000);
    });

    it('exhaustion: same token times out to the limit -> PAGE_TIMEOUT_EXHAUSTED fail-loud, no window query', async () => {
        const calledUrls: string[] = [];
        const fetchSpy = vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            calledUrls.push(url);
            if (url.includes('resumptionToken')) throw makeAbortError(); // token always times out
            return OK(FIRST_PAGE_WITH_TOKEN) as any; // first page yields TOKEN-XYZ
        });
        await expect(adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ name: 'FetchError', kind: 'abort', source: 'arxiv' });
        // Partial yield is NOT healthy: it threw. Token NOT cleared: every token
        // request kept resumptionToken=TOKEN-XYZ; NO bare first-page re-query was
        // issued after the first page (exactly 1 non-token call total).
        const tokenCalls = calledUrls.filter(u => u.includes('resumptionToken'));
        const bareCalls = calledUrls.filter(u => !u.includes('resumptionToken'));
        expect(tokenCalls.length).toBe(3); // initial + 2 retries (max 3/token)
        expect(tokenCalls.every(u => u.includes('resumptionToken=TOKEN-XYZ'))).toBe(true);
        expect(bareCalls.length).toBe(1); // only the original first page
    });

    // NEGATIVE INVARIANT (mandatory): the OLD window-origin restart is IMPOSSIBLE.
    it('NEGATIVE: on a resumption-page timeout the token is NEVER reset to null / no fresh first-page query', async () => {
        const calledUrls: string[] = [];
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            calledUrls.push(url);
            if (url.includes('resumptionToken')) throw makeAbortError();
            return OK(FIRST_PAGE_WITH_TOKEN) as any;
        });
        await expect(adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, NO_SLEEP)).rejects.toBeInstanceOf(FetchError);
        // After the first page, EVERY subsequent fetch carried the SAME token; the
        // bare metadataPrefix first-page URL was NEVER re-issued (window-restart gone).
        const afterFirst = calledUrls.slice(1);
        expect(afterFirst.length).toBeGreaterThan(0);
        expect(afterFirst.every(u => u.includes('resumptionToken=TOKEN-XYZ'))).toBe(true);
        expect(afterFirst.some(u => u.includes('metadataPrefix'))).toBe(false);
    });
});

describe('ArXiv OAI error envelope + correctness terminals (WO-3-A1)', () => {
    let adapter: any;
    beforeEach(() => {
        adapter = new ArXivAdapter();
        process.env.ENABLE_AR5IV = 'false';
        vi.spyOn(adapter, 'delay').mockResolvedValue(undefined);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('HTTP200 + badResumptionToken envelope -> BAD_RESUMPTION_TOKEN fail-loud (not clean end)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) =>
            (url.includes('resumptionToken') ? OK(OAI_ERR('badResumptionToken')) : OK(FIRST_PAGE_WITH_TOKEN)) as any);
        await expect(adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ name: 'FetchError', detail: expect.stringContaining('BAD_RESUMPTION_TOKEN') });
    });

    it('HTTP200 + badArgument envelope -> fail-loud', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(OK(OAI_ERR('badArgument')) as any);
        await expect(adapter.fetchOAI({ limit: 10, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ detail: expect.stringContaining('OAI_ERROR') });
    });

    it('HTTP200 + UNKNOWN error code -> fail-closed (OAI_ERROR)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(OK(OAI_ERR('wibbleWobble')) as any);
        await expect(adapter.fetchOAI({ limit: 10, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ detail: expect.stringContaining('OAI_ERROR') });
    });

    it('initial-request noRecordsMatch -> clean-zero []', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(OK(OAI_ERR('noRecordsMatch')) as any);
        const result = await adapter.fetchOAI({ limit: 10, from: '2026-01-01' }, NO_SLEEP);
        expect(result).toEqual([]);
    });

    it('resumption-request noRecordsMatch -> fail-loud (never a clean end on a token)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) =>
            (url.includes('resumptionToken') ? OK(OAI_ERR('noRecordsMatch')) : OK(FIRST_PAGE_WITH_TOKEN)) as any);
        await expect(adapter.fetchOAI({ limit: 100, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ detail: expect.stringContaining('OAI_ERROR') });
    });

    it('genuinely-empty first page (HTTP 200, zero records) -> [] (stays SUCCESS)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(OK(EMPTY_OAI_XML) as any);
        const result = await adapter.fetchOAI({ limit: 10, from: '2026-01-01' }, NO_SLEEP);
        expect(result).toEqual([]);
    });

    it('malformed XML -> MALFORMED_XML fail-loud (kind=parse)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(OK('<<not valid xml ohno') as any);
        await expect(adapter.fetchOAI({ limit: 10, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ kind: 'parse', detail: expect.stringContaining('MALFORMED_XML') });
    });

    it('token cycle A->B->A -> TOKEN_CYCLE fail-loud', async () => {
        // first -> tokenA; A -> tokenB; B -> tokenA (cycle).
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            if (url.includes('resumptionToken=tokenA')) return OK(PAGE('id.B', 'tokenB')) as any;
            if (url.includes('resumptionToken=tokenB')) return OK(PAGE('id.A2', 'tokenA')) as any;
            return OK(PAGE('id.first', 'tokenA')) as any;
        });
        await expect(adapter.fetchOAI({ limit: 1000, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ detail: expect.stringContaining('TOKEN_CYCLE') });
    });

    it('zero unique progress across the window -> NO_PROGRESS fail-loud', async () => {
        // Each page carries a fresh token but only an ALREADY-seen id -> 0 new uniques.
        let n = 0;
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string) => {
            n++;
            // first page yields the only real id; every later page re-yields it.
            return OK(PAGE('dup.id', `tok${n}`)) as any;
        });
        await expect(adapter.fetchOAI({ limit: 1000, from: '2026-01-01' }, NO_SLEEP))
            .rejects.toMatchObject({ detail: expect.stringContaining('NO_PROGRESS') });
    });

    it('total budget exhaustion -> TOTAL_BUDGET_EXHAUSTED fail-loud', async () => {
        // Fake clock that jumps past the 600000ms budget after the first page.
        let t = 0;
        const clock = { now: () => t, sleep: async () => undefined };
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async () => {
            t += 700000; // exceed TOTAL_BUDGET_MS on the next loop check
            return OK(FIRST_PAGE_WITH_TOKEN) as any;
        });
        await expect(adapter.fetchOAI({ limit: 1000, from: '2026-01-01' }, clock))
            .rejects.toMatchObject({ detail: expect.stringContaining('TOTAL_BUDGET_EXHAUSTED') });
    });

    it('healthy output structure parity: mapped paper carries arxiv_id/title/summary/categories', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(OK(ONE_TARGET_PAGE) as any);
        const result = await adapter.fetchOAI({ limit: 10, from: '2026-01-01' }, NO_SLEEP);
        expect(result[0]).toMatchObject({
            arxiv_id: '2606.00001', title: 'Paper 2606.00001', categories: ['cs.LG'],
        });
        expect(result[0].summary).toContain('Abstract');
    });
});
