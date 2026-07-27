import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-ignore -- JS ESM modules (no .d.ts); tested for their runtime contract.
import { SemanticScholarAdapter } from '../../scripts/ingestion/adapters/semanticscholar-adapter.js';
// @ts-ignore
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';
// @ts-ignore
import { TERMINAL } from '../../scripts/ingestion/adapters/s2-retry-envelope.js';
// @ts-ignore
import { evaluateFloorGate, DEFAULT_FLOORS } from '../../scripts/ingestion/harvest-floors.js';

// 2026-07-26 Factory 1/4 S2 incident (natural cron run 30189935455) -- CHOKEPOINT
// half. The adapter-level contract lives in harvest-s2-error-propagation.test.ts;
// this file pins what harvest-single.js DOES with a surfaced S2 failure:
// status=failed/timeout, had_adapter_error=true, floor_violated=false, and NEVER
// the `floor_violation: 0 < 300` misclassification the swallow used to manufacture.
// Split from that file to stay under the CES 250-line ceiling.
//
// NOTE: nothing here asserts whether the real Semantic Scholar service has
// recovered. That remains unverified and is irrelevant to the contract.

/** A page body in the documented bulk-search shape. */
function page(ids: string[], token: string | null = null) {
    return { total: ids.length, token, data: ids.map((id) => ({ paperId: id, title: `T ${id}`, abstract: 'a' })) };
}
const ok = (body: any) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, headers: { get: () => null } });
const bad = (status: number) => ({ ok: false, status, statusText: `E${status}`, json: async () => ({}), headers: { get: () => null } });

function abortError() {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
}

/** An adapter with zero real waiting: no ladder backoff, no 5s inter-page pacing. */
function fastAdapter() {
    const adapter: any = new SemanticScholarAdapter();
    adapter.retryDeps = { sleep: async () => undefined };
    vi.spyOn(adapter, 'delay').mockResolvedValue(undefined as any);
    return adapter;
}

/** Capture the `HARVEST_STATE <json>` machine line harvest-state.js always prints. */
function captureSidecars() {
    const seen: any[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
        const first = typeof args[0] === 'string' ? args[0] : '';
        if (first.startsWith('HARVEST_STATE ')) seen.push(JSON.parse(first.slice('HARVEST_STATE '.length)));
    });
    return { seen, spy };
}

describe('harvest-single chokepoint -- an S2 adapter failure is reported as failed/timeout, never floor_violation', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    async function runS2(mockImpl: (url: any) => Promise<any>, limit = 40) {
        const adapter = fastAdapter();
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(mockImpl as any);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const cap = captureSidecars();
        const result = await harvestSingle('semanticscholar', { limit, skipBridge: true, _adapter: adapter });
        cap.spy.mockRestore();
        return { result, sidecar: cap.seen[cap.seen.length - 1], adapter };
    }

    // ---- TESTS 7, 8, 9 ---------------------------------------------------
    it('7/8/9. HTTP 500 -> status=failed, had_adapter_error=true, floor_violated=false, status+topic retained', async () => {
        const { result, sidecar } = await runS2(async () => bad(500));

        expect(result.error).toBeTruthy();                       // trips the exit gate
        expect(sidecar.status).toBe('failed');                   // 7
        expect(sidecar.had_adapter_error).toBe(true);            // 7
        expect(sidecar.floor_violated).toBe(false);              // 9
        expect(sidecar.status).not.toBe('floor_violation');      // 9
        expect(sidecar.errors.join(' ')).not.toContain('floor violation');
        expect(sidecar.terminal_meta.last_http_status).toBe(500); // 8
        expect(sidecar.terminal_meta.failed_topic).toBeTruthy();  // 8
        expect(sidecar.terminal_meta.terminal).toBe(TERMINAL.ATTEMPTS_EXHAUSTED);
        expect(sidecar.terminal_meta.source_complete).toBe(false);
    });

    it('a request timeout is reported as status=timeout with timeout_kind=request_timeout', async () => {
        const { result, sidecar } = await runS2(async () => { throw abortError(); });
        expect(result.error).toBeTruthy();
        expect(sidecar.status).toBe('timeout');
        expect(sidecar.had_adapter_error).toBe(true);
        expect(sidecar.floor_violated).toBe(false);
        expect(sidecar.terminal_meta.timeout_kind).toBe('request_timeout');
    });

    // ---- The severe half: PARTIAL ABOVE FLOOR ----------------------------
    it('PARTIAL-ABOVE-FLOOR: 3 topics succeed and the 4th fails, yield >> floor 300 -> still NOT success', async () => {
        // The case the floor gate structurally cannot catch. Floor is 300; the three
        // healthy topics deliver far more than that, so a swallow would have produced
        // status:"success", exit 0, and a 75% harvest published as authoritative.
        const healthy = ['machine learning', 'artificial intelligence', 'nlp'];
        const { result, sidecar } = await runS2(async (url: any) => {
            const t = decodeURIComponent(String(url).match(/query=([^&]+)/)![1]);
            if (!healthy.includes(t)) return bad(500);
            const ids = Array.from({ length: 400 }, (_, i) => `${t}-${i}`);
            return ok(page(ids));
        }, 4000);

        expect(sidecar.yield).toBeGreaterThan(DEFAULT_FLOORS.semanticscholar); // clears the floor
        expect(sidecar.yield).toBeGreaterThan(1000);
        expect(sidecar.status).not.toBe('success');          // the whole point
        expect(sidecar.status).toBe('failed');
        expect(sidecar.had_adapter_error).toBe(true);
        expect(sidecar.floor_violated).toBe(false);
        expect(sidecar.terminal_meta.failed_topic).toBe('computer vision');
        expect(sidecar.terminal_meta.source_complete).toBe(false);
        // result.error is what blocks publication: harvest-single.js:235-238 exits 1,
        // so the (non-`always()`) R2 authority step and `Merge & Upload` never run.
        expect(result.error).toBeTruthy();
        expect(result.count).toBeGreaterThan(1000);
    });

    it('a healthy S2 harvest above the floor is still reported success (no false incompleteness)', async () => {
        const { result, sidecar } = await runS2(async (url: any) => {
            const t = decodeURIComponent(String(url).match(/query=([^&]+)/)![1]);
            return ok(page(Array.from({ length: 400 }, (_, i) => `${t}-${i}`)));
        }, 4000);
        expect(result.error).toBeUndefined();
        expect(sidecar.status).toBe('success');
        expect(sidecar.had_adapter_error).toBe(false);
        expect(sidecar.floor_violated).toBe(false);
    });

    it('the floor gate is STRUCTURALLY unreachable after an adapter error, not merely overridden', () => {
        // Two independent guarantees, both asserted:
        //  (1) control flow: harvest-single.js returns at the fetchHardError branch
        //      BEFORE the floor gate is evaluated (proved behaviourally above -- an
        //      HTTP 500 with zero yield reports `failed`, never `floor_violation`).
        //  (2) the gate itself refuses to fire when an adapter error is signalled.
        expect(evaluateFloorGate({ sourceName: 'semanticscholar', count: 0, hadAdapterError: true }))
            .toEqual({ violated: false, floor: DEFAULT_FLOORS.semanticscholar });
        expect(evaluateFloorGate({ sourceName: 'semanticscholar', count: 0, hadAdapterError: false }))
            .toEqual({ violated: true, floor: DEFAULT_FLOORS.semanticscholar });
    });

});
