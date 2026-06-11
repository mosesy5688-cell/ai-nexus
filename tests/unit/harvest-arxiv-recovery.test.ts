import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { FetchError } from '../../scripts/ingestion/adapters/base-adapter.js';

// H1 WO-2b (arXiv first-page timeout/retry RECOVERY). Builds ON #2182's
// fail-loud: WO-1 found the OAI endpoint is alive but has an intermittent FIRST-
// request slow tail (5-12s typical, 65-90s+ spikes). The old 60s abort cut that
// tail into a LOUD abort FetchError yielding 0. Recovery = ONLY the cold first
// ListRecords gets a 120s budget + a bounded exponential-backoff retry so the
// spike can resolve. On final exhaustion the #2182 FetchError(kind=abort) MUST
// still throw — recovery never degrades a genuine failure back to a green [].

// One OAI ListRecords batch carrying a single target (cs.LG) paper, no
// resumptionToken -> the harvest loop breaks after this one successful page.
const ONE_TARGET_PAGE =
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' +
    '<record><header><datestamp>2026-06-01</datestamp></header>' +
    '<metadata><arXiv><id>2606.00001</id><categories>cs.LG</categories>' +
    '<title>Recovery Works</title><abstract>An abstract.</abstract>' +
    '</arXiv></metadata></record>' +
    '</ListRecords></OAI-PMH>';

// First page WITH a resumptionToken -> the loop fetches a SECOND page.
const FIRST_PAGE_WITH_TOKEN =
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' +
    '<record><header><datestamp>2026-06-01</datestamp></header>' +
    '<metadata><arXiv><id>2606.00002</id><categories>cs.LG</categories>' +
    '<title>Page One</title><abstract>First.</abstract>' +
    '</arXiv></metadata></record>' +
    '<resumptionToken>TOKEN-XYZ</resumptionToken>' +
    '</ListRecords></OAI-PMH>';

// Second (paginated) page: another target paper, no further token -> loop ends.
const SECOND_PAGE_NO_TOKEN =
    '<?xml version="1.0"?><OAI-PMH><ListRecords>' +
    '<record><header><datestamp>2026-06-02</datestamp></header>' +
    '<metadata><arXiv><id>2606.00003</id><categories>cs.LG</categories>' +
    '<title>Page Two</title><abstract>Second.</abstract>' +
    '</arXiv></metadata></record>' +
    '</ListRecords></OAI-PMH>';

// Genuinely-empty OAI envelope: HTTP 200, valid XML, zero records.
const EMPTY_OAI_XML =
    '<?xml version="1.0"?><OAI-PMH><ListRecords></ListRecords></OAI-PMH>';

const OK = (xml: string) => ({
    ok: true,
    status: 200,
    text: async () => xml,
    headers: { get: () => null },
});

function makeAbortError() {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
}

describe('ArXiv first-page recovery — 120s timeout + bounded retry (H1 WO-2b)', () => {
    let adapter: any;

    beforeEach(() => {
        adapter = new ArXivAdapter();
        // No ar5iv network calls and no real 15s/30s/60s/250ms/20s sleeps.
        process.env.ENABLE_AR5IV = 'false';
        vi.spyOn(adapter, 'delay').mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // (a) first attempt times out, a retry succeeds -> resolves with papers.
    it('first attempt aborts, retry succeeds -> resolves with the recovered papers', async () => {
        const fetchSpy = vi
            .spyOn(adapter, 'fetchWithTimeout')
            .mockRejectedValueOnce(makeAbortError()) // first page: slow-tail abort
            .mockResolvedValueOnce(OK(ONE_TARGET_PAGE) as any); // retry: success

        const result = await adapter.fetchOAI({ limit: 10, from: '2026-01-01' });

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(1);
        expect(result[0].arxiv_id).toBe('2606.00001');
        // Exactly one retry was spent (2 total attempts).
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    // (b) all retries time out -> #2182 FetchError(kind="abort") still throws.
    it('every first-page attempt aborts -> throws FetchError(kind="abort") (fail-loud preserved)', async () => {
        const fetchSpy = vi
            .spyOn(adapter, 'fetchWithTimeout')
            .mockRejectedValue(makeAbortError());

        await expect(adapter.fetchOAI({ limit: 10, from: '2026-01-01' }))
            .rejects.toMatchObject({ name: 'FetchError', kind: 'abort', source: 'arxiv' });
        // Initial attempt + 3 bounded retries = 4 calls, then loud failure.
        expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    // (c) genuinely-empty first page -> still success [] (no false failure).
    it('genuinely-empty first page (HTTP 200, zero records) -> resolves [] (stays SUCCESS)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(OK(EMPTY_OAI_XML) as any);
        const result = await adapter.fetchOAI({ limit: 10, from: '2026-01-01' });
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(0);
    });

    // (d) no-regression: first page gets 120s, the paginated page keeps 60s.
    it('first page uses 120000ms; subsequent resumptionToken page keeps 60000ms', async () => {
        const fetchSpy = vi
            .spyOn(adapter, 'fetchWithTimeout')
            .mockResolvedValueOnce(OK(FIRST_PAGE_WITH_TOKEN) as any) // first page
            .mockResolvedValueOnce(OK(SECOND_PAGE_NO_TOKEN) as any); // resumed page

        const result = await adapter.fetchOAI({ limit: 10, from: '2026-01-01' });

        expect(result.length).toBe(2);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        // Arg #3 (timeoutMs) of each call: first page 120s, resumed page 60s.
        expect(fetchSpy.mock.calls[0][2]).toBe(120000);
        expect(fetchSpy.mock.calls[1][2]).toBe(60000);
    });
});
