// tests/unit/reverse-edge-target-type.test.ts
//
// PR fix/reverse-edge-target-type — baked target_type round-trip fixtures.
//
// ROOT CAUSE (#2158 canary, 19 unresolved/concept stubs of 639 served edges):
// mesh-profile-baker.js bakeEdge emitted baked relations WITHOUT the target
// entity TYPE (only relation_type = the verb). So v25-distiller.js defaulted
// every reverse(#2159)-projected edge's type to 'model', and normalizeId then
// re-canonicalized knowledge/concept targets as hf-model-- (erasing the concept
// signal so the producer stub-gate could not drop them) AND mis-routed every
// non-model reverse target (paper/dataset/benchmark) as a model -> silent drop
// on the entity_lookup miss.
//
// FIX: bakeEdge now emits `target_type`; the distiller consumes it for BOTH the
// normalizeId/getNodeSource canonicalization AND the resolveMeshEdge stub-gate.
//
// These fixtures lock acceptance items 1-4 at the distiller boundary (the live
// consumer of the baked target_type). We feed distillEntity baked-shape relations
// (relation_type + target_id + target_type, exactly what mesh-profile-baker emits
// for outgoing AND reverse-projected edges) and assert the served ui_related_mesh.
import { describe, it, expect } from 'vitest';
import { distillEntity } from '../../scripts/factory/lib/v25-distiller.js';
import { normalizeId, getNodeSource } from '../../scripts/utils/id-normalizer.js';

type LookupVal = { name: string; icon: string };

// entity_lookup is keyed by CANONICAL id (the form normalizeId produces with the
// REAL target type). Build it the same way the distiller will, so a correct
// target_type produces a HIT and the buggy 'model' default produces a MISS.
function canon(raw: string, type: string): string {
    return normalizeId(raw, getNodeSource(raw, type), type) || raw;
}

const PAPER_RAW = 'arxiv-paper--2401.00001';
const BENCH_RAW = 'benchmark--mmlu';
const DATASET_RAW = 'hf-dataset--squad';
const KNOWLEDGE_RAW = 'knowledge--attention';
const CONCEPT_RAW = 'concept--rlhf';

const entityLookup = new Map<string, LookupVal>([
    [canon(PAPER_RAW, 'paper'), { name: 'Acme Paper', icon: 'P' }],
    [canon(BENCH_RAW, 'benchmark'), { name: 'MMLU', icon: 'B' }],
    [canon(DATASET_RAW, 'dataset'), { name: 'SQuAD', icon: 'D' }],
    // Knowledge/concept stubs are deliberately ALSO present in the lookup so the
    // ONLY thing that can drop them is the type/prefix stub-gate (not a miss).
    [canon(KNOWLEDGE_RAW, 'knowledge'), { name: 'Attention', icon: 'K' }],
    [canon(CONCEPT_RAW, 'concept'), { name: 'RLHF', icon: 'C' }],
]);

// Baked relation in the exact shape mesh-profile-baker.js bakeEdge emits AFTER
// this fix (carrying target_type). The distiller reads target_id + relation_type
// + target_type. confidence/url/icon mirror the producer but are not asserted.
function bakedRel(rawTargetId: string, relType: string, targetType: string) {
    return {
        relation_type: relType,
        target_type: targetType,
        target_id: rawTargetId,
        confidence: 1.0,
        url: '/x',
        icon: '\u{1F4E6}',
    };
}

// Minimal model entity carrying the baked reverse-projected relations. We avoid
// readme/meta so distillEntity only exercises the mesh-resolution loop we changed.
function entityWith(relations: any[]) {
    return {
        id: 'hf-model--acme/llm',
        type: 'model',
        name: 'Acme LLM',
        meta_json: '{}',
        relations,
    } as any;
}

function servedMesh(relations: any[]): Array<{ id: string; type: string; name: string }> {
    const out = distillEntity(entityWith(relations), 0, entityLookup);
    return JSON.parse(out.ui_related_mesh);
}

describe('baked target_type round-trip (reverse-edge-target-type)', () => {
    it('acceptance 1: reverse edge -> paper RETAINED, canonicalized as paper (not hf-model--)', () => {
        // CITED_BY is the reverse of model->paper CITES (PR-2). target_type=paper.
        const mesh = servedMesh([bakedRel(PAPER_RAW, 'CITED_BY', 'paper')]);
        const expectedId = canon(PAPER_RAW, 'paper');
        expect(expectedId).toBe('arxiv-paper--2401.00001');
        const node = mesh.find((n) => n.id === expectedId);
        expect(node, 'paper reverse edge must be RETAINED').toBeTruthy();
        expect(node!.id.startsWith('hf-model--')).toBe(false);
        expect(node!.id.startsWith('arxiv-paper--')).toBe(true);
        expect(node!.name).toBe('Acme Paper');
    });

    it('acceptance 2: reverse edge -> benchmark RETAINED, canonicalized as benchmark', () => {
        const mesh = servedMesh([bakedRel(BENCH_RAW, 'EVALUATED_BY', 'benchmark')]);
        const expectedId = canon(BENCH_RAW, 'benchmark');
        expect(expectedId).toBe('benchmark--mmlu');
        const node = mesh.find((n) => n.id === expectedId);
        expect(node, 'benchmark reverse edge must be RETAINED').toBeTruthy();
        expect(node!.id.startsWith('hf-model--')).toBe(false);
        expect(node!.id.startsWith('benchmark--')).toBe(true);
        expect(node!.name).toBe('MMLU');
    });

    it('acceptance 3: reverse edge -> dataset RETAINED, canonicalized as dataset', () => {
        const mesh = servedMesh([bakedRel(DATASET_RAW, 'TRAINING_SOURCE_OF', 'dataset')]);
        const expectedId = canon(DATASET_RAW, 'dataset');
        expect(expectedId).toBe('hf-dataset--squad');
        const node = mesh.find((n) => n.id === expectedId);
        expect(node, 'dataset reverse edge must be RETAINED').toBeTruthy();
        expect(node!.id.startsWith('hf-model--')).toBe(false);
        expect(node!.id.startsWith('hf-dataset--')).toBe(true);
        expect(node!.name).toBe('SQuAD');
    });

    it('acceptance 4a: reverse edge -> knowledge DROPPED (no hf-model--concept stub)', () => {
        const mesh = servedMesh([bakedRel(KNOWLEDGE_RAW, 'CITED_BY', 'knowledge')]);
        expect(mesh).toEqual([]); // dropped by the type stub-gate
        expect(mesh.some((n) => n.id.startsWith('hf-model--'))).toBe(false);
    });

    it('acceptance 4b: reverse edge -> concept DROPPED (no hf-model--concept stub)', () => {
        // concept getTypeFromId() returns "model", so ONLY the baked target_type
        // signal can drop it — this is the load-bearing case for fix #1.
        const mesh = servedMesh([bakedRel(CONCEPT_RAW, 'CITED_BY', 'concept')]);
        expect(mesh).toEqual([]);
        expect(mesh.some((n) => n.id.startsWith('hf-model--'))).toBe(false);
    });

    it('mixed batch: 3 real reverse targets RETAINED with correct types, 2 stubs DROPPED', () => {
        const mesh = servedMesh([
            bakedRel(PAPER_RAW, 'CITED_BY', 'paper'),
            bakedRel(BENCH_RAW, 'EVALUATED_BY', 'benchmark'),
            bakedRel(DATASET_RAW, 'TRAINING_SOURCE_OF', 'dataset'),
            bakedRel(KNOWLEDGE_RAW, 'CITED_BY', 'knowledge'),
            bakedRel(CONCEPT_RAW, 'CITED_BY', 'concept'),
        ]);
        expect(mesh.length).toBe(3);
        const ids = mesh.map((n) => n.id).sort();
        expect(ids).toEqual(['arxiv-paper--2401.00001', 'benchmark--mmlu', 'hf-dataset--squad']);
        expect(mesh.every((n) => !n.id.startsWith('hf-model--'))).toBe(true);
    });

    it('regression: WITHOUT a baked target_type, a paper target is still rescued by id prefix', () => {
        // Defensive: even a legacy baked edge missing target_type must NOT route a
        // paper to hf-model-- (getTypeFromId fallback recovers the prefixed type).
        const legacy = { relation_type: 'CITED_BY', target_id: PAPER_RAW, confidence: 1.0 };
        const mesh = servedMesh([legacy]);
        const node = mesh.find((n) => n.id === 'arxiv-paper--2401.00001');
        expect(node, 'paper must resolve via id-prefix fallback').toBeTruthy();
        expect(node!.id.startsWith('hf-model--')).toBe(false);
    });
});
