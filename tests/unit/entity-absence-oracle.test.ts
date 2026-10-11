import { describe, it, expect, beforeEach } from 'vitest';
import { resolveShardsForCandidates } from '../../src/lib/entity-absence-oracle.js';
import { _resetIdIndexForTest, loadIdIndex, isIndexWarm } from '../../src/lib/id-index-reader.js';
import { buildIndexBuffer, mockEnv } from './helpers/id-index-fixture.js';

// B4 — id-index absence oracle + index-driven candidate resolution.
//
// These tests drive resolveShardsForCandidates against a synthetic slim-v3
// id-index.bin (the SAME on-disk layout id-index-generator.js emits and
// id-index-reader.ts parses), wired through a mock env.R2_ASSETS so the reader's
// real load + binary-search path runs. The index carries a build_id (BID) and we
// pass the SAME build_id as the served manifest's -> COHERENT, so the core
// shrink/absence contract is exercised on the HIGH-fan-out (>=3 shards) awaited
// path:
//   (a) index hit  -> candidate set shrinks to the resolved shard
//   (b) all-miss   -> absenceProven, ZERO shards to probe
//   (c) index absent/refused -> fan-out parity (original order, no absence claim)
//   (f) bareword 10-shard fan-out -> zero-probe absence proof
// The FAN-OUT GATE (low-fan-out no-await + warm-peek) lives in
// entity-absence-oracle-fanout.test.ts; the COHERENCE GATE (mismatch / missing
// build_id / FALSE-404 attack) lives in entity-absence-coherence.test.ts.

const BID = 'run-1000-abc123';

describe('resolveShardsForCandidates — id-index absence oracle (coherent)', () => {
    beforeEach(() => _resetIdIndexForTest());

    it('(a) index hit probes the resolved shard FIRST, keeps the rest (ENT-503 F1), flags indexResolved', async () => {
        // The real entity "arxiv--2307.01952" lives on shard 7. The candidate
        // plan fanned out across 3 shards (>= 3 = high fan-out: oracle awaited);
        // only the resolved one should remain (coherent -> destructive shrink).
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }], BID));
        const candidates = ['2307.01952', 'arxiv--2307.01952', 'unknown--2307.01952'];
        // Pretend the caller hashed each candidate to a different shard.
        const shardForms = new Map<number, string[]>([
            [3, ['2307.01952']],
            [7, ['arxiv--2307.01952']],
            [42, ['unknown--2307.01952']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env, BID);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(false);
        // ENT-503 (review F1): non-destructive — resolved shard 7 first, nothing
        // dropped; indexResolved makes an all-shard miss a 503 at the caller.
        expect(r.orderedShards).toEqual([[7, ['arxiv--2307.01952']], [3, ['2307.01952']], [42, ['unknown--2307.01952']]]);
        expect(r.indexResolved).toBe(true);
    });

    it('(b) all candidates miss the index -> absenceProven, ZERO shards probed', async () => {
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }], BID));
        // None of these exist in the index.
        const candidates = ['9999.99999', 'arxiv--9999.99999', 'unknown--9999.99999'];
        const shardForms = new Map<number, string[]>([
            [1, ['9999.99999']],
            [2, ['arxiv--9999.99999']],
            [3, ['unknown--9999.99999']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env, BID);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(true);
        // Absence is proven WITHOUT probing any shard.
        expect(r.orderedShards).toEqual([]);
    });

    it('(c) index absent -> fan-out parity (original order, no absence claim)', async () => {
        const env = mockEnv(null); // R2 returns null -> loadIdIndex fails
        const candidates = ['9999.99999', 'arxiv--9999.99999', 'unknown--9999.99999'];
        const shardForms = new Map<number, string[]>([
            [1, ['9999.99999']],
            [2, ['arxiv--9999.99999']],
            [3, ['unknown--9999.99999']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env, BID);
        expect(r.indexLoaded).toBe(false);
        // Never assert absence when the oracle is unavailable.
        expect(r.absenceProven).toBe(false);
        // Identical to the current behavior: the original insertion order.
        expect(r.orderedShards).toEqual([
            [1, ['9999.99999']], [2, ['arxiv--9999.99999']], [3, ['unknown--9999.99999']],
        ]);
    });

    it('(c2) unreadable header (empty range body) -> fan-out parity, no absence claim', async () => {
        // ENT-503: there is no whole-blob size refusal any more (range reads);
        // a large object whose header bytes are unusable still degrades.
        const env = {
            NODE_ENV: 'production',
            R2_ASSETS: {
                get: async () => ({ size: 200 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) }),
            },
        };
        const candidates = ['anything', 'arxiv--anything', 'unknown--anything'];
        const shardForms = new Map<number, string[]>([
            [5, ['anything']], [9, ['arxiv--anything']], [12, ['unknown--anything']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env, BID);
        expect(r.indexLoaded).toBe(false);
        expect(r.absenceProven).toBe(false);
        expect(r.orderedShards).toEqual([
            [5, ['anything']], [9, ['arxiv--anything']], [12, ['unknown--anything']],
        ]);
    });

    it('fan-out 1 is never consulted, even with a cached header (ENT-503 contract)', async () => {
        // Both candidates hash to a single shard (fan-out 1): the gate skips the
        // index entirely (no I/O) — the former warm-VIEW shortcut no longer exists.
        const env = mockEnv(buildIndexBuffer([
            { form: 'meta-llama--llama-3-8b', shardIdx: 11 },
            { form: 'hf-model--meta-llama--llama-3-8b', shardIdx: 11 },
        ], BID));
        expect(await loadIdIndex(env)).toBe(true); // warm it (allowed pre-step)
        expect(isIndexWarm()).toBe(true);
        const candidates = ['meta-llama--llama-3-8b', 'hf-model--meta-llama--llama-3-8b'];
        const shardForms = new Map<number, string[]>([
            [11, ['meta-llama--llama-3-8b', 'hf-model--meta-llama--llama-3-8b']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env, BID);
        expect(r.absenceProven).toBe(false);
        expect(r.indexStatus).toBe('not_consulted');
        expect(r.orderedShards).toEqual([[11, ['meta-llama--llama-3-8b', 'hf-model--meta-llama--llama-3-8b']]]);
    });

    it('(f) fan-out >= 3 (bareword) zero-probe absence proof still works', async () => {
        // A bareword fanned out across 10 cold shards but exists in NONE: the
        // high-fan-out path awaits the oracle and proves absence with ZERO probes
        // (the paper/bareword 503 root cause). Verifies the load IS attempted.
        const env = mockEnv(buildIndexBuffer([{ form: 'real-entity', shardIdx: 4 }], BID));
        const candidates = Array.from({ length: 10 }, (_, i) => `bareword-form-${i}`);
        const shardForms = new Map<number, string[]>(
            candidates.map((c, i) => [i, [c]] as [number, string[]]),
        );
        expect(shardForms.size).toBe(10); // pre-oracle fan-out = 10 (>= 3)
        const r = await resolveShardsForCandidates(shardForms, candidates, env, BID);
        expect(env._counter.getCalls).toBeGreaterThan(0); // index lookup WAS attempted (header + windows)
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(true);
        expect(r.orderedShards).toEqual([]);
    });
});
