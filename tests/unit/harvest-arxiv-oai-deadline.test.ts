import { describe, it, expect, vi } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { ArXivAdapter } from '../../scripts/ingestion/adapters/arxiv-adapter.js';
// @ts-ignore
import { fetchOaiPage } from '../../scripts/ingestion/adapters/arxiv-oai-client.js';
// @ts-ignore
import { readBodyWithinDeadline } from '../../scripts/ingestion/adapters/arxiv-response-deadline.js';
// @ts-ignore
import { createRunScope } from '../../scripts/ingestion/adapters/arxiv-run-admission.js';
// @ts-ignore
import { TOTAL_BUDGET_MS } from '../../scripts/ingestion/adapters/arxiv-recovery-envelope.js';

// NBF-4 (OAI half) — one shared attempt deadline covering request + headers + the
// COMPLETE body. Bodies are REAL lockable ReadableStreams, the shape production
// sees; socket release is proved separately in harvest-arxiv-body-cancellation.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A response backed by a REAL, LOCKABLE ReadableStream -- the shape production sees.
 * The previous plain-object fake ({ cancel: async () => {...} }) was the INVERSE of
 * production: it could not be locked, so its cancel always "succeeded" and concealed
 * the fact that cancelling a text()-locked stream actually rejects with
 * ERR_INVALID_STATE. `state.cancelled` here flips only if the reader really cancels.
 *   mode 'complete' -> enqueues the payload and closes
 *   mode 'stall'    -> one chunk, then never another (headers arrived, body hangs)
 *   mode 'trickle'  -> a chunk every `gapMs` forever (never idle, never done)
 */
function streamResponse(mode: 'complete' | 'stall' | 'trickle', text = '<ok/>', gapMs = 10, onPull?: () => void) {
    const state = { cancelled: false, chunks: 0 };
    const bytes = new TextEncoder().encode(text);
    let sent = false;
    const stream = new ReadableStream({
        async pull(controller) {
            if (state.cancelled) return;
            if (onPull) onPull();
            if (mode === 'complete') { controller.enqueue(bytes); controller.close(); return; }
            if (!sent) { sent = true; state.chunks++; controller.enqueue(bytes); return; }
            if (mode === 'stall') return new Promise<void>(() => { /* body hangs forever */ });
            await sleep(gapMs);                       // trickle: continuous progress
            if (!state.cancelled) { state.chunks++; controller.enqueue(new TextEncoder().encode('<pad/>')); }
        },
        cancel() { state.cancelled = true; },
    });
    const response = {
        ok: true, status: 200, headers: { get: () => null }, body: stream,
        text: () => new Response(stream as any).text(),
    };
    return { response, state };
}

describe('NBF-4 — OAI: one shared attempt deadline covers request + headers + body', () => {
    // THE REVIEWER'S EXACT SCENARIO: priced 200ms, immediate headers, 900ms body.
    // Before the fix this returned a SUCCESSFUL page after ~914ms.
    it('OAI-STALL priced 200ms + 900ms stalled body -> bounded abort at ~200ms, never a ~900ms success', async () => {
        const { response, state } = streamResponse('stall');
        const started = Date.now();
        const page = await fetchOaiPage({
            fetchWithTimeout: async () => response as any,
            url: 'https://oaipmh.arxiv.org/oai?verb=ListRecords', timeoutMs: 200, headers: {},
        });
        const elapsed = Date.now() - started;
        expect(page.kind).toBe('fetch');
        expect(page.errorKind).toBe('abort');   // a TIMEOUT, not a parse failure
        expect(elapsed).toBeGreaterThanOrEqual(180);
        expect(elapsed).toBeLessThan(600);      // bounded by the 200ms attempt
        expect(state.cancelled).toBe(true);     // the reader REALLY cancelled the stream
    });

    it('OAI-SHARED the body gets N MINUS the header time, never a second full budget', async () => {
        // Header phase burns 120ms of a 200ms attempt; a 150ms body must NOT fit.
        const { response, state } = streamResponse('trickle', '<a/>', 30);
        const started = Date.now();
        const page = await fetchOaiPage({
            fetchWithTimeout: async () => { await sleep(120); return response as any; },
            url: 'u', timeoutMs: 200, headers: {},
        });
        const elapsed = Date.now() - started;
        expect(page.errorKind).toBe('abort');
        expect(state.cancelled).toBe(true);
        // STRADDLES: a shared deadline settles at ~200; giving the body a fresh full
        // 200ms budget settles at ~320. 250 sits strictly between the two.
        expect(elapsed).toBeLessThan(250);
    });

    it('OAI-OK a complete body inside the remaining window still parses to a page', async () => {
        const xml = '<?xml version="1.0"?><OAI-PMH><ListRecords></ListRecords></OAI-PMH>';
        const { response } = streamResponse('complete', xml);
        const page = await fetchOaiPage({
            fetchWithTimeout: async () => response as any, url: 'u', timeoutMs: 400, headers: {},
        });
        expect(page.kind).toBe('page');
        expect(page.listRecordsPresent).toBe(true);
    });

    it('OAI-SPENT a deadline already consumed by the header phase reads no body at all', async () => {
        let read = 0;
        const page = await fetchOaiPage({
            fetchWithTimeout: async () => ({
                ok: true, status: 200, headers: { get: () => null },
                text: async () => { read++; return '<ok/>'; }, body: { cancel: async () => {} },
            }) as any,
            url: 'u', timeoutMs: 100, headers: {},
            now: (() => { let n = 0; return () => (n += 100); })(), // header phase ate all of N
        });
        expect(page.errorKind).toBe('abort');
        expect(read).toBe(0);                   // no body read attempted past the deadline
    });

    it('OAI-BODYFAIL a body that ERRORS is a transport failure, not a deadline breach', async () => {
        const page = await fetchOaiPage({
            fetchWithTimeout: async () => ({
                ok: true, status: 200, headers: { get: () => null },
                text: async () => { throw new Error('socket hang up'); },
            }) as any,
            url: 'u', timeoutMs: 400, headers: {},
        });
        expect(page.kind).toBe('fetch');
        expect(page.errorKind).toBe('fetch');   // retryable transport error, not 'abort'
    });

    // A body deadline breach is a first-class attempt failure. It emits the IDENTICAL
    // contract a header-phase abort emits -- {kind:'fetch', errorKind:'abort'} -- so
    // the arbiter's DECISIONS transfer unchanged. Scope of that claim, stated
    // precisely after BLOCKING-1: value-equivalence transfers the decisions, NOT the
    // runtime resource behaviour. Socket release is a separate property and is proved
    // separately, by execution, in harvest-arxiv-body-cancellation.test.ts.
    it('OAI-ARBITER a body deadline breach is routed BY THE ARBITER, proven by execution', async () => {
        const adapter: any = new ArXivAdapter();
        process.env.ENABLE_AR5IV = 'false';
        const urls: string[] = [];
        const batches: string[][] = [];
        const timeouts: number[] = [];
        // Fake arbiter clock so the attempt window clips to a testable 250ms via the
        // remaining transport budget; the BODY deadline itself uses real timers, so a
        // real trickling body genuinely breaches a real 250ms window.
        let t = 0;
        const clock: any = { now: () => t, sleep: async () => undefined, runScope: createRunScope() };
        clock.runScope.startedAtMs = 0;
        vi.spyOn(adapter, 'delay').mockResolvedValue(undefined);
        vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(async (url: string, _o: any, ms: number) => {
            urls.push(url);
            if (url.includes('resumptionToken')) {
                timeouts.push(ms);
                // Advance the arbiter's fake clock from inside the stream's pull, i.e.
                // DURING the body read, so elapsedTransportMs can isolate body time.
                const deep = streamResponse('trickle', '<a/>', 20, () => { t += 40; });
                return deep.response as any;
            }
            t += TOTAL_BUDGET_MS - 250; // leave a 250ms attempt window for the deep token
            return streamResponse('complete',
                '<?xml version="1.0"?><OAI-PMH><ListRecords><record><header><datestamp>2026-07-01</datestamp>' +
                '</header><metadata><arXiv><id>bd.1</id><categories>cs.LG</categories><title>T</title>' +
                '<abstract>A</abstract></arXiv></metadata></record><resumptionToken>TOK-BD</resumptionToken>' +
                '</ListRecords></OAI-PMH>').response as any;
        });
        let err: any = null;
        try {
            await adapter.fetchOAI({ limit: 1000, from: '2026-07-01', onBatch: async (b: any[]) => { batches.push(b.map((x) => x.arxiv_id)); } }, clock);
        } catch (e) { err = e; }
        expect(timeouts).toEqual([250]);                    // window clipped by the budget
        // EXECUTION-PROVEN ROUTING: the body breach entered the fetch branch, was
        // recorded as a slow-tail 'abort', and the SINGLE arbiter chose the terminal
        // (here: the 60000ms backoff cannot fit the 250ms budget remainder).
        expect(err.meta.last_error_kind).toBe('abort');     // recordAttemptFailure saw 'abort'
        expect(err.meta.terminal).toBe('TOTAL_BUDGET_EXHAUSTED'); // the arbiter decided this
        expect(batches).toEqual([['bd.1']]);                // failed page NEVER committed
        // Page 1's mock advanced the clock by TOTAL_BUDGET_MS-250 inside its own span,
        // so ONLY a figure strictly above that can come from the deep token's BODY read.
        expect(err.meta.elapsedTransportMs).toBeGreaterThan(TOTAL_BUDGET_MS - 250);
    }, 20000);

    // M36: the reader pump replaced response.text(), so decoding is ours now. It
    // concatenates ALL chunks and decodes ONCE. A future "simplification" to
    // per-chunk decoding silently reintroduces classic split-multibyte corruption,
    // because a UTF-8 sequence straddling a chunk boundary decodes to U+FFFD on both
    // sides. Split a 3-byte char 1/2 and a 4-byte emoji 2/2 to pin concat-then-decode.
    it('DECODE a multi-byte character split across chunk boundaries survives intact', async () => {
        const text = '<a>€ 🙂</a>';                       // U+20AC (3 bytes), U+1F642 (4 bytes)
        const bytes = new TextEncoder().encode(text);
        const euro = text.indexOf('€');
        const emoji = text.indexOf('🙂');
        // Byte offsets that fall INSIDE each multi-byte sequence.
        const cuts = [euro + 1, euro + 3 + 1 + 2];        // 1|2 through €, 2|2 through 🙂
        let i = 0;
        const boundaries = [...cuts, bytes.length];
        const stream = new ReadableStream({
            pull(controller) {
                if (i >= bytes.length) { controller.close(); return; }
                const next = boundaries.find((b) => b > i) ?? bytes.length;
                controller.enqueue(bytes.slice(i, next));
                i = next;
            },
        });
        const out = await readBodyWithinDeadline({
            response: { body: stream } as any, remainingMs: 2000,
        });
        expect(out.ok).toBe(true);
        expect(out.text).toBe(text);                      // byte-identical round trip
        expect(out.text).toContain('€');
        expect(out.text).toContain('🙂');
        expect(out.text).not.toContain('�');         // no replacement characters
    });

    it('DEADLINE-PRIMITIVE clears its timer on every path and never leaves an unhandled rejection', async () => {
        const cleared: any[] = [];
        const timers = { setTimeout, clearTimeout: (t: any) => { cleared.push(t); clearTimeout(t); } };
        const ok = await readBodyWithinDeadline({ response: { text: async () => 'x' } as any, remainingMs: 200, timers });
        expect(ok).toEqual({ ok: true, text: 'x' });
        const late = streamResponse('stall');
        const timedOut = await readBodyWithinDeadline({ response: late.response as any, remainingMs: 80, timers });
        expect(timedOut.ok).toBe(false);
        expect(timedOut.errorKind).toBe('abort');
        const broke = await readBodyWithinDeadline({ response: { text: async () => { throw new Error('x'); } } as any, remainingMs: 200, timers });
        expect(broke.errorKind).toBe('fetch');
        expect(cleared.length).toBe(3);         // success + timeout + body failure
        await sleep(420);                       // the abandoned body settles late...
        expect(true).toBe(true);                // ...with no unhandled rejection (vitest fails the run otherwise)
    });
});
