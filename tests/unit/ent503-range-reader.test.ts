import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { lookupForms, _resetIdIndexForTest, isIndexWarm, MAX_WINDOW_ENTRIES, MAX_INDEX_READS } from '../../src/lib/id-index-reader.js';
import { INDEX_BYTES_CEILING, KEY_COUNT_CEILING, MAX_PLAN_FORMS } from '../../src/lib/id-index-budget.js';
import { resolveShardsForCandidates, INDEX_LOAD_TIMEOUT_MS } from '../../src/lib/entity-absence-oracle.js';
import { buildIndexBuffer } from './helpers/id-index-fixture.js';
import { mockRangeR2 } from './helpers/ent503-range-r2.js';

// ENT-503 (I-1): the whole-blob reader refused data/id-index.bin once it grew
// past 30 MB (31,499,992 B on 2026-10-08), so the absence oracle never loaded.
// The range reader never materializes the index; these tests pin: correctness
// of the interpolation search on a key table LARGER than one window, bounded
// per-read size, etag pinning across reads, and every failure -> degrade.

const BID = 'run-500-aaa';
const N = 40_000; // > MAX_WINDOW_ENTRIES so interpolation (not a full read) runs
const OLD_CAP = 30 * 1024 * 1024;
let BIG: ArrayBuffer;
const present = (i: number) => `hf-model--org--entity-${i}`;
const shardOf = (i: number) => i % 96;

beforeAll(() => {
    BIG = buildIndexBuffer(Array.from({ length: N }, (_, i) => ({ form: present(i), shardIdx: shardOf(i) })), BID);
});

function envWith(r2: ReturnType<typeof mockRangeR2>) {
    return { NODE_ENV: 'production', R2_ASSETS: r2 };
}

describe('ENT-503 range-read id-index reader', () => {
    let r2: ReturnType<typeof mockRangeR2>;
    beforeEach(() => {
        _resetIdIndexForTest();
        r2 = mockRangeR2();
        // Declared size above the OLD 30 MB cap: the production-today condition.
        r2.publish(BIG, 'etag-1', OLD_CAP + 2_000_000);
    });

    it('object larger than the old 30 MB cap is used; present forms resolve to the right shard', async () => {
        expect(N).toBeGreaterThan(MAX_WINDOW_ENTRIES);
        const forms = [0, 1, 777, 12_345, 39_999].map(present);
        const res = await lookupForms(envWith(r2), forms);
        expect(res.status).toBe('ok');
        expect(res.buildId).toBe(BID);
        expect(res.size).toBe(OLD_CAP + 2_000_000);
        for (const i of [0, 1, 777, 12_345, 39_999]) expect(res.hits.get(present(i))?.shardIdx).toBe(shardOf(i));
    });

    it('absent forms are definite misses; every read is bounded and etag-pinned', async () => {
        const forms = Array.from({ length: 16 }, (_, i) => `__reliability_probe_${i}__`); // = MAX_PLAN_FORMS
        const res = await lookupForms(envWith(r2), forms);
        expect(res.status).toBe('ok');
        for (const f of forms) expect(res.hits.get(f)).toBeNull();
        const ranged = r2.gets.filter(g => g.offset !== null && g.offset > 0);
        for (const g of ranged) {
            expect(g.etagMatches).toBe('etag-1');                     // pinned to the header version
            expect(g.length!).toBeLessThanOrEqual(MAX_WINDOW_ENTRIES * 12 + 12); // bounded transient memory
        }
        // ~1 window read per form (3-sigma window brackets almost always).
        expect(ranged.length).toBeLessThanOrEqual(forms.length * 2);
    });

    it('a sweep of present + absent forms matches a brute-force oracle exactly', async () => {
        // Chunks of 8 present + 8 absent (16 = MAX_PLAN_FORMS per lookup).
        for (let c = 0; c < 300; c += 8) {
            const ps = Array.from({ length: 8 }, (_, k) => present(((c + k) * 131) % N));
            const ns = Array.from({ length: 8 }, (_, k) => `nope-${c + k}`);
            const res = await lookupForms(envWith(r2), [...ps, ...ns]);
            expect(res.status).toBe('ok');
            for (const f of ps) expect(res.hits.get(f)).not.toBeNull();
            for (const f of ns) expect(res.hits.get(f)).toBeNull();
        }
    });

    it('object replaced mid-lookup -> retried against ONE new version (never mixed)', async () => {
        const B2 = buildIndexBuffer([{ form: present(5), shardIdx: 77 }], 'run-501-bbb');
        let flipped = false;
        r2.beforeServe = (g) => { if (!flipped && g.offset !== null && g.offset > 0) { flipped = true; r2.publish(B2, 'etag-2'); } };
        const res = await lookupForms(envWith(r2), [present(5)]);
        expect(res.status).toBe('ok');
        expect(res.buildId).toBe('run-501-bbb');           // header + windows of the SAME version
        expect(res.hits.get(present(5))?.shardIdx).toBe(77);
    });

    it('object replaced on every read -> version_changed -> oracle degrades (no absence)', async () => {
        let n = 0;
        r2.beforeServe = (g) => { if (g.offset !== null && g.offset > 0) r2.publish(BIG, `etag-x${++n}`, OLD_CAP + 2_000_000); };
        const sf = new Map<number, string[]>([[1, ['a-x']], [2, ['b-x']], [3, ['c-x']]]);
        const r = await resolveShardsForCandidates(sf, ['a-x', 'b-x', 'c-x'], envWith(r2), BID);
        expect(r.indexStatus).toBe('version_changed');
        expect(r.absenceProven).toBe(false);
        expect(r.orderedShards.length).toBe(3);
    });

    it('range read error -> r2_error degrade; cached header is kept (usable resource not dropped)', async () => {
        await lookupForms(envWith(r2), [present(1)]);
        expect(isIndexWarm()).toBe(true);
        r2.failIf = (g) => g.offset !== null && g.offset > 0;
        const sf = new Map<number, string[]>([[1, ['a-x']], [2, ['b-x']], [3, ['c-x']]]);
        const r = await resolveShardsForCandidates(sf, ['a-x', 'b-x', 'c-x'], envWith(r2), BID);
        expect(r.indexStatus).toBe('r2_error');
        expect(r.absenceProven).toBe(false);
        expect(isIndexWarm()).toBe(true);
    });

    it('bad header -> bad_header degrade; absent object -> absent degrade', async () => {
        r2.publish(new ArrayBuffer(64), 'etag-bad');
        expect((await lookupForms(envWith(r2), ['x'])).status).toBe('bad_header');
        r2.publish(null, 'none');
        expect((await lookupForms(envWith(r2), ['x'])).status).toBe('absent');
    });

    it('a never-settling read times out at the EXISTING deadline and orphans nothing shared', async () => {
        await lookupForms(envWith(r2), [present(1)]); // header cached
        r2.hangIf = (g) => g.offset !== null && g.offset > 0;
        const sf = new Map<number, string[]>([[1, ['a-x']], [2, ['b-x']], [3, ['c-x']]]);
        const t0 = Date.now();
        const r = await resolveShardsForCandidates(sf, ['a-x', 'b-x', 'c-x'], envWith(r2), BID);
        expect(r.indexStatus).toBe('timeout');
        expect(r.absenceProven).toBe(false);
        expect(Date.now() - t0).toBeLessThan(INDEX_LOAD_TIMEOUT_MS + 1000);
        // Next request: reads healthy again -> completes immediately, no waiting on
        // the hung one (no shared in-flight promise exists).
        r2.hangIf = null;
        const t1 = Date.now();
        const r2nd = await resolveShardsForCandidates(sf, ['a-x', 'b-x', 'c-x'], envWith(r2), BID);
        expect(r2nd.indexStatus).toBe('ok');
        expect(r2nd.absenceProven).toBe(true);
        expect(Date.now() - t1).toBeLessThan(500);
    }, 10_000);
});

// Silence the reader's warn lines in this file.
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('ENT-503 v127/review follow-ups (range reader)', () => {
    let r2: ReturnType<typeof mockRangeR2>;
    let warn: any;
    beforeEach(() => {
        _resetIdIndexForTest();
        r2 = mockRangeR2();
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    const lines = () => warn.mock.calls.map((c: any[]) => c.join(' '));

    it('review F1: object without an etag FAILS CLOSED (no unpinned window read) -> no_etag', async () => {
        r2.publish(BIG, '', OLD_CAP + 1);
        const res = await lookupForms(envWith(r2), ['x', present(3)]);
        expect(res.status).toBe('no_etag');
        expect(r2.gets.filter(g => g.offset !== null && g.offset > 0).length).toBe(0);
    });

    it('v127 f4(iv): size = derived ceiling + 1 B -> refused, refusing line, zero window reads', async () => {
        r2.publish(BIG, 'etag-c', INDEX_BYTES_CEILING + 1);
        const res = await lookupForms(envWith(r2), ['x']);
        expect(res.status).toBe('refused');
        expect(res.size).toBe(INDEX_BYTES_CEILING + 1);
        expect(lines().some((l: string) => l.includes('[IdIndex] refusing index') && l.includes(`size=${INDEX_BYTES_CEILING + 1}`) && l.includes(`ceiling ${INDEX_BYTES_CEILING}`))).toBe(true);
        expect(r2.gets.filter(g => g.offset !== null && g.offset > 0).length).toBe(0);
        // Same version again: re-checked (one head read), no repeated refusing line.
        await lookupForms(envWith(r2), ['x']);
        expect(lines().filter((l: string) => l.includes('refusing index')).length).toBe(1);
        // Producer shrinks/replaces the index -> picked up on the next lookup.
        r2.publish(BIG, 'etag-d', OLD_CAP + 1);
        expect((await lookupForms(envWith(r2), ['x'])).status).toBe('ok');
    });

    it('size exactly AT the ceiling is served (boundary); >= 80% emits the warn line with remaining', async () => {
        r2.publish(BIG, 'etag-e', INDEX_BYTES_CEILING);
        expect((await lookupForms(envWith(r2), ['x'])).status).toBe('ok');
        const l = lines().find((x: string) => x.includes('approaching ceiling'));
        expect(l).toContain(`size=${INDEX_BYTES_CEILING} B ceiling=${INDEX_BYTES_CEILING} B remaining=0 B`);
    });

    it('derived constants: ceiling and read cap follow from the window budget', () => {
        expect(KEY_COUNT_CEILING).toBe(Math.floor(((MAX_WINDOW_ENTRIES - 64) / 3) ** 2));
        expect(INDEX_BYTES_CEILING).toBe(256 + KEY_COUNT_CEILING * 20);
        expect(MAX_INDEX_READS).toBe(2 * (2 + MAX_PLAN_FORMS + 4));
        expect(OLD_CAP + 209_000).toBeLessThan(INDEX_BYTES_CEILING * 0.8); // production today well under warn
    });

    it('more forms than MAX_PLAN_FORMS -> over_budget (no reads); oracle degrades', async () => {
        r2.publish(BIG, 'etag-f', OLD_CAP + 1);
        const forms = Array.from({ length: MAX_PLAN_FORMS + 1 }, (_, i) => `f-${i}`);
        expect((await lookupForms(envWith(r2), forms)).status).toBe('over_budget');
        expect(r2.gets.length).toBe(0);
    });

    it('v127 f3: a version change whose replacement is unreadable keeps the cached header', async () => {
        r2.publish(BIG, 'etag-g', OLD_CAP + 1);
        await lookupForms(envWith(r2), ['x']);
        expect(isIndexWarm()).toBe(true);
        r2.beforeServe = (g) => { if (g.offset !== null && g.offset > 0) r2.publish(null, 'gone'); };
        const res = await lookupForms(envWith(r2), [present(2)]);
        expect(res.status).not.toBe('ok');
        expect(isIndexWarm()).toBe(true); // not discarded before a replacement parsed
    });

    it('review F3: a coherent NON-ASCII hit does not set indexResolved (no permanent 503 trap)', async () => {
        const buf = buildIndexBuffer([{ form: 'org--caf\u00e9', shardIdx: 4 }], BID);
        r2.publish(buf, 'etag-h');
        const sf = new Map<number, string[]>([[4, ['org--caf\u00e9']], [5, ['a-x']], [6, ['b-x']]]);
        const r = await resolveShardsForCandidates(sf, ['org--caf\u00e9', 'a-x', 'b-x'], envWith(r2), BID);
        expect(r.coherent).toBe(true);
        expect(r.indexResolved).toBe(false);
        expect(r.orderedShards[0][0]).toBe(4);
    });
});
