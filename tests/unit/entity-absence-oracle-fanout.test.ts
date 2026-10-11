import { describe, it, expect, beforeEach } from 'vitest';
import { resolveShardsForCandidates } from '../../src/lib/entity-absence-oracle.js';
import { _resetIdIndexForTest, isIndexWarm } from '../../src/lib/id-index-reader.js';
import { buildIndexBuffer, mockEnv, warmIndex } from './helpers/id-index-fixture.js';

// FAN-OUT-GATED ORACLE AWAIT (B4 regression fix).
//
// #2174's absence oracle awaited a bounded id-index load INSIDE the probe budget
// on every lookup. On a COLD isolate that ~24 MB R2 fetch ate up to 2.5s of the
// 6s budget, starving the cold shard opens of LOW-fan-out lookups (canonical-id
// 2 shards, model-page slug 1 candidate) -> they regressed to 503. The fix gates
// the await on the PRE-oracle unique shard fan-out (distinct shards across all
// candidates, BEFORE any oracle consultation — never post-shrink):
//   (d) fan-out <= 2 + COLD index  -> NO load attempted (R2 never touched),
//       degrade exactly: original order, full candidate set, no absence claim.
//   (e) fan-out <= 2 + index WARM   -> shrink/absence MAY apply with no await and
//       no new I/O (the warm peek is free).
// High-fan-out (>=3) await + the core oracle contract live in
// entity-absence-oracle.test.ts.

const BID = 'run-2000-def456';

describe('resolveShardsForCandidates — fan-out-gated oracle await', () => {
    beforeEach(() => _resetIdIndexForTest());

    it('(d) fan-out <= 2 + COLD index -> NO load attempted, degrade exactly', async () => {
        // A real low-fan-out lookup (canonical id -> 2 shards) on a COLD isolate.
        // The gate must NOT pay the index's cold load: R2 is never touched, the
        // full candidate set is probed in original order, no absence is claimed.
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }], BID));
        expect(isIndexWarm()).toBe(false); // cold (beforeEach reset)
        const candidates = ['2307.01952', 'arxiv--2307.01952'];
        const shardForms = new Map<number, string[]>([
            [3, ['2307.01952']],
            [7, ['arxiv--2307.01952']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env, BID);
        // No R2 GET happened: the cold load was never attempted.
        expect(env._counter.getCalls).toBe(0);
        expect(isIndexWarm()).toBe(false); // still cold — we never loaded it
        // Old-path result: index "unavailable", full fan-out, original order.
        expect(r.indexLoaded).toBe(false);
        expect(r.absenceProven).toBe(false);
        expect(r.orderedShards).toEqual([[3, ['2307.01952']], [7, ['arxiv--2307.01952']]]);
    });

    it('(d2) fan-out 1 (single-candidate model slug) + COLD index -> NO load, parity', async () => {
        // A model-page slug = 1 candidate = 1 shard: the canonical low-fan-out
        // regression case. Cold gate must skip the load and pass it through.
        const env = mockEnv(buildIndexBuffer([{ form: 'meta-llama--llama-3-8b', shardIdx: 11 }], BID));
        const candidates = ['meta-llama--llama-3-8b'];
        const shardForms = new Map<number, string[]>([[11, ['meta-llama--llama-3-8b']]]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env, BID);
        expect(env._counter.getCalls).toBe(0);
        expect(r.indexLoaded).toBe(false);
        expect(r.absenceProven).toBe(false);
        expect(r.orderedShards).toEqual([[11, ['meta-llama--llama-3-8b']]]);
    });

    it('(e) fan-out <= 2 + cached header -> still NOT consulted (ENT-503: no resident index)', async () => {
        // ENT-503: the index is range-read, never resident, so a "warm" lookup is
        // not free any more. Low fan-out keeps the degrade path (what production
        // did since the whole-blob index was refused): no new R2 GET, full order.
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }], BID));
        expect(await warmIndex(env)).toBe(true); // simulate prior warm
        expect(isIndexWarm()).toBe(true);
        const loadsAfterWarm = env._counter.getCalls; // 1 GET to warm it
        const candidates = ['2307.01952', 'arxiv--2307.01952'];
        const shardForms = new Map<number, string[]>([
            [3, ['2307.01952']],
            [7, ['arxiv--2307.01952']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env, BID);
        expect(env._counter.getCalls).toBe(loadsAfterWarm);
        expect(r.indexLoaded).toBe(false);
        expect(r.absenceProven).toBe(false);
        expect(r.orderedShards).toEqual([[3, ['2307.01952']], [7, ['arxiv--2307.01952']]]);
    });

    it('(e2) fan-out <= 2 + cached header + all-miss -> NO absence claim (not consulted)', async () => {
        // ENT-503: low fan-out never consults the index; the 2-shard probe decides.
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }], BID));
        expect(await warmIndex(env)).toBe(true);
        const candidates = ['9999.99999', 'arxiv--9999.99999'];
        const shardForms = new Map<number, string[]>([
            [1, ['9999.99999']],
            [2, ['arxiv--9999.99999']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env, BID);
        expect(r.indexLoaded).toBe(false);
        expect(r.absenceProven).toBe(false);
        expect(r.orderedShards).toEqual([[1, ['9999.99999']], [2, ['arxiv--9999.99999']]]);
    });
});
