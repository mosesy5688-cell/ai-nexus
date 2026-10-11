import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { lookupForms, _resetIdIndexForTest, MAX_WINDOW_ENTRIES } from '../../src/lib/id-index-reader.js';
import { MAX_PLAN_FORMS, MAX_READ_PARALLELISM, TRANSIENT_BYTES_MAX } from '../../src/lib/id-index-budget.js';
import { resolveShardsForCandidates, describeResolution } from '../../src/lib/entity-absence-oracle.js';
import { buildIndexBuffer } from './helpers/id-index-fixture.js';
import { mockRangeR2 } from './helpers/ent503-range-r2.js';

// ENT-503 review M3: per-lookup read parallelism is bounded (live bytes <=
// MAX_READ_PARALLELISM x W x 12 B) and a version-change retry never overlaps the
// first attempt's reads; plus the early-warning fields / budget marker.

const BID = 'run-500-aaa';
const N = 40_000;
const OLD_CAP = 30 * 1024 * 1024;
let BIG: ArrayBuffer;
const present = (i: number) => `hf-model--org--entity-${i}`;
beforeAll(() => {
    BIG = buildIndexBuffer(Array.from({ length: N }, (_, i) => ({ form: present(i), shardIdx: i % 96 })), BID);
});
const envWith = (r2: ReturnType<typeof mockRangeR2>) => ({ NODE_ENV: 'production', R2_ASSETS: r2 });

describe('ENT-503 review M3: bounded read parallelism, no overlapping attempts', () => {
    // Wrap the mock binding: every GET takes a few ms; track in-flight reads and
    // record the max concurrency and whether a header (retry) read started while
    // first-attempt window reads were still in flight.
    function instrumented(r2: ReturnType<typeof mockRangeR2>) {
        const st = { inflight: 0, max: 0, headWhileWindowsInflight: false, windowsInflight: 0 };
        const inner = r2.get;
        const get = async (key: string, opts?: any) => {
            const isWindow = (opts?.range?.offset ?? 0) > 0;
            if (!isWindow && st.windowsInflight > 0) st.headWhileWindowsInflight = true;
            st.inflight++; if (isWindow) st.windowsInflight++;
            st.max = Math.max(st.max, st.inflight);
            try { await new Promise(r => setTimeout(r, 3)); return await inner(key, opts); }
            finally { st.inflight--; if (isWindow) st.windowsInflight--; }
        };
        return { env: { NODE_ENV: 'production', R2_ASSETS: { get } }, st };
    }
    beforeEach(() => { _resetIdIndexForTest(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

    it('at most MAX_READ_PARALLELISM reads in flight for a 16-form lookup', async () => {
        const r2 = mockRangeR2();
        r2.publish(BIG, 'etag-p', OLD_CAP + 1);
        const { env, st } = instrumented(r2);
        const forms = Array.from({ length: MAX_PLAN_FORMS }, (_, i) => (i % 2 ? present(i * 7) : `nope-${i}`));
        const res = await lookupForms(env, forms);
        expect(res.status).toBe('ok');
        expect(st.max).toBeLessThanOrEqual(MAX_READ_PARALLELISM);
        expect(TRANSIENT_BYTES_MAX).toBe(MAX_READ_PARALLELISM * MAX_WINDOW_ENTRIES * 12);
    });

    it('version-change retry starts only after the first attempt reads settled', async () => {
        const r2 = mockRangeR2();
        r2.publish(BIG, 'etag-q', OLD_CAP + 1);
        let flipped = false;
        r2.beforeServe = (g) => { if (!flipped && g.offset !== null && g.offset > 0) { flipped = true; r2.publish(BIG, 'etag-r', OLD_CAP + 1); } };
        const { env, st } = instrumented(r2);
        const forms = Array.from({ length: 12 }, (_, i) => `nope-${i}`);
        const res = await lookupForms(env, forms);
        expect(res.status).toBe('ok');
        expect(st.headWhileWindowsInflight).toBe(false);
    });

    it('early-warning fields: reads / rounds / window are reported', async () => {
        const r2 = mockRangeR2();
        r2.publish(BIG, 'etag-s', OLD_CAP + 1);
        const res = await lookupForms(envWith(r2), ['nope-a', present(9)]);
        expect(res.reads).toBe(1 + 2 + 1); // head + 2 windows + 1 record
        expect(res.rounds).toBe(1);
        expect(res.window).toBeGreaterThan(0);
        expect(res.window).toBeLessThanOrEqual(MAX_WINDOW_ENTRIES);
    });

    it('over_budget is explicitly marked in the oracle log string', async () => {
        const r2 = mockRangeR2();
        r2.publish(BIG, 'etag-t', OLD_CAP + 1);
        const forms = Array.from({ length: MAX_PLAN_FORMS + 1 }, (_, i) => `f-${i}`);
        const sf = new Map<number, string[]>(forms.map((f, i) => [i, [f]] as [number, string[]]));
        const r = await resolveShardsForCandidates(sf, forms, envWith(r2), BID);
        expect(r.indexStatus).toBe('over_budget');
        expect(describeResolution(r)).toMatch(/br=I-3\/- .*ird=0 irnd=0 iwin=0 IDX_BUDGET_EXCEEDED=over_budget/);
    });
});

