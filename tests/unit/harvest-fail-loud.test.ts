import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { FetchError, RateLimitExceededError } from '../../scripts/ingestion/adapters/base-adapter.js';
// @ts-ignore
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';

// H1 (stop-the-bleeding, WO-2): harvest fetch errors must FAIL LOUD — they must
// never launder into a green zero-yield run. These tests pin the three-layer
// taxonomy:
//   (1) ArXiv adapter: a caught fetch/abort/parse error returns a STRUCTURED
//       FetchError (thrown), never a plain []. A genuinely-empty OAI response
//       (HTTP 200, parseable, no records) stays a legitimate success [].
//   (2) harvest-single chokepoint: an adapter FetchError sets result.error so
//       the existing exit gate fires nonzero; a RateLimitExceededError
//       early-finish stays success (CI-throughput tolerance); a genuine empty
//       stays success.

const OK = (xml: string) => ({
    ok: true,
    status: 200,
    text: async () => xml,
    headers: { get: () => null },
});

// An OAI ListRecords envelope with zero records: HTTP 200, valid XML, no papers.
const EMPTY_OAI_XML =
    '<?xml version="1.0"?><OAI-PMH><ListRecords></ListRecords></OAI-PMH>';

describe('ArXiv adapter — fetch errors surface a structured FetchError, not a green []', () => {
    let adapter: any;

    beforeEach(() => {
        adapter = new ArXivAdapter();
        // Avoid ar5iv enrichment network calls and real 20s/250ms sleeps.
        process.env.ENABLE_AR5IV = 'false';
        vi.spyOn(adapter, 'delay').mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('AbortError (hung/timed-out request) -> throws FetchError(kind="abort"), NOT a plain []', async () => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        vi.spyOn(adapter, 'fetchWithTimeout').mockRejectedValue(abortErr);

        await expect(adapter.fetchOAI({ limit: 10, from: '2026-01-01' }))
            .rejects.toBeInstanceOf(FetchError);

        // And specifically classified as an abort, addressed to arxiv.
        try {
            await adapter.fetchOAI({ limit: 10, from: '2026-01-01' });
            throw new Error('expected rejection');
        } catch (e: any) {
            expect(e).toBeInstanceOf(FetchError);
            expect(e.kind).toBe('abort');
            expect(e.source).toBe('arxiv');
        }
    });

    it('connection fetch error -> throws FetchError(kind="fetch")', async () => {
        // A raw network TypeError, as undici/fetch throws on connection failure.
        vi.spyOn(adapter, 'fetchWithTimeout').mockRejectedValue(new TypeError('fetch failed'));
        await expect(adapter.fetchOAI({ limit: 10, from: '2026-01-01' }))
            .rejects.toMatchObject({ name: 'FetchError', kind: 'fetch', source: 'arxiv' });
    });

    it('parse error (HTTP 200 but unparseable XML) -> throws FetchError(kind="parse")', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(
            OK('<<not valid xml ohno') as any
        );
        await expect(adapter.fetchOAI({ limit: 10, from: '2026-01-01' }))
            .rejects.toMatchObject({ name: 'FetchError', kind: 'parse' });
    });

    it('non-ok HTTP that survives the retry ladder -> throws FetchError(kind="fetch")', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue({
            ok: false,
            status: 500, // not 502/504, so the transient-retry branch is skipped -> break
            text: async () => '',
            headers: { get: () => null },
        } as any);
        await expect(adapter.fetchOAI({ limit: 10, from: '2026-01-01' }))
            .rejects.toMatchObject({ name: 'FetchError', kind: 'fetch' });
    });

    it('genuinely-empty result (HTTP 200, parseable, zero records) -> resolves [] (stays SUCCESS)', async () => {
        vi.spyOn(adapter, 'fetchWithTimeout').mockResolvedValue(OK(EMPTY_OAI_XML) as any);
        const result = await adapter.fetchOAI({ limit: 10, from: '2026-01-01' });
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(0);
    });
});

describe('harvest-single chokepoint — error-caused emptiness fails, legit empty/rate-limit stays success', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    function fakeAdapter(fetchImpl: (opts: any) => Promise<any>) {
        return {
            entityTypes: ['paper'],
            fetch: fetchImpl,
            normalize: (raw: any) => raw,
        };
    }

    it('adapter FetchError -> result.error set (trips the exit gate)', async () => {
        const adapter = fakeAdapter(async () => {
            throw new FetchError('arxiv', 'abort', 'simulated hung request');
        });
        const result = await harvestSingle('arxiv', { limit: 5, skipBridge: true, _adapter: adapter });
        expect(result.error).toBeTruthy();
        expect(result.count).toBe(0);
    });

    it('RateLimitExceededError early-finish -> NO result.error (stays success, exit 0)', async () => {
        const adapter = fakeAdapter(async () => {
            throw new RateLimitExceededError('arxiv', '120.0');
        });
        const result = await harvestSingle('arxiv', { limit: 5, skipBridge: true, _adapter: adapter });
        expect(result.error).toBeUndefined();
        expect(result.count).toBe(0);
    });

    it('genuine empty [] -> NO result.error (true no-new-data stays success)', async () => {
        const adapter = fakeAdapter(async () => []);
        const result = await harvestSingle('arxiv', { limit: 5, skipBridge: true, _adapter: adapter });
        expect(result.error).toBeUndefined();
        expect(result.count).toBe(0);
    });
});
