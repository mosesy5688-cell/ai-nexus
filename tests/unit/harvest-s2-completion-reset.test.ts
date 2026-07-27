import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The NDJSON bridge is mocked so this suite can PROVE it is not reached on an
// incomplete run (the gate must sit above it), without writing shard files.
vi.mock('../../scripts/ingestion/ndjson-sharder.js', () => ({
    shardNDJSON: vi.fn(async () => ({ shards: 0 })),
}));

// @ts-ignore -- JS ESM modules (no .d.ts); tested for their runtime contract.
import { shardNDJSON } from '../../scripts/ingestion/ndjson-sharder.js';
// @ts-ignore
import { SemanticScholarAdapter } from '../../scripts/ingestion/adapters/semanticscholar-adapter.js';
// @ts-ignore
import { RateLimitExceededError, FetchError } from '../../scripts/ingestion/adapters/base-adapter.js';
// @ts-ignore
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';
// @ts-ignore
import { COMPLETION_STATUS, TERMINATION_REASON, isComplete, buildCompletionRecord, evaluateCompletionGate } from '../../scripts/ingestion/harvest-completion.js';
// @ts-ignore
import { TERMINAL, TOTAL_RETRY_BUDGET_MS } from '../../scripts/ingestion/adapters/s2-retry-envelope.js';
// @ts-ignore
import { DEFAULT_FLOORS } from '../../scripts/ingestion/harvest-floors.js';

// Founder ruling, 2026-07-26 (Factory 1/4 S2 incident, run 30189935455).
//
// A required source that abandoned planned work must satisfy ALL FOUR of:
//     mark incomplete  AND  exit non-zero  AND  block bridge  AND  block authority
// Marking `terminalMeta`/`partial` while still exiting 0 is NOT a repair -- that is
// exactly the hole, because the bridge and the (non-`always()`) R2 source-authority
// step then run and publish a partial harvest as the authoritative record.
//
// THIS FILE covers STALE COMPLETION STATE. adapters/index.js holds ONE adapter
// instance per process, so a completion claim from an earlier fetch() must never
// survive into a later one -- in either direction. A leaked `complete` would let a
// partial run publish; a leaked `incomplete` would redden a healthy run. Split from
// harvest-s2-completeness.test.ts to stay under the CES 250-line ceiling.

function page(ids: string[], token: string | null = null) {
    return { total: ids.length, token, data: ids.map((id) => ({ paperId: id, title: `T ${id}`, abstract: 'a' })) };
}
const ok = (body: any) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, headers: { get: () => null } });
const bad = (status: number) => ({ ok: false, status, statusText: `E${status}`, json: async () => ({}), headers: { get: () => null } });

function rows(topic: string, n: number) {
    return page(Array.from({ length: n }, (_, i) => `${topic}-${i}`));
}

function fastAdapter() {
    const a: any = new SemanticScholarAdapter();
    a.retryDeps = { sleep: async () => undefined };
    vi.spyOn(a, 'delay').mockResolvedValue(undefined as any);
    return a;
}

function captureSidecars() {
    const seen: any[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
        const f = typeof args[0] === 'string' ? args[0] : '';
        if (f.startsWith('HARVEST_STATE ')) seen.push(JSON.parse(f.slice('HARVEST_STATE '.length)));
    });
    return { seen, spy };
}

/** Run the REAL S2 adapter through the REAL chokepoint. Bridge NOT skipped. */
async function run(mock: (url: any) => Promise<any>, limit: number, adapter = fastAdapter()) {
    vi.spyOn(adapter, 'fetchWithTimeout').mockImplementation(mock as any);
    const cap = captureSidecars();
    const result = await harvestSingle('semanticscholar', { limit, _adapter: adapter });
    cap.spy.mockRestore();
    return { result, sidecar: cap.seen[cap.seen.length - 1], adapter };
}

const topicOf = (url: any) => decodeURIComponent(String(url).match(/query=([^&]+)/)![1]);
describe('S2 completion state is per-invocation, never carried over', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    // ---- STALE STATE -----------------------------------------------------
    it('completion state is RESET per fetch() -- a stale claim never leaks into a fresh run', async () => {
        const adapter = fastAdapter();
        const healthy = ['machine learning', 'artificial intelligence', 'nlp'];
        const f = vi.spyOn(adapter, 'fetchWithTimeout');

        // Run 1: incomplete (topic 4 fails) on the SAME singleton instance.
        f.mockImplementation(async (url: any) => (healthy.includes(topicOf(url)) ? ok(rows(topicOf(url), 10)) : bad(500)) as any);
        await adapter.fetch({ limit: 4000 }).catch(() => undefined);
        expect(adapter.completion.completion_status).toBe(COMPLETION_STATUS.INCOMPLETE);

        // Run 2: fully healthy. It must NOT inherit the previous incompleteness.
        f.mockImplementation(async (url: any) => ok(rows(topicOf(url), 10)) as any);
        await adapter.fetch({ limit: 4000 });
        expect(adapter.completion.completion_status).toBe(COMPLETION_STATUS.COMPLETE);
        expect(adapter.completion.completed_topics).toBe(4);
        expect(adapter.completion.failed_topic).toBeNull();
        expect(adapter.terminalMeta).toBeNull();
    });

    it('and the reverse: a COMPLETE claim never leaks into a later incomplete run', async () => {
        const adapter = fastAdapter();
        const f = vi.spyOn(adapter, 'fetchWithTimeout');
        f.mockImplementation(async (url: any) => ok(rows(topicOf(url), 10)) as any);
        await adapter.fetch({ limit: 4000 });
        expect(adapter.completion.completion_status).toBe(COMPLETION_STATUS.COMPLETE);

        const healthy = ['machine learning'];
        f.mockImplementation(async (url: any) => (healthy.includes(topicOf(url)) ? ok(rows(topicOf(url), 10)) : bad(500)) as any);
        await adapter.fetch({ limit: 4000 }).catch(() => undefined);
        expect(adapter.completion.completion_status).toBe(COMPLETION_STATUS.INCOMPLETE);
        expect(adapter.completion.completed_topics).toBe(1);
    });
});
