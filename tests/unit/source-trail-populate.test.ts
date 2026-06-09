// tests/unit/source-trail-populate.test.ts
//
// PR-D0b source_trail FULL POPULATION + Fusion/ui_related_mesh circuit.
// Spec L2_D0_SOURCE_TRAIL_SPEC v2 R4-RATIFIED (sec 3/4/6/9). Covers:
//  - #1 producer coverage: every rel() TYPED edge carries a RESOLVABLE trail end
//    to end (extract -> addEdge intern -> mesh re-seed -> assertEdgeTrail), so a
//    future projection regression that strips a relation-source field is caught.
//  - #2 circuit: profileRelationsCarryTrail prefers the BAKED carrier-bearing source
//    over the carrier-LESS raw e.relations (the measured 0% root cause), and
//    resolveMeshEdge forwards the ref onto the served node.
//  - sec 6 reverse: buildInverseAdjacency carries the forward edge_id; the reverse
//    element references it (reverse_of, value = forward edge_id), no new bare fact.
import { describe, it, expect } from 'vitest';
import { extractEntityRelations } from '../../scripts/factory/lib/relation-extractors.js';
import {
    newEvidenceDict, edgeId, assertEdgeTrail, evidenceElement, METHODS, PRODUCERS,
} from '../../scripts/factory/lib/evidence-carrier.js';
import { resolveMeshEdge, profileRelationsCarryTrail } from '../../scripts/factory/lib/mesh-resolve-filter.js';
import { buildInverseAdjacency, projectReverseEdges } from '../../scripts/factory/lib/reverse-edge-projector.js';
import { normalizeId, getNodeSource } from '../../scripts/utils/id-normalizer.js';

// Mirror of relations-generator.js addEdge (the choke this PR keeps populated).
function addEdge(edges: any, src: string, tgt: string, type: string, conf: number, ed: any, evidence: any) {
    if (!edges[src]) edges[src] = [];
    const refs = (ed && evidence) ? [ed.add(evidence)] : [];
    edges[src].push([tgt, type, Math.round(conf * 100), refs, edgeId(src, type, tgt)]);
}

describe('#1 typed producer coverage (rel() edges reach graph_blob with a resolvable trail)', () => {
    // A model entity that triggers the full typed verb set.
    const entity = {
        id: 'hf-model--acme--llm', type: 'model', source_url: 'https://hf.co/acme/llm',
        base_model: ['meta-llama/Llama-2-7b'],          // BASED_ON
        datasets: ['the-pile-corpus'],                  // TRAINED_ON
        arxiv_refs: ['2307.09288'],                     // CITES
        models_used: ['mistralai/Mistral-7B'],          // USES
        benchmarks: { ifeval: 0.5, average: 0.6 },      // EVALUATED_ON (average excluded)
        tags: ['vllm', 'rag'],                          // STACK
    };

    it('every rel() typed edge carries a non-empty _evidence with a frozen method+producer', () => {
        const rels = extractEntityRelations(entity);
        const verbs = new Set(rels.map((r: any) => r.relation_type));
        for (const v of ['BASED_ON', 'TRAINED_ON', 'CITES', 'USES', 'EVALUATED_ON']) {
            expect(verbs.has(v)).toBe(true); // the structurally-guaranteed typed classes
        }
        for (const r of rels) {
            expect(r._evidence).toBeTruthy();
            expect(METHODS).toContain(r._evidence.method);
            expect(PRODUCERS).toContain(r._evidence.producer);
            expect(r._evidence.producer).toBe('rel_extractor');
        }
    });

    it('typed refs SURVIVE the mesh re-seed and RESOLVE against the merged dict (graph_blob)', () => {
        const ed = newEvidenceDict();
        const edges: any = {};
        for (const r of extractEntityRelations(entity)) {
            addEdge(edges, r.source_id, r.target_id, r.relation_type, r.confidence, ed, r._evidence);
        }
        // mesh stage imports the relations dict (re-seed preserves indices) then mints.
        const mesh = newEvidenceDict(ed.dict);
        let scanned = 0, covered = 0;
        for (const list of Object.values(edges) as any[]) {
            for (const e of list) {
                scanned++;
                if (assertEdgeTrail(e[3], mesh.dict).ok) covered++;
            }
        }
        expect(scanned).toBeGreaterThan(0);
        expect(covered).toBe(scanned); // ~100% typed coverage (no EXPLAINS-only gap)
    });
});

describe('#2 ui_related_mesh circuit — prefer the carrier-bearing source', () => {
    it('profileRelationsCarryTrail is TRUE only when a baked relation carries a ref', () => {
        expect(profileRelationsCarryTrail({ relations: [{ target_id: 't', source_trail: [3] }] })).toBe(true);
        expect(profileRelationsCarryTrail({ relations: [['t', 'CITES', 30, [2], 'eid']] })).toBe(true);
        // raw adapter relations (no carrier) -> FALSE -> distiller keeps the baked source.
        expect(profileRelationsCarryTrail({ relations: [{ target_id: 't', relation_type: 'CITES' }] })).toBe(false);
        expect(profileRelationsCarryTrail({ relations: [['t', 'CITES', 30, [], '']] })).toBe(false);
        expect(profileRelationsCarryTrail({ relations: [] })).toBe(false);
        expect(profileRelationsCarryTrail(undefined as any)).toBe(false);
    });

    it('resolveMeshEdge FORWARDS the source_trail ref + edge_id onto the served node', () => {
        const node = resolveMeshEdge('hf-model--base', 'BASED_ON', { name: 'Base', icon: 'M' },
            { targetType: 'model', source_trail: [7], edge_id: 'abc123' });
        expect(node).toBeTruthy();
        expect(node!.source_trail).toEqual([7]); // the WHY reaches ui_related_mesh
        expect(node!.edge_id).toBe('abc123');
    });
});

describe('#2b profile-attach key — non-canonical e.id resolves to the baker-keyed profile', () => {
    // The baker keys meshProfileMap by the FULLY-canonical id
    // (mesh-profile-baker.js:93/171): normalizeId(nodeId, getNodeSource(nodeId,type), type).
    // pack-db.js must try THAT key first, else a non-canonical e.id misses the map and
    // the distiller falls back to the trail-LESS raw e.relations (the residual ~25% gap).
    const bakerKey = (rawId: string, type: string) =>
        normalizeId(rawId, getNodeSource(rawId, type), type);
    // Mirror of pack-db.js:121 attach lookup (canonical key FIRST, then prior fallbacks).
    const attach = (map: Map<string, any>, e: any) =>
        map.get(normalizeId(e.id, getNodeSource(e.id, e.type), e.type))
        || map.get(e.id) || map.get(e.id?.toLowerCase());

    it('a non-canonical raw id HITS the canonically-keyed profile (was a MISS before)', () => {
        const profile = { relations: [['x', 'CITES', 90, [1], 'eid']] };
        const map = new Map<string, any>([[bakerKey('2307.09288', 'paper'), profile]]);
        expect(bakerKey('2307.09288', 'paper')).toBe('arxiv-paper--2307.09288');
        // OLD lookup (e.id / lowercase only) would MISS the canonical key.
        expect(map.get('2307.09288') || map.get('2307.09288'.toLowerCase())).toBeFalsy();
        // NEW lookup resolves it.
        expect(attach(map, { id: '2307.09288', type: 'paper' })).toBe(profile);
    });

    it('is strictly additive: an already-canonical e.id still resolves (no removed hit)', () => {
        const profile = { relations: [] };
        const id = 'hf-model--meta-llama--Llama-2-7b';
        const map = new Map<string, any>([[bakerKey(id, 'model'), profile]]);
        expect(attach(map, { id, type: 'model' })).toBe(profile);
    });

    it('the canonical-key call self-guards malformed ids (no throw in the pack loop)', () => {
        const map = new Map<string, any>();
        for (const e of [{ id: null }, { id: undefined }, { id: 12345 }, { id: {} }] as any[]) {
            expect(() => map.get(normalizeId(e.id, getNodeSource(e.id, e.type), e.type))).not.toThrow();
        }
    });
});

describe('sec 6 reverse edges reference the forward edge_id (no new bare assertion)', () => {
    it('buildInverseAdjacency carries the forward edge_id from a widened array edge', () => {
        const fwdEid = edgeId('hf-model--m', 'CITES', 'arxiv-paper--1');
        const registry = { 'hf-model--m': [['arxiv-paper--1', 'CITES', 90, [0], fwdEid]] };
        const inEdges = buildInverseAdjacency(registry as any);
        expect(inEdges['arxiv-paper--1']).toContainEqual(['hf-model--m', 'CITES', fwdEid]);
    });

    it('the reverse trail element is reverse_of with value = the forward edge_id', () => {
        const ed = newEvidenceDict();
        const fwdEid = edgeId('hf-model--m', 'CITES', 'arxiv-paper--1');
        // mirror mesh-profile-baker.reverseTrailRef(fwdEdgeId)
        const ref = ed.add(evidenceElement({
            signal: 'reverse_of', value: fwdEid, source_field: 'inverse_adjacency',
            method: 'reverse_of', producer: 'reverse_edge_projector', source_url: null,
        }));
        const el = ed.dict.elements[ref];
        expect(ed.dict.methods[el[3]]).toBe('reverse_of');
        expect(ed.dict.producers[el[5]]).toBe('reverse_edge_projector');
        expect(el[1]).toBe(fwdEid); // value points at the forward fact -> double-count guard
        expect(assertEdgeTrail([ref], ed.dict).ok).toBe(true);
    });

    it('projectReverseEdges passes the forward edge_id into the bake closure', () => {
        const fwdEid = edgeId('hf-model--m', 'CITES', 'arxiv-paper--1');
        const registry = { 'hf-model--m': [['arxiv-paper--1', 'CITES', 90, [0], fwdEid]] };
        const inEdges = buildInverseAdjacency(registry as any);
        let seenFwd = '';
        const bake = (sourceId: string, verb: string, fEid: string) => {
            seenFwd = fEid;
            return { relation_type: verb, target_id: sourceId, confidence: 1 };
        };
        const rev = projectReverseEdges(inEdges['arxiv-paper--1'], 'paper', [], bake);
        expect(rev.length).toBe(1);
        expect(rev[0].relation_type).toBe('CITED_BY');
        expect(seenFwd).toBe(fwdEid); // closure received the forward edge_id (sec 6)
    });
});
