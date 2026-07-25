import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { fetchAr5ivHtml } from '../../scripts/ingestion/adapters/ar5iv-fetcher.js';

// NBF-4 — the per-attempt window must cover the COMPLETE response lifecycle, not
// just headers. Bodies are controlled fakes and every deadline used here is tiny
// (100-250ms), so the suite exercises real timers without any meaningful wait.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A SIGNAL-AWARE fake fetch, modelling undici: aborting the signal errors the body
 * stream, so `text()` rejects with AbortError. `bodyMs` is how long the body would
 * take if never aborted; `trickle` makes it progress continuously (never idle) so a
 * TOTAL deadline is distinguishable from an idle one.
 */
function signalAwareFetch(bodyMs: number, text = '<html><p>' + 'z'.repeat(400) + '</p></html>', trickle = false, headerMs = 0) {
    const state = { aborted: false, bodyStarted: false };
    const impl = async (_url: string, opts: any) => (await sleep(headerMs), {
        ok: true, status: 200, headers: { get: () => null },
        text: () => new Promise<string>((resolve, reject) => {
            state.bodyStarted = true;
            const fail = () => { state.aborted = true; const e: any = new Error('aborted'); e.name = 'AbortError'; reject(e); };
            if (opts.signal?.aborted) return fail();
            opts.signal?.addEventListener('abort', fail, { once: true });
            if (trickle) {
                let n = 0;
                const tick = () => { if (state.aborted) return; if (++n > 400) return resolve(text); setTimeout(tick, 10); };
                setTimeout(tick, 10);   // continuous progress, never idle
            } else {
                setTimeout(() => { if (!state.aborted) resolve(text); }, bodyMs);
            }
        }),
    });
    return { impl, state };
}

describe('NBF-4 — ar5iv: FETCH_TIMEOUT_MS covers the whole response lifecycle', () => {
    afterEach(() => { vi.restoreAllMocks(); });
    const FAST = { rateLimitMs: 0 }; // the 5s spacing is exercised by the cost model, not here

    it('AR5IV-STALL immediate headers + stalled body fails AT the deadline, not after the body', async () => {
        const { impl, state } = signalAwareFetch(900);
        const started = Date.now();
        const out = await fetchAr5ivHtml('2607.00001', { ...FAST, timeoutMs: 150, fetch: impl });
        const elapsed = Date.now() - started;
        expect(out).toBeNull();                        // aborted, never a late "success"
        expect(state.bodyStarted).toBe(true);          // the body read really had begun
        expect(state.aborted).toBe(true);              // and the deadline killed it
        expect(elapsed).toBeGreaterThanOrEqual(140);
        expect(elapsed).toBeLessThan(600);             // bounded by 150ms, NOT the 900ms body
    });

    it('AR5IV-OK a body completing INSIDE the deadline still succeeds', async () => {
        const { impl } = signalAwareFetch(40);
        const started = Date.now();
        const out = await fetchAr5ivHtml('2607.00002', { ...FAST, timeoutMs: 400, fetch: impl });
        expect(Date.now() - started).toBeLessThan(300);
        expect(out).toContain('z');                    // real content returned
    });

    it('AR5IV-TRICKLE a slowly PROGRESSING body crossing the deadline still fails (total, not idle)', async () => {
        const { impl, state } = signalAwareFetch(0, undefined, true); // a chunk every 10ms
        const started = Date.now();
        const out = await fetchAr5ivHtml('2607.00003', { ...FAST, timeoutMs: 150, fetch: impl });
        const elapsed = Date.now() - started;
        expect(out).toBeNull();
        expect(state.aborted).toBe(true);
        expect(elapsed).toBeLessThan(600);             // an idle timeout would never fire here
    });

    // Discriminates a SHARED deadline from a re-armed one: the header phase eats 150
    // of a 200ms budget, so a correctly shared deadline leaves the 150ms body only
    // 50ms and aborts at ~200ms total. A fresh full budget for the body would let it
    // finish and return CONTENT at ~300ms -- exactly the 'N + N' failure mode.
    it('AR5IV-SHARED the body inherits N MINUS the header time, never a second full budget', async () => {
        const { impl, state } = signalAwareFetch(150, undefined, false, 150);
        const started = Date.now();
        const out = await fetchAr5ivHtml('2607.00004', { ...FAST, timeoutMs: 200, fetch: impl });
        const elapsed = Date.now() - started;
        expect(out).toBeNull();              // a re-armed budget would have returned CONTENT
        expect(state.aborted).toBe(true);
        expect(elapsed).toBeLessThan(280);   // ~200 total, not ~300
    });

    it('AR5IV-CLEANUP the timer is cleared on success, fetch failure, body failure and timeout', async () => {
        const clears: number[] = [];
        const realClear = global.clearTimeout;
        vi.spyOn(global, 'clearTimeout').mockImplementation(((t: any) => { clears.push(1); return realClear(t); }) as any);
        await fetchAr5ivHtml('a', { ...FAST, timeoutMs: 400, fetch: signalAwareFetch(5).impl });               // success
        await fetchAr5ivHtml('b', { ...FAST, timeoutMs: 400, fetch: async () => { throw new Error('conn reset'); } }); // header failure
        await fetchAr5ivHtml('c', {                                                                             // body failure
            ...FAST, timeoutMs: 400,
            fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => { throw new Error('body broke'); } }) as any,
        });
        await fetchAr5ivHtml('d', { ...FAST, timeoutMs: 60, fetch: signalAwareFetch(500).impl });               // timeout
        expect(clears.length).toBeGreaterThanOrEqual(4); // one per path, none leaked
    });
});
