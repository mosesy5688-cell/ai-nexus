import { describe, it, expect, beforeEach } from 'vitest';
import { resolveShardsForCandidates } from '../../src/lib/entity-absence-oracle.js';
import { _resetIdIndexForTest, loadIdIndex, isIndexWarm, getIndexBuildId } from '../../src/lib/id-index-reader.js';
import { buildIndexBuffer, mockEnv } from './helpers/id-index-fixture.js';

// B4 VERSION-COHERENCE GATE (Founder, locked):
//   "id-index may prove absence only when id-index build-id and served shard
//    manifest build-id are verified coherent for the same request."
//
// These tests drive resolveShardsForCandidates with a synthetic v3 (build_id-
// stamped) / v2 (no build_id) id-index plus an explicit manifest build_id, and
// assert the failure-mode table: absence proof + destructive shrink only when
// coherent; under ANY incoherence -> NO zero-probe 404, NO shrink, only a
// non-destructive reorder (every original shard still probed).

const IDX_BID = 'run-3000-aaa111'; // build_id stamped into the index fixture
const MAN_BID = 'run-3000-aaa111'; // matching served-manifest build_id (coherent)
const NEW_BID = 'run-3001-bbb222'; // a NEWER bake's build_id (incoherent)

// A 3-shard (high-fan-out, awaited) plan where only shard 7 resolves in the index.
function plan() {
    const candidates = ['2307.01952', 'arxiv--2307.01952', 'unknown--2307.01952'];
    const shardForms = new Map<number, string[]>([
        [3, ['2307.01952']],
        [7, ['arxiv--2307.01952']],
        [42, ['unknown--2307.01952']],
    ]);
    return { candidates, shardForms };
}
// A high-fan-out all-MISS plan (every candidate absent from the index).
function missPlan() {
    const candidates = ['9999.99999', 'arxiv--9999.99999', 'unknown--9999.99999'];
    const shardForms = new Map<number, string[]>([
        [1, ['9999.99999']], [2, ['arxiv--9999.99999']], [3, ['unknown--9999.99999']],
    ]);
    return { candidates, shardForms };
}

describe('resolveShardsForCandidates — build-id coherence gate', () => {
    beforeEach(() => _resetIdIndexForTest());

    // -- Failure-mode table rows --------------------------------------------

    it('new index + new manifest (build_id match) -> absence ALLOWED', async () => {
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }], MAN_BID));
        const { candidates, shardForms } = missPlan();
        const r = await resolveShardsForCandidates(shardForms, candidates, env, MAN_BID);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(true);   // coherent -> zero-probe 404 allowed
        expect(r.orderedShards).toEqual([]);
    });

    it('new index + new manifest (match) + hit -> destructive shrink', async () => {
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }], MAN_BID));
        const { candidates, shardForms } = plan();
        const r = await resolveShardsForCandidates(shardForms, candidates, env, MAN_BID);
        expect(r.absenceProven).toBe(false);
        expect(r.orderedShards).toEqual([[7, ['arxiv--2307.01952']]]); // shrunk 3 -> 1
    });

    it('old index + new manifest (build_id mismatch) -> DEGRADE to probe', async () => {
        // The index was stamped with the OLD bake's id; the served manifest is the
        // NEW bake. Mismatch -> no absence, no shrink, only non-destructive reorder
        // (resolved shard 7 first, then the rest — nothing dropped).
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }], IDX_BID));
        const { candidates, shardForms } = plan();
        const r = await resolveShardsForCandidates(shardForms, candidates, env, NEW_BID);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(false); // INCOHERENT -> never prove absence
        // Non-destructive: all 3 shards still present, resolved 7 reordered first.
        expect(r.orderedShards).toEqual([
            [7, ['arxiv--2307.01952']], [3, ['2307.01952']], [42, ['unknown--2307.01952']],
        ]);
    });

    it('new index + old manifest (mismatch) -> DEGRADE to probe (no absence)', async () => {
        // Symmetric: the NEW index but an OLD served manifest. All-miss must NOT
        // 404 — the manifest is from a different bake, so the index cannot prove
        // closure over the served corpus.
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }], NEW_BID));
        const { candidates, shardForms } = missPlan();
        const r = await resolveShardsForCandidates(shardForms, candidates, env, IDX_BID);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(false);
        // Nothing resolved -> non-destructive reorder leaves the full fan-out.
        expect(r.orderedShards).toEqual([
            [1, ['9999.99999']], [2, ['arxiv--9999.99999']], [3, ['unknown--9999.99999']],
        ]);
    });

    it('index missing -> DEGRADE (no absence)', async () => {
        const env = mockEnv(null); // R2 GET returns null -> load fails
        const { candidates, shardForms } = missPlan();
        const r = await resolveShardsForCandidates(shardForms, candidates, env, MAN_BID);
        expect(r.indexLoaded).toBe(false);
        expect(r.absenceProven).toBe(false);
        expect(r.orderedShards).toEqual([
            [1, ['9999.99999']], [2, ['arxiv--9999.99999']], [3, ['unknown--9999.99999']],
        ]);
    });

    it('index parse fail (bad magic) -> DEGRADE (no absence)', async () => {
        const bad = new ArrayBuffer(64);
        new Uint8Array(bad).fill(0); // magic != "IDIX"
        const env = mockEnv(bad);
        const { candidates, shardForms } = missPlan();
        const r = await resolveShardsForCandidates(shardForms, candidates, env, MAN_BID);
        expect(r.indexLoaded).toBe(false);
        expect(r.absenceProven).toBe(false);
    });

    it('manifest missing / build_id null (either side) -> DEGRADE (no absence)', async () => {
        // Index is coherently stamped but the served manifest has NO build_id
        // (old manifest / parse-fallback). null manifest build_id -> incoherent.
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }], IDX_BID));
        const { candidates, shardForms } = missPlan();
        const r = await resolveShardsForCandidates(shardForms, candidates, env, null);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(false); // manifest build_id missing -> degrade
    });

    it('build_id missing on the INDEX (v2, no token) -> DEGRADE (no absence)', async () => {
        // A v2 index (no build_id) under the new reader: getIndexBuildId() is null
        // -> incoherent even if the manifest carries a build_id. Backward-compat:
        // the v2 index still LOADS (no crash) and still reorders, only absence off.
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }])); // v2
        expect(await loadIdIndex(env)).toBe(true);   // v2 parses fine (no refusal)
        expect(getIndexBuildId()).toBeNull();        // but exposes no token
        _resetIdIndexForTest();
        const { candidates, shardForms } = missPlan();
        const r = await resolveShardsForCandidates(shardForms, candidates, env, MAN_BID);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(false);
    });

    // -- Gate #5: cached-old-index + NEW-manifest FALSE-404 ATTACK -----------

    it('(ATTACK) cached OLD index VIEW + NEWER manifest -> NO 404 for a net-new entity', async () => {
        // THREAT: a warm isolate cached the OLD bake's index (stamped IDX_BID). A
        // NEW bake published a NEW manifest (NEW_BID) plus net-new entities. A
        // net-new entity's candidates ALL miss the cached OLD index. Without the
        // coherence gate that all-miss would be a FALSE 404. With it, the build_id
        // mismatch disables the absence proof -> the request degrades to a probe
        // (no 404), so the net-new entity stays reachable.
        const env = mockEnv(buildIndexBuffer([{ form: 'old-entity', shardIdx: 5 }], IDX_BID));
        // Warm the OLD index into the isolate (simulates a prior request).
        expect(await loadIdIndex(env)).toBe(true);
        expect(isIndexWarm()).toBe(true);
        expect(getIndexBuildId()).toBe(IDX_BID);

        // A net-new entity (added by the NEW bake) — absent from the OLD index.
        const candidates = ['brand-new-2406.99999', 'arxiv--2406.99999', 'unknown--2406.99999'];
        const shardForms = new Map<number, string[]>([
            [10, ['brand-new-2406.99999']],
            [20, ['arxiv--2406.99999']],
            [30, ['unknown--2406.99999']],
        ]);
        // Served manifest is the NEWER bake -> build_id mismatch with the cached index.
        const r = await resolveShardsForCandidates(shardForms, candidates, env, NEW_BID);

        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(false);           // <-- NO false 404
        // Probe path taken: the FULL fan-out survives (nothing dropped), so the
        // net-new entity on a real shard is still reachable.
        expect(r.orderedShards).toEqual([
            [10, ['brand-new-2406.99999']],
            [20, ['arxiv--2406.99999']],
            [30, ['unknown--2406.99999']],
        ]);
    });

    it('(control) same attack plan but COHERENT manifest -> absence DOES fire', async () => {
        // Same all-miss plan, but now the manifest build_id MATCHES the index's:
        // the index is authoritative, so absence IS proven (proves the gate is the
        // only thing suppressing the 404 in the attack case, not a probe bug).
        const env = mockEnv(buildIndexBuffer([{ form: 'old-entity', shardIdx: 5 }], IDX_BID));
        expect(await loadIdIndex(env)).toBe(true);
        const candidates = ['brand-new-2406.99999', 'arxiv--2406.99999', 'unknown--2406.99999'];
        const shardForms = new Map<number, string[]>([
            [10, ['brand-new-2406.99999']], [20, ['arxiv--2406.99999']], [30, ['unknown--2406.99999']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env, IDX_BID);
        expect(r.absenceProven).toBe(true);
        expect(r.orderedShards).toEqual([]);
    });
});
