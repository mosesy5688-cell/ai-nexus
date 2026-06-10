// tests/unit/source-trail-canary-sidecar.test.ts
//
// PR-D0b canary MEASUREMENT fix: the ui_related_mesh source_trail WARN canary must
// RESOLVE reverse-edge HIGH-index refs against the baked sidecar dict
// (output/cache/mesh/profile-evidence-dict.json.zst), the SUPERSET dict the baker
// appends reverse elements to. The bug: loadBakedDict could not DECOMPRESS the .zst in
// the verify env (Rust FFI addon absent) -> silently fell back to the graph dict (which
// lacks the reverse HIGH indices) -> a FABRICATED ~25% coverage gap. These fixtures pin:
//   (a) sidecar MISSING        -> loud-warn path + defined graph-dict fallback,
//   (b) sidecar LOADED         -> reverse HIGH-index refs RESOLVE -> coverage ~100%,
//   (c) a reverse HIGH-index ref (index >> graph-dict length) resolves vs the loaded
//       sidecar after a REAL .zst decompress (exercises zstdSync's CLI tier).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    newEvidenceDict, evidenceElement, structuralSentinel,
} from '../../scripts/factory/lib/evidence-carrier.js';
import { zstdCompress } from '../../scripts/factory/lib/zstd-helper.js';
import {
    loadBakedDict, reportSink, verifySourceTrailCoverage,
} from '../../scripts/factory/lib/verify-mesh-canary.js';

// Build a GRAPH dict (small: only forward/low indices) and a SIDECAR SUPERSET dict that
// seeds from it then APPENDS reverse elements at HIGH indices (mirrors the baker).
function buildDicts() {
    const ed = newEvidenceDict();
    const fwd = ed.add(evidenceElement({ signal: 'arxiv_refs', value: '2401.1', source_field: 'arxiv_refs',
        method: 'cites_xref', producer: 'rel_extractor', source_url: null })); // low index (0)
    const graphDict = JSON.parse(JSON.stringify(ed.dict));
    // sidecar = superset: re-seed graph dict, then append reverse elements (HIGH indices).
    const sup = newEvidenceDict(graphDict);
    // pad the dict so the reverse ref lands at a HIGH index well past graph-dict length.
    let rev = -1;
    for (let i = 0; i < 50; i++) {
        rev = sup.add(evidenceElement({ signal: `r${i}`, value: `e${i}`, source_field: 'inverse_adjacency',
            method: 'reverse_of', producer: 'reverse_edge_projector', source_url: null }));
    }
    sup.add(structuralSentinel('reverse_edge_projector', 'inverse_adjacency', 'reverse_of'));
    return { graphDict, sidecarDict: sup.dict, fwdRef: fwd, revRef: rev };
}

describe('PR-D0b reportSink: reverse HIGH-index refs resolve vs the loaded sidecar (b,c)', () => {
    it('reverse HIGH-index ref (index >> graph-dict length) resolves vs the sidecar', () => {
        const { graphDict, sidecarDict, revRef } = buildDicts();
        // the reverse ref index is WAY past the graph dict (which has 1 element).
        expect(revRef).toBeGreaterThan((graphDict.elements as unknown[]).length + 10);
        const reverseEdge = { relation_type: 'CITED_BY', source_trail: [revRef] };
        // vs the SIDECAR: resolves -> covered.
        const okSink = reportSink('ui_related_mesh', [[reverseEdge]], sidecarDict, 'loaded');
        expect(okSink.scanned).toBe(1);
        expect(okSink.covered).toBe(1);
        expect(okSink.gap).toBe(0);
        // vs the GRAPH dict (the silent-fallback bug): the HIGH index is unresolvable.
        const badSink = reportSink('ui_related_mesh', [[reverseEdge]], graphDict, 'load-failed');
        expect(badSink.covered).toBe(0);
        expect(badSink.gap).toBe(1);
        expect(badSink.gapByType.CITED_BY).toBe(1);
        expect(Object.keys(badSink.gapByReason)).toContain('unresolvable-ref'); // reason prefix, no :index
    });

    it('a mixed sink reports gap-by-type and gap-by-reason on the gap branch', () => {
        const { sidecarDict, revRef } = buildDicts();
        const edges = [[
            { relation_type: 'CITED_BY', source_trail: [revRef] },   // resolves
            { relation_type: 'EVALUATED_BY', source_trail: [] },     // no-refs gap
            { relation_type: 'DEFINES', source_trail: [999999] },    // unresolvable gap
        ]];
        const s = reportSink('ui_related_mesh', edges, sidecarDict, 'loaded');
        expect(s.scanned).toBe(3);
        expect(s.covered).toBe(1);
        expect(s.gapByType.EVALUATED_BY).toBe(1);
        expect(s.gapByType.DEFINES).toBe(1);
        expect(s.gapByReason['no-refs']).toBe(1);
        expect(s.gapByReason['unresolvable-ref']).toBe(1);
    });
});

describe('PR-D0b loadBakedDict: real .zst sidecar round-trips + decompresses (c)', () => {
    let tmpRoot: string;
    let cacheDir: string;
    beforeAll(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canaryfix-'));
        cacheDir = path.join(tmpRoot, 'cache');
        fs.mkdirSync(path.join(cacheDir, 'mesh'), { recursive: true });
        const { sidecarDict } = buildDicts();
        const buf = await zstdCompress(JSON.stringify(sidecarDict));
        fs.writeFileSync(path.join(cacheDir, 'mesh', 'profile-evidence-dict.json.zst'), buf);
    });
    afterAll(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

    it('decompresses the real .zst sidecar and a reverse HIGH-index ref resolves', () => {
        const { revRef } = buildDicts();
        const loaded = loadBakedDict(cacheDir);
        expect(loaded.status).toBe('loaded');
        expect(loaded.dict).toBeTruthy();
        // the loaded dict covers the reverse HIGH index (superset proof).
        expect((loaded.dict.elements as unknown[]).length).toBeGreaterThan(revRef);
        const reverseEdge = { relation_type: 'CITED_BY', source_trail: [revRef] };
        const sink = reportSink('ui_related_mesh', [[reverseEdge]], loaded.dict, loaded.status);
        expect(sink.covered).toBe(1);
        expect(sink.gap).toBe(0);
    });
});

describe('PR-D0b loadBakedDict / coverage: sidecar MISSING -> loud warn + fallback (a)', () => {
    it('loadBakedDict reports ABSENT (quiet, defined fallback) when no file', () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'canaryfix-empty-'));
        const loaded = loadBakedDict(path.join(empty, 'cache'));
        expect(loaded.status).toBe('absent');
        expect(loaded.dict).toBeNull();
        fs.rmSync(empty, { recursive: true, force: true });
    });

    it('coverage emits a LOUD warn (not a silent fake gap) when sidecar load FAILS but refs exist', () => {
        const { graphDict, revRef } = buildDicts();
        // a DB whose ui_related_mesh carries a reverse ref; cacheDir has a .zst that is
        // NOT valid zstd -> zstdSync fails -> loadBakedDict status 'load-failed'.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canaryfix-bad-'));
        const cdir = path.join(tmp, 'cache');
        fs.mkdirSync(path.join(cdir, 'mesh'), { recursive: true });
        fs.writeFileSync(path.join(cdir, 'mesh', 'profile-evidence-dict.json.zst'), Buffer.from('not-zstd'));
        const meshGraph = JSON.stringify({ edges: {}, evidence_dict: graphDict });
        const uiRow = JSON.stringify([{ relation_type: 'CITED_BY', source_trail: [revRef] }]);
        const db = {
            prepare(sql: string) {
                if (sql.includes("key='mesh_graph'")) return { get: () => ({ value: meshGraph }) };
                return { all: () => [{ m: uiRow }] };
            },
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        verifySourceTrailCoverage(db as any, true, cdir);
        const warned = warn.mock.calls.map(c => String(c[0])).join('\n');
        expect(warned).toMatch(/baked sidecar dict load FAILED/);
        warn.mockRestore();
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});
