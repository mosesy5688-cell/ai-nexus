import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The bridge is mocked so this file can show the green-log claim in ISOLATION from
// the bridge claim: under the O7 mutation the bridge stays blocked and ONLY the
// green-line assertion goes red.
vi.mock('../../scripts/ingestion/ndjson-sharder.js', () => ({
    shardNDJSON: vi.fn(async () => ({ shards: 0 })),
}));

// @ts-ignore -- JS ESM modules (no .d.ts); tested for their runtime contract.
import { shardNDJSON } from '../../scripts/ingestion/ndjson-sharder.js';
// @ts-ignore
import { SemanticScholarAdapter } from '../../scripts/ingestion/adapters/semanticscholar-adapter.js';
// @ts-ignore
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';

// O7 — THE GREEN-LOG HALF OF THE COMPLETENESS GATE.
//
// The gate must sit above THREE things: the green "Complete" log, the NDJSON bridge,
// and the success return. The existing M2 mutation only pins the bridge, so the log
// half was unguarded: a gate positioned between the green line and the bridge would
// still have blocked publication while telling the operator, in the run log, that the
// harvest completed. A run that abandoned a quarter of its planned work must never
// print a line that says it finished.
//
// Both directions are asserted. A negative-only guard would be satisfied by a gate
// that never prints the line at all, so the POSITIVE CONTROL below proves the line is
// genuinely emitted on a healthy run and that the negative case means something.

const GREEN_LINE = /✅ \[Harvest\] Complete/;

function page(ids: string[], token: string | null = null) {
    return { total: ids.length, token, data: ids.map((id) => ({ paperId: id, title: `T ${id}`, abstract: 'a' })) };
}
const ok = (body: any) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, headers: { get: () => null } });
const bad = (status: number) => ({ ok: false, status, statusText: `E${status}`, json: async () => ({}), headers: { get: () => null } });
const rows = (topic: string, n: number) => page(Array.from({ length: n }, (_, i) => `${topic}-${i}`));
const topicOf = (url: any) => decodeURIComponent(String(url).match(/query=([^&]+)/)![1]);

/** Run the REAL adapter through the REAL chokepoint, capturing EVERY stdout line. */
async function runCapturingLog(mock: (url: any) => Promise<any>, limit: number) {
    const adapter: any = new SemanticScholarAdapter();
    adapter.retryDeps = { sleep: async () => undefined };
    vi.spyOn(adapter, 'delay').mockResolvedValue(undefined as any);
    vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(mock as any);

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
        lines.push(args.map((a) => String(a)).join(' '));
    });
    const result = await harvestSingle('semanticscholar', { limit, _adapter: adapter });
    spy.mockRestore();
    return { result, lines, adapter };
}

describe('O7 — the green "Complete" log is gated on completeness', () => {
    beforeEach(() => {
        (shardNDJSON as any).mockClear();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('INCOMPLETE (3/4 topics, 2,250 rows) does NOT print the green Complete line', async () => {
        const healthy = ['machine learning', 'artificial intelligence', 'nlp'];
        const { result, lines } = await runCapturingLog(async (url) => {
            const t = topicOf(url);
            return healthy.includes(t) ? ok(rows(t, 750)) : bad(500);
        }, 4000);

        const green = lines.filter((l) => GREEN_LINE.test(l));
        expect(green, `green Complete line printed on an INCOMPLETE harvest: ${JSON.stringify(green)}`).toHaveLength(0);
        // The run really did reach the gate with a real partial yield -- not a vacuous pass.
        expect(result.error).toBeTruthy();
        expect(result.count).toBe(2250);
        // Isolation: the bridge claim is asserted separately, so a mutation that moves
        // the gate below the log but above the bridge reddens ONLY the assertion above.
        expect(shardNDJSON).not.toHaveBeenCalled();
    });

    it('INCOMPLETE via a NON-hard stop (rate-limit breaker) also prints no green line', async () => {
        const healthy = ['machine learning', 'artificial intelligence', 'nlp'];
        const adapterSpy = vi.spyOn(SemanticScholarAdapter.prototype as any, 'handleRateLimit')
            .mockImplementation(async () => {
                const { RateLimitExceededError } = await import('../../scripts/ingestion/adapters/base-adapter.js');
                throw new RateLimitExceededError('semanticscholar', '6 attempts');
            });
        const { result, lines } = await runCapturingLog(async (url) => {
            const t = topicOf(url);
            return healthy.includes(t) ? ok(rows(t, 750)) : bad(429);
        }, 4000);
        adapterSpy.mockRestore();

        expect(lines.filter((l) => GREEN_LINE.test(l))).toHaveLength(0);
        expect(result.error).toBeTruthy();
        expect(result.count).toBe(2250);
    });

    it('POSITIVE CONTROL — a genuinely COMPLETE harvest DOES print the green Complete line', async () => {
        const { result, lines } = await runCapturingLog(async (url) => ok(rows(topicOf(url), 400)), 4000);

        expect(lines.filter((l) => GREEN_LINE.test(l)).length).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();
        expect(result.count).toBe(1600);
        // ...and the same run does reach the bridge, proving the ordering claim end to end.
        expect(shardNDJSON).toHaveBeenCalled();
    });

    it('POSITIVE CONTROL — limit satisfied early is also COMPLETE and prints the green line', async () => {
        const { result, lines } = await runCapturingLog(async (url) => ok(rows(topicOf(url), 600)), 500);
        expect(lines.filter((l) => GREEN_LINE.test(l)).length).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();
    });
});
