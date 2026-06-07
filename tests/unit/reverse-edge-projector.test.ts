// tests/unit/reverse-edge-projector.test.ts
//
// Paper Mesh Quality PR-2 — reverse-edge projection fixture (gate 5).
// Demonstrates that the INBOUND view of edges that ALREADY exist
// one-directionally is projected onto the target endpoint with a truthful
// reversed verb, resolve-filtered by PR-1's authority, with zero stubs, zero
// duplicates, and zero invented facts.
import { describe, it, expect } from 'vitest';
import {
    buildInverseAdjacency,
    projectReverseEdges,
    reversedVerb,
    VERB_REVERSAL,
} from '../../scripts/factory/lib/reverse-edge-projector.js';
import { resolveMeshEdge } from '../../scripts/factory/lib/mesh-resolve-filter.js';

// Synthetic graph (gate 5): model CITES paperX; model EVALUATED_ON benchA;
// benchA CITES paperY (its defining paper); model BASED_ON foundation model.
// Plus a dangling edge whose SOURCE never resolves in entity_lookup (stub guard).
const edgeRegistry: Record<string, [string, string, number][]> = {
    'hf-model--acme/llm': [
        ['arxiv-paper--2401.00001', 'CITES', 90],
        ['benchmark--mmlu', 'EVALUATED_ON', 100],
        ['hf-model--base/foundation', 'BASED_ON', 95],
    ],
    'benchmark--mmlu': [['arxiv-paper--2009.03300', 'CITES', 100]],
    'ghost--unresolved-src': [['arxiv-paper--2401.00001', 'CITES', 50]],
};

const nodeRegistry: Record<string, { t: string; name: string }> = {
    'hf-model--acme/llm': { t: 'model', name: 'Acme LLM' },
    'hf-model--base/foundation': { t: 'model', name: 'Foundation' },
    'benchmark--mmlu': { t: 'benchmark', name: 'MMLU' },
    'arxiv-paper--2401.00001': { t: 'paper', name: 'Acme Paper' },
    'arxiv-paper--2009.03300': { t: 'paper', name: 'MMLU Paper' },
};

// entity_lookup: every REAL node resolves; the ghost source is intentionally absent.
const entityLookup = new Map<string, { name: string; icon: string }>([
    ['hf-model--acme/llm', { name: 'Acme LLM', icon: 'M' }],
    ['hf-model--base/foundation', { name: 'Foundation', icon: 'M' }],
    ['benchmark--mmlu', { name: 'MMLU', icon: 'B' }],
    ['arxiv-paper--2401.00001', { name: 'Acme Paper', icon: 'P' }],
    ['arxiv-paper--2009.03300', { name: 'MMLU Paper', icon: 'P' }],
]);

const inEdges = buildInverseAdjacency(edgeRegistry);

// Minimal bake closure mirroring mesh-profile-baker.bakeEdge (id passthrough).
const bake = (sourceId: string, verb: string) => ({
    relation_type: verb,
    confidence: 1.0,
    target_id: sourceId,
    target_name: (nodeRegistry[sourceId] || ({} as any)).name || sourceId,
    url: '/x',
    icon: 'X',
});

function reverseFor(nodeId: string, existing: any[] = []) {
    const nodeType = (nodeRegistry[nodeId] || ({} as any)).t || 'unknown';
    return projectReverseEdges(inEdges[nodeId], nodeType, existing, bake);
}

describe('reverse-edge projector (PR-2)', () => {
    it('builds an O(E) inverse adjacency of reversible edges', () => {
        expect(inEdges['arxiv-paper--2401.00001']).toContainEqual(['hf-model--acme/llm', 'CITES']);
        expect(inEdges['benchmark--mmlu']).toContainEqual(['hf-model--acme/llm', 'EVALUATED_ON']);
        expect(inEdges['arxiv-paper--2009.03300']).toContainEqual(['benchmark--mmlu', 'CITES']);
    });

    it('paper an HF model CITES gains CITED_BY (gate 3)', () => {
        const px = reverseFor('arxiv-paper--2401.00001');
        expect(px).toContainEqual(
            expect.objectContaining({ relation_type: 'CITED_BY', target_id: 'hf-model--acme/llm' }),
        );
    });

    it('benchmark a model is EVALUATED_ON gains EVALUATED_BY (gate 3)', () => {
        const ba = reverseFor('benchmark--mmlu');
        expect(ba).toContainEqual(
            expect.objectContaining({ relation_type: 'EVALUATED_BY', target_id: 'hf-model--acme/llm' }),
        );
    });

    it("a benchmark's defining paper gains DEFINES, not generic CITED_BY (gate 3)", () => {
        expect(reversedVerb('CITES', 'benchmark', 'paper')).toBe('DEFINES');
        const py = reverseFor('arxiv-paper--2009.03300');
        expect(py).toContainEqual(
            expect.objectContaining({ relation_type: 'DEFINES', target_id: 'benchmark--mmlu' }),
        );
    });

    it('BASED_ON reverses to BASIS_OF on the foundation model', () => {
        const fm = reverseFor('hf-model--base/foundation');
        expect(fm).toContainEqual(
            expect.objectContaining({ relation_type: 'BASIS_OF', target_id: 'hf-model--acme/llm' }),
        );
    });

    it('every reverse edge survives PR-1 resolveMeshEdge with ZERO stubs; unresolved source dropped (gate 4)', () => {
        const all = [
            ...reverseFor('arxiv-paper--2401.00001'),
            ...reverseFor('benchmark--mmlu'),
            ...reverseFor('arxiv-paper--2009.03300'),
            ...reverseFor('hf-model--base/foundation'),
        ];
        let kept = 0;
        let dropped = 0;
        let stubLeak = 0;
        for (const e of all) {
            const node = resolveMeshEdge(e.target_id, e.relation_type, entityLookup.get(e.target_id));
            if (node) {
                kept += 1;
                if (!node.name || node.name === node.id) stubLeak += 1;
            } else {
                dropped += 1;
            }
        }
        expect(kept).toBe(4);
        expect(dropped).toBe(1); // the ghost-source CITED_BY whose SOURCE does not resolve
        expect(stubLeak).toBe(0);
    });

    it('does not duplicate an edge that already exists outgoing (dedupe by target,verb)', () => {
        const existing = [{ target_id: 'hf-model--acme/llm', relation_type: 'CITED_BY' }];
        const dedup = reverseFor('arxiv-paper--2401.00001', existing);
        expect(
            dedup.some(
                (e) => e.target_id === 'hf-model--acme/llm' && e.relation_type === 'CITED_BY',
            ),
        ).toBe(false);
    });

    it('invents NO edge — each reverse edge maps 1:1 to a real outgoing edge (gate 1/2)', () => {
        const outgoing = new Set<string>();
        for (const [src, list] of Object.entries(edgeRegistry)) {
            for (const [tgt, ty] of list) outgoing.add(`${src}->${tgt}:${ty}`);
        }
        let invented = 0;
        for (const nodeId of Object.keys(nodeRegistry)) {
            for (const e of reverseFor(nodeId)) {
                const origVerb =
                    Object.keys(VERB_REVERSAL).find((k) => (VERB_REVERSAL as any)[k] === e.relation_type) ||
                    (e.relation_type === 'DEFINES' ? 'CITES' : '?');
                if (!outgoing.has(`${e.target_id}->${nodeId}:${origVerb}`)) invented += 1;
            }
        }
        expect(invented).toBe(0);
    });
});
