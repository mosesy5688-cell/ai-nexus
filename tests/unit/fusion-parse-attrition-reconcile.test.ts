// tests/unit/fusion-parse-attrition-reconcile.test.ts
//
// W3-O1 (Founder D-88 / D-89 / D-90) — review-defect reconciliation suite.
// Split out of fusion-parse-attrition.test.ts to honor the CES 250-line
// anti-monolith ban. Covers the corrected CLOSED per-shard accounting model that
// resolves the two code-review defects in the JS canary state machine:
//   DEFECT 1 (anti-empty-set hole): a JS-fallback shard whose attrition is
//     UNOBSERVED must be COUNTED (not silently skipped) and can NEVER read as a
//     clean dropped=0 PASS.
//   DEFECT 2 (over-block): an all-legacy-JSON (all not_applicable) run must be
//     NOT_ACTIVE_OR_NOT_APPLICABLE / NOT_EVALUATED — NOT a FAIL/block.
// SRS-1 invariant: W3O1-CANARY (amended). Hermetic EXEC — no native addon, no
// network; drives the REAL JS canary over synthetic NAPI-camelCase summaries.
import { describe, it, expect } from 'vitest';
import { newCanaryAggregate, foldShard, foldFallbackShard, finalizeCanary } from '../../scripts/factory/lib/fusion-parse-canary.js';
import { newParseAccounting, collectShardAccounting, collectFallbackShard, finalizeParseAccounting } from '../../scripts/factory/lib/fusion-parse-accounting.js';

const V1_CAP = { protocolConstant: 1, hasFuseShard: true, engineMode: 'rust' };

// A protocol-v1 'binary' monitored summary, conserved + complete, `dropped` drops.
function v1Summary(declared: number, dropped: number, opts: any = {}): any {
    const records = [];
    for (let i = 0; i < (opts.records ?? dropped); i++) {
        records.push({
            part: 'part-001.bin', entryIndex: i, errorClass: 'json_parse',
            serdeLine: 1, serdeColumn: 2, payloadLength: 12,
            payloadFingerprint: 'fp00', fingerprintStatus: 'ok', attributionStatus: 'unavailable',
        });
    }
    return {
        protocolVersion: opts.protocolVersion ?? 1, enginePath: opts.enginePath ?? 'binary',
        part: 'part-001.bin', declaredEntityCount: declared,
        parsedEntityCount: opts.parsed ?? declared - dropped, droppedEntityCount: dropped,
        parseErrorCount: dropped, conserved: declared === (opts.parsed ?? declared - dropped) + dropped,
        dropRecords: records,
    };
}

// A protocol-v1 'not_applicable' summary as the Rust reader emits for a legacy
// JSON shard (engine_path != 'binary'); zero declared/dropped, no records.
function naSummary(opts: any = {}): any {
    return {
        protocolVersion: 1, enginePath: opts.enginePath ?? 'not_applicable',
        part: opts.part ?? 'part-000.json.zst',
        declaredEntityCount: 0, parsedEntityCount: 0, droppedEntityCount: 0,
        parseErrorCount: 0, conserved: true, dropRecords: [],
    };
}

function runCanary(cap: any, summaries: any[], expectedShards: number) {
    const agg = newCanaryAggregate();
    for (const s of summaries) foldShard(agg, s);
    return finalizeCanary(cap, agg, expectedShards);
}

describe('W3O1-CANARY review-defect reconciliation (D-89 §12-13 amended)', () => {
    // DEFECT 1: a v1 run where a shard fell to the JS fallback (no monitoring) must
    // NEVER read as a clean dropped=0 PASS — the fallback shard's attrition is
    // unobserved. The fold counts it as not-applicable; the verdict is NOT PASS.
    it('DEFECT 1: 2 monitored 0-drop + 1 JS-fallback shard -> NOT a clean PASS', () => {
        const agg = newCanaryAggregate();
        foldShard(agg, v1Summary(100, 0));
        foldShard(agg, v1Summary(80, 0));
        foldFallbackShard(agg); // the shard fuseShardFFI returned null for
        const r = finalizeCanary(V1_CAP, agg, 3);
        expect(r.verdict).not.toBe('PASS');
        expect(r.blocking).toBe(false);
        expect(r.state).toBe('NOT_ACTIVE_OR_NOT_APPLICABLE');
        expect(r.verdict).toBe('NOT_EVALUATED');
        expect(r.reason).toBe('monitored_partial_unobserved_remainder');
        expect(r.not_applicable_shards).toBe(1);
        expect(r.monitored_summaries).toBe(2);
        expect(r.processed_shards).toBe(3);
    });

    // The same scenario where master-fusion SILENTLY SKIPS the fallback shard (the
    // original bug — it is neither monitored nor folded). The accounting shortfall
    // (processed < expected, and monitored+notApplicable != processed) is caught as
    // a genuine missing summary -> FAIL. Either way it is NEVER a clean PASS.
    it('DEFECT 1 (silent-skip): an unaccounted processed shard -> FAIL, never PASS', () => {
        const agg = newCanaryAggregate();
        foldShard(agg, v1Summary(100, 0));
        foldShard(agg, v1Summary(80, 0)); // only 2 folded; expected 3
        const r = finalizeCanary(V1_CAP, agg, 3);
        expect(r.verdict).not.toBe('PASS');
        expect(r).toMatchObject({ state: 'EXPECTED_BUT_MISSING', verdict: 'FAIL', blocking: true });
        expect(r.reason).toBe('unaccounted_processed_shard');
    });

    // DEFECT 2: an all-legacy-JSON run produces ONLY not_applicable summaries. It
    // must be NOT_ACTIVE_OR_NOT_APPLICABLE / NOT_EVALUATED — NOT a FAIL/block.
    it('DEFECT 2: one not_applicable (legacy-JSON) summary, expected 1 -> NOT_EVALUATED, not blocking', () => {
        const r = runCanary(V1_CAP, [naSummary()], 1);
        expect(r.state).toBe('NOT_ACTIVE_OR_NOT_APPLICABLE');
        expect(r.verdict).toBe('NOT_EVALUATED');
        expect(r.verdict).not.toBe('PASS');
        expect(r.blocking).toBe(false);
        expect(r.reason).toBe('all_shards_not_applicable');
        expect(r.not_applicable_shards).toBe(1);
        expect(r.monitored_summaries).toBe(0);
    });

    it('DEFECT 2: an all-legacy-JSON multi-shard run does NOT block', () => {
        const agg = newCanaryAggregate();
        foldShard(agg, naSummary({ part: 'part-000.json.zst' }));
        foldShard(agg, naSummary({ part: 'part-001.json.zst' }));
        const r = finalizeCanary(V1_CAP, agg, 2);
        expect(r.state).toBe('NOT_ACTIVE_OR_NOT_APPLICABLE');
        expect(r.blocking).toBe(false);
        expect(r.verdict).not.toBe('PASS');
    });

    // MIXED run: some monitored (0 drops) + some not-applicable (legacy-JSON).
    // Attrition on the not-applicable shards is unobserved -> NOT a clean PASS,
    // but NOT a FAIL merely for being not-applicable.
    it('MIXED: monitored 0-drop + not_applicable shard -> not a PASS, not a FAIL', () => {
        const agg = newCanaryAggregate();
        foldShard(agg, v1Summary(100, 0));
        foldShard(agg, naSummary());
        const r = finalizeCanary(V1_CAP, agg, 2);
        expect(r.verdict).not.toBe('PASS');
        expect(r.verdict).not.toBe('FAIL');
        expect(r.blocking).toBe(false);
        expect(r.state).toBe('NOT_ACTIVE_OR_NOT_APPLICABLE');
        expect(r.reason).toBe('monitored_partial_unobserved_remainder');
    });

    // REGRESSION: a FULLY-monitored conserved 0-drop run (no remainder) still PASSES.
    it('REGRESSION: all-monitored conserved 0-drop run still PASSES', () => {
        const r = runCanary(V1_CAP, [v1Summary(100, 0), v1Summary(50, 0)], 2);
        expect(r).toMatchObject({ state: 'PRESENT_VALID', verdict: 'PASS', blocking: false });
        expect(r.not_applicable_shards).toBe(0);
    });

    // A fully-monitored conserved run WITH drops still DEGRADED (never blocks).
    it('REGRESSION: all-monitored conserved with drops still DEGRADED', () => {
        const r = runCanary(V1_CAP, [v1Summary(100, 2), v1Summary(50, 1)], 2);
        expect(r).toMatchObject({ state: 'PRESENT_VALID', verdict: 'DEGRADED', blocking: false });
        expect(r.dropped_entity_count).toBe(3);
    });

    // collectFallbackShard wiring (the master-fusion side-channel): a fallback shard
    // folded through the accounting helper makes finalizeParseAccounting NOT throw
    // and NOT report a clean PASS.
    it('collectFallbackShard via finalizeParseAccounting -> NOT_EVALUATED, no throw', () => {
        const agg = newParseAccounting();
        collectShardAccounting(agg, v1Summary(100, 0), () => {});
        collectFallbackShard(agg);
        let summary: any;
        expect(() => { summary = finalizeParseAccounting(V1_CAP, agg, 2, () => {}); }).not.toThrow();
        expect(summary.verdict).not.toBe('PASS');
        expect(summary.state).toBe('NOT_ACTIVE_OR_NOT_APPLICABLE');
    });
});
