import { describe, it, expect } from 'vitest';
// @ts-ignore -- JS ESM module (no .d.ts); tested for its runtime contract.
import { COMPLETION_STATUS, TERMINATION_REASON, isComplete, buildCompletionRecord, evaluateCompletionGate, incompleteStatus } from '../../scripts/ingestion/harvest-completion.js';

// The SOURCE-COMPLETENESS SEAM in isolation (Founder ruling, 2026-07-26 Factory 1/4
// S2 incident). These tests exist to prove the seam is genuinely source-agnostic --
// no per-source branch, no source name anywhere -- because Lane 1 instruments only
// Semantic Scholar while Lane 3 must be able to migrate the other required adapters
// onto exactly this contract without rewriting it.
// Split from harvest-s2-completeness.test.ts to stay under the CES 250-line ceiling.

describe('completion seam -- the predicate and the gate are source-agnostic', () => {
    it('complete ONLY if limit_satisfied OR every planned unit exhausted', () => {
        expect(isComplete({ limit_satisfied: true, planned_topics: 4, completed_topics: 0 })).toBe(true);
        expect(isComplete({ limit_satisfied: false, planned_topics: 4, completed_topics: 4 })).toBe(true);
        expect(isComplete({ limit_satisfied: false, planned_topics: 4, completed_topics: 3 })).toBe(false);
        // fails CLOSED -- never vacuously complete
        expect(isComplete({ limit_satisfied: false, planned_topics: 0, completed_topics: 0 })).toBe(false);
        expect(isComplete({ limit_satisfied: false, planned_topics: NaN, completed_topics: 4 })).toBe(false);
    });

    it('completion_status is DERIVED, so an adapter cannot declare itself complete', () => {
        const rec = buildCompletionRecord({
            plannedTopics: 4, completedTopics: 3, limitSatisfied: false,
            terminationReason: TERMINATION_REASON.RATE_LIMIT_BREAKER,
            failedTopic: 'computer vision', lastHttpStatus: null,
            // @ts-ignore -- deliberately try to smuggle a verdict in
            completion_status: COMPLETION_STATUS.COMPLETE,
        } as any);
        expect(rec.completion_status).toBe(COMPLETION_STATUS.INCOMPLETE);
    });

    it('an adapter that publishes NO claim is unaffected (absence is not incompleteness)', () => {
        expect(evaluateCompletionGate(null)).toEqual({ blocked: false, record: null });
        expect(evaluateCompletionGate(undefined as any)).toEqual({ blocked: false, record: null });
    });

    it('the gate has no per-source branch -- it blocks ANY incomplete claim', () => {
        const rec = buildCompletionRecord({
            plannedTopics: 90, completedTopics: 12, limitSatisfied: false,
            terminationReason: TERMINATION_REASON.ADAPTER_ERROR, unitLabel: 'day',
        });
        const gate = evaluateCompletionGate(rec);
        expect(gate.blocked).toBe(true);
        expect(gate.error).toContain('12/90 days completed');
        expect(gate.error).toContain('authority WITHHELD');
    });
});
