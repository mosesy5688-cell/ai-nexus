import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';
// @ts-ignore
import { FetchError } from '../../scripts/ingestion/adapters/base-adapter.js';

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
