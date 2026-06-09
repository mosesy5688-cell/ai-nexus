// tests/unit/source-trail-carrier.test.ts
//
// PR-D0a source_trail evidence carrier (the EVIDENCE SPINE).
// Spec L2_D0_SOURCE_TRAIL_SPEC v2 R4-RATIFIED. Covers:
//  - 2B COMPACT carrier: edges store integer REFS, NEVER inlined element objects.
//  - dictionary RESOLVE: a ref resolves to a valid element (method/producer/field).
//  - NEGATIVE fixture: the WARN/FAIL check FLAGS an empty/unresolvable ref.
//  - edge_id determinism: stable hash over canonical src \0 type \0 tgt.
//  - Rust<->JS lockstep contract: FROZEN enum ORDINALS + edge_id format are the
//    cross-language ref space; this test pins them so the Rust mirror (evidence.rs
//    PRODUCERS/METHODS/WEIGHTS + nxvf-core sha256_hex16) cannot drift undetected.
import { describe, it, expect } from 'vitest';
import {
    PRODUCERS, METHODS, EVIDENCE_DICT_VERSION,
    edgeId, methodForVerb, evidenceElement, structuralSentinel,
    newEvidenceDict, assertEdgeTrail,
} from '../../scripts/factory/lib/evidence-carrier.js';
import { METHOD_WEIGHTS } from '../../scripts/factory/lib/assertion-weights.js';

describe('FROZEN enum ordinals (Rust<->JS ref space)', () => {
    // These ORDINALS are the carrier code. Rust evidence.rs PRODUCERS/METHODS MUST
    // match this order exactly, else a Rust-minted ref resolves to the wrong element.
    it('producer order is frozen', () => {
        expect(PRODUCERS).toEqual([
            'relations_generator', 'rel_extractor', 'mesh_graph_explains',
            'mesh_graph_featured_in', 'reverse_edge_projector', 'report_injection',
        ]);
    });
    it('method order is frozen and every method has a weight', () => {
        expect(METHODS).toEqual([
            'exact_source_url_xref', 'derived_from_xref', 'cites_xref', 'uses_xref',
            'shared_source_url_unverified', 'declared_dependency', 'leaderboard_membership',
            'keyword_mention', 'reverse_of', 'structural_injection', 'report_chain',
        ]);
        // Rust WEIGHTS array is positional over METHODS -> every method needs a weight.
        for (const m of METHODS) expect(typeof METHOD_WEIGHTS[m]).toBe('number');
    });
});

describe('edge_id determinism (§5)', () => {
    it('is stable, 16 hex chars, and order-sensitive', () => {
        const a = edgeId('hf-model--x', 'CITES', 'arxiv-paper--1');
        expect(a).toMatch(/^[0-9a-f]{16}$/);
        expect(edgeId('hf-model--x', 'CITES', 'arxiv-paper--1')).toBe(a);
        // direction matters (forward != reverse triple)
        expect(edgeId('arxiv-paper--1', 'CITES', 'hf-model--x')).not.toBe(a);
    });
    it('JS<->Rust edge_id parity: pinned shared golden (matches rust nxvf-core)', () => {
        // CI parity gate: this golden MUST equal the Rust sha256_hex16 of the
        // NUL-separated (a, CITES, b) triple pinned in nxvf-core/src/lib.rs.
        expect(edgeId('a', 'CITES', 'b')).toBe('ffd8a01cc0e4f9af');
    });
});

describe('method-for-verb mapping', () => {
    it('maps known verbs and falls back to a structural sentinel method', () => {
        expect(methodForVerb('CITES')).toBe('cites_xref');
        expect(methodForVerb('BASED_ON')).toBe('derived_from_xref');
        expect(methodForVerb('EVALUATED_ON')).toBe('leaderboard_membership');
        expect(methodForVerb('TRENDING')).toBe('structural_injection'); // unknown -> sentinel
    });
});

describe('2B COMPACT carrier — interning + dedup + resolve', () => {
    it('interns elements, dedups, and stores compact integer-coded rows', () => {
        const ed = newEvidenceDict();
        const el = evidenceElement({ signal: 'base_model', value: 'meta-llama/Llama-2-7b',
            source_field: 'base_model', method: 'derived_from_xref', producer: 'rel_extractor',
            source_url: 'https://hf.co/x' });
        const r1 = ed.add(el);
        const r2 = ed.add(el); // identical -> deduped to the SAME ref
        expect(r1).toBe(0);
        expect(r2).toBe(0);
        expect(ed.dict.v).toBe(EVIDENCE_DICT_VERSION);
        // The stored element is a COMPACT array (integer-coded), NOT a fat object.
        const row = ed.dict.elements[r1];
        expect(Array.isArray(row)).toBe(true);
        expect(row.length).toBe(8); // [sigIdx,value,fldIdx,methodOrd,weight,producerOrd,urlIdx,observedAt]
        expect(row[3]).toBe(METHODS.indexOf('derived_from_xref')); // method ordinal
        expect(row[5]).toBe(PRODUCERS.indexOf('rel_extractor')); // producer ordinal
        expect(row[4]).toBe(METHOD_WEIGHTS['derived_from_xref']); // weight from FROZEN table
        expect(typeof row[0]).toBe('number'); // signal is an index, not a string
    });

    it('a ref RESOLVES to a valid element (positive)', () => {
        const ed = newEvidenceDict();
        const ref = ed.add(evidenceElement({ signal: 'arxiv_refs', value: '2401.1',
            source_field: 'arxiv_refs', method: 'cites_xref', producer: 'rel_extractor', source_url: null }));
        // edge carries the COMPACT ref array (2B), never the object.
        const edge = ['arxiv-paper--2401.1', 'CITES', 30, [ref], 'deadbeefdeadbeef'];
        const res = assertEdgeTrail(edge[3] as number[], ed.dict);
        expect(res.ok).toBe(true);
    });

    it('source_url interns + dedups across edges of one source', () => {
        const ed = newEvidenceDict();
        ed.add(evidenceElement({ signal: 'a', value: 'v1', source_field: 'a', method: 'cites_xref', producer: 'rel_extractor', source_url: 'https://hf.co/m' }));
        ed.add(evidenceElement({ signal: 'b', value: 'v2', source_field: 'b', method: 'uses_xref', producer: 'rel_extractor', source_url: 'https://hf.co/m' }));
        expect(ed.dict.source_urls).toEqual(['https://hf.co/m']); // one interned URL, shared
    });

    it('structural sentinel has null source_url (honest not-measured)', () => {
        const ed = newEvidenceDict();
        const ref = ed.add(structuralSentinel('mesh_graph_explains', 'knowledge-links.json'));
        const row = ed.dict.elements[ref];
        expect(row[6]).toBe(-1); // urlIdx -1 == null
        expect(row[3]).toBe(METHODS.indexOf('structural_injection'));
    });
});

describe('NEGATIVE fixture — the canary WOULD flag a bad ref (§9, proven in WARN)', () => {
    const ed = newEvidenceDict();
    const good = ed.add(evidenceElement({ signal: 's', value: 'v', source_field: 's', method: 'cites_xref', producer: 'rel_extractor', source_url: null }));
    it('flags an empty ref array', () => {
        expect(assertEdgeTrail([], ed.dict).ok).toBe(false);
    });
    it('flags an unresolvable ref (index past the table)', () => {
        const res = assertEdgeTrail([good + 999], ed.dict);
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/unresolvable-ref/);
    });
    it('passes a well-formed ref (mirror of the positive case)', () => {
        expect(assertEdgeTrail([good], ed.dict).ok).toBe(true);
    });
    it('flags a ref into a missing dict', () => {
        expect(assertEdgeTrail([0], null as any).ok).toBe(false);
    });
});

describe('dict re-seed (mesh stage imports relations-stage dict)', () => {
    it('rebuilds identical indices so refs stay valid across stages', () => {
        const a = newEvidenceDict();
        const r0 = a.add(evidenceElement({ signal: 'base_model', value: 'x', source_field: 'base_model', method: 'derived_from_xref', producer: 'rel_extractor', source_url: 'https://u' }));
        // mesh stage seeds from the relations dict, then appends a sentinel.
        const b = newEvidenceDict(a.dict);
        const r1 = b.add(structuralSentinel('mesh_graph_explains', 'knowledge-links.json'));
        // the imported element keeps its index; the appended sentinel gets the next.
        expect(r0).toBe(0);
        expect(r1).toBe(1);
        expect(assertEdgeTrail([r0], b.dict).ok).toBe(true);
        expect(assertEdgeTrail([r1], b.dict).ok).toBe(true);
    });
});
