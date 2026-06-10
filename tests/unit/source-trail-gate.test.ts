// tests/unit/source-trail-gate.test.ts
//
// PR-D0b WARN->FAIL flip ("Coverage Green" gate). The D0 source_trail coverage canary
// is flipped from WARN (informational) to a bake-FAIL gate after coverage measured Green
// (run 27274000163 rerun: 192/192 lines 100.0%, 0 gap, [dict:loaded] x2 host jobs). The
// gate is a REASON-ALLOWLIST, not a numeric threshold. This pins, per the PM spec:
//   1. 100% / 0-gap PASSes trivially (today's reality).
//   2. A gap whose reason is in the legal-drop allowlist PASSes (logged, not failed).
//   3. A gap with an ILLEGAL reason (unresolvable-ref, no-refs, reverse-verb, unknown)
//      FAILs the bake.
//   4. Measurement-integrity loss: ui_related_mesh refs exist AND the baked sidecar dict
//      did NOT load (status != loaded) FAILs (#2171: a graphDict fallback fabricates a
//      fake gap -> fail fast on the integrity loss itself).
import { describe, it, expect, vi } from 'vitest';
import {
    enforceSourceTrailGate, LEGAL_DROP_REASONS,
} from '../../scripts/factory/lib/verify-trail-gate.js';
import {
    newEvidenceDict, evidenceElement, structuralSentinel,
} from '../../scripts/factory/lib/evidence-carrier.js';
import { verifySourceTrailCoverage } from '../../scripts/factory/lib/verify-mesh-canary.js';

// A check() collector mirroring verify-db's registrar: records every (label,pass,detail)
// so a test can assert which sink FAILed and why.
function collector() {
    const calls: Array<{ label: string; pass: boolean; detail: string }> = [];
    const check = (label: string, pass: boolean, detail = '') => { calls.push({ label, pass, detail }); };
    return {
        check,
        calls,
        failed: () => calls.filter(c => !c.pass),
        for: (sink: string) => calls.find(c => c.label === `Trail: ${sink}`),
    };
}

describe('enforceSourceTrailGate: reason-allowlist + measurement-integrity (PR-D0b)', () => {
    it('100% / 0-gap PASSes trivially (Coverage Green today)', () => {
        const c = collector();
        const sinks = [
            { sink: 'graph_blob', scanned: 994038, covered: 994038, pct: '100.0', gap: 0, byProducer: {}, gapByType: {}, gapByReason: {}, dictStatus: 'loaded' },
            { sink: 'ui_related_mesh', scanned: 5000, covered: 5000, pct: '100.0', gap: 0, byProducer: {}, gapByType: {}, gapByReason: {}, dictStatus: 'loaded' },
        ];
        enforceSourceTrailGate(sinks, c.check, { dictExpected: true });
        expect(c.failed()).toHaveLength(0);
        expect(c.for('graph_blob')!.pass).toBe(true);
        expect(c.for('ui_related_mesh')!.pass).toBe(true);
    });

    it('a gap whose ONLY reason is allowlisted PASSes (logged, not failed)', () => {
        const c = collector();
        const legal = LEGAL_DROP_REASONS[0];
        const sinks = [
            { sink: 'graph_blob', scanned: 100, covered: 98, pct: '98.0', gap: 2, byProducer: {}, gapByType: { CITES: 2 }, gapByReason: { [legal]: 2 }, dictStatus: 'loaded' },
        ];
        enforceSourceTrailGate(sinks, c.check, { dictExpected: false });
        expect(c.failed()).toHaveLength(0);
        expect(c.for('graph_blob')!.pass).toBe(true);
        expect(c.for('graph_blob')!.detail).toMatch(/legal-drop/);
    });

    it('an ILLEGAL gap reason FAILs (unresolvable-ref not allowlisted)', () => {
        const c = collector();
        const sinks = [
            { sink: 'graph_blob', scanned: 100, covered: 75, pct: '75.0', gap: 25, byProducer: {}, gapByType: { CITED_BY: 25 }, gapByReason: { 'unresolvable-ref': 25 }, dictStatus: 'loaded' },
        ];
        enforceSourceTrailGate(sinks, c.check, { dictExpected: false });
        expect(c.failed()).toHaveLength(1);
        expect(c.for('graph_blob')!.pass).toBe(false);
        expect(c.for('graph_blob')!.detail).toContain('unresolvable-ref');
    });

    it('no-refs and unknown reasons are NOT allowlisted -> FAIL', () => {
        for (const reason of ['no-refs', 'unknown', 'bad-producer', 'empty-source_field']) {
            const c = collector();
            const sinks = [
                { sink: 'ui_related_mesh', scanned: 10, covered: 9, pct: '90.0', gap: 1, byProducer: {}, gapByType: { USES: 1 }, gapByReason: { [reason]: 1 }, dictStatus: 'loaded' },
            ];
            enforceSourceTrailGate(sinks, c.check, { dictExpected: true });
            expect(c.for('ui_related_mesh')!.pass, `reason ${reason} must FAIL`).toBe(false);
        }
    });

    it('measurement-integrity: ui_related_mesh refs exist but sidecar NOT loaded -> FAIL (even at 0 gap)', () => {
        const c = collector();
        // 0 gap but dict fell back to graphDict ('load-failed'): the measurement is
        // untrustworthy, so the gate must FAIL on the integrity loss itself (#2171),
        // BEFORE judging coverage.
        const sinks = [
            { sink: 'ui_related_mesh', scanned: 5000, covered: 5000, pct: '100.0', gap: 0, byProducer: {}, gapByType: {}, gapByReason: {}, dictStatus: 'load-failed' },
        ];
        enforceSourceTrailGate(sinks, c.check, { dictExpected: true });
        expect(c.for('ui_related_mesh')!.pass).toBe(false);
        expect(c.for('ui_related_mesh')!.detail).toMatch(/untrustworthy|not loaded/);
    });

    it('integrity gate does NOT fire when no refs were scanned (dictExpected false)', () => {
        const c = collector();
        // sidecar absent but no reverse refs scanned -> sidecar was never required.
        const sinks = [
            { sink: 'ui_related_mesh', scanned: 100, covered: 100, pct: '100.0', gap: 0, byProducer: {}, gapByType: {}, gapByReason: {}, dictStatus: 'absent' },
        ];
        enforceSourceTrailGate(sinks, c.check, { dictExpected: false });
        expect(c.for('ui_related_mesh')!.pass).toBe(true);
    });
});

describe('verifySourceTrailCoverage: threads the gate through check() end-to-end', () => {
    // A sidecar dict (superset) holding a reverse element at a HIGH index; the graph dict
    // is the tiny forward-only subset. With the sidecar ABSENT (no cacheDir), the
    // ui_related_mesh reverse ref is unresolvable AND the sidecar did not load -> the
    // integrity gate FAILs the bake (the #2171 scenario, now fail-fast).
    function fixtureDb(revRef: number, graphDict: unknown) {
        const meshGraph = JSON.stringify({ edges: {}, evidence_dict: graphDict });
        const uiRow = JSON.stringify([{ relation_type: 'CITED_BY', source_trail: [revRef] }]);
        return {
            prepare(sql: string) {
                if (sql.includes("key='mesh_graph'")) return { get: () => ({ value: meshGraph }) };
                return { all: () => [{ m: uiRow }] };
            },
        };
    }

    it('reverse refs present + sidecar absent -> ui_related_mesh integrity FAIL', () => {
        const ed = newEvidenceDict();
        ed.add(evidenceElement({ signal: 'arxiv_refs', value: '2401.1', source_field: 'arxiv_refs',
            method: 'cites_xref', producer: 'rel_extractor', source_url: null }));
        const graphDict = JSON.parse(JSON.stringify(ed.dict));
        // a HIGH index well past the 1-element graph dict (only the sidecar would cover it).
        const revRef = 999;
        const c = collector();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // cacheDir = null -> loadBakedDict returns absent; reverse ref unresolvable.
        verifySourceTrailCoverage(fixtureDb(revRef, graphDict) as any, true, null, c.check);
        warn.mockRestore();
        // ui_related_mesh must FAIL: either integrity (status != loaded) or illegal-reason.
        const ui = c.for('ui_related_mesh');
        expect(ui).toBeTruthy();
        expect(ui!.pass).toBe(false);
    });

    it('empty graph + no rows -> graph_blob PASSes (0 edges, 0 gap)', () => {
        const ed = newEvidenceDict();
        ed.add(structuralSentinel('rel_extractor', 'arxiv_refs', 'cites_xref'));
        const graphDict = JSON.parse(JSON.stringify(ed.dict));
        const db = {
            prepare(sql: string) {
                if (sql.includes("key='mesh_graph'")) return { get: () => ({ value: JSON.stringify({ edges: {}, evidence_dict: graphDict }) }) };
                return { all: () => [] }; // no ui_related_mesh rows
            },
        };
        const c = collector();
        verifySourceTrailCoverage(db as any, true, null, c.check);
        // graph_blob: 0 scanned -> 0 gap -> PASS. ui_related_mesh: 0 scanned, no refs -> PASS.
        expect(c.failed()).toHaveLength(0);
        expect(c.for('graph_blob')!.pass).toBe(true);
    });
});
