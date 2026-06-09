/**
 * Reverse-Edge Projector (Paper Mesh Quality PR-2).
 *
 * The corpus relation graph stores every REAL edge ONE-DIRECTIONALLY:
 * relations-generator.js addEdge pushes only onto edges[sourceId], and
 * mesh-profile-baker emits only a node's OUTGOING edges. So a paper an HF model
 * CITES, a benchmark whose defining paper exists, or a benchmark a model is
 * EVALUATED_ON never sees the INBOUND edge — the paper/benchmark graph looks
 * empty even though the fact already lives in the graph from the other endpoint.
 *
 * This module projects an INVERSE VIEW of edges we ALREADY have. A reversed edge
 * is the SAME real edge seen from the target endpoint with a truthful reversed
 * verb (CITES -> CITED_BY); it is NOT a new fact and is NOT synthesized from text.
 * Every reversed edge corresponds 1:1 to a real outgoing edge already in the
 * graph (gate 1/2). The baker still runs each reversed edge through the distiller
 * resolve-filter (mesh-resolve-filter.js resolveMeshEdge), so a reversed edge
 * whose SOURCE does not resolve to a real packed entity is dropped (gate 4).
 */

// Frozen verb-reversal map. Each entry is the truthful name of the SAME edge read
// from the other endpoint. Only edges whose reversal enriches the target's graph
// are reversed; verbs absent here (EXPLAINS hub, FOLLOWS report-chain) are skipped.
//   model --CITES--> paper            => paper <--CITED_BY-- model
//   model --EVALUATED_ON--> benchmark => benchmark <--EVALUATED_BY-- model
//   benchmark --CITES--> paper        => paper <--DEFINES--  benchmark (the paper
//                                        defines / is the basis of the benchmark)
// CITES reverses to CITED_BY in the general case; the benchmark->paper "defining
// paper" citation is the more-truthful DEFINES direction, resolved by source type.
export const VERB_REVERSAL = Object.freeze({
    CITES: 'CITED_BY',
    EVALUATED_ON: 'EVALUATED_BY',
    USES: 'USED_BY',
    BASED_ON: 'BASIS_OF',
    TRAINED_ON: 'TRAINING_SOURCE_OF',
    IMPLEMENTS: 'IMPLEMENTED_BY',
    DEP: 'DEPENDED_ON_BY',
    STACK: 'IN_STACK_OF',
    DEMO_OF: 'HAS_DEMO',
    FEATURES: 'FEATURED_IN',
});

/**
 * The truthful reversed verb for one edge. The benchmark -> paper CITES special
 * case (a benchmark citing its source paper) means the PAPER defines the
 * benchmark, so it reverses to DEFINES rather than the generic CITED_BY.
 *
 *   relType:    the original outgoing verb (model --CITES--> paper)
 *   sourceType: the type of the edge SOURCE (the node that owns the outgoing edge)
 *   targetType: the type of the edge TARGET (the node that gains the reversed edge)
 */
export function reversedVerb(relType, sourceType, targetType) {
    const verb = typeof relType === 'string' ? relType.toUpperCase() : '';
    if (verb === 'CITES'
        && (sourceType || '').toLowerCase() === 'benchmark'
        && (targetType || '').toLowerCase() === 'paper') {
        return 'DEFINES';
    }
    return VERB_REVERSAL[verb] || null; // null => not a reversible relation, skip
}

/**
 * Build the inverse adjacency from the outgoing edge registry in a single O(E)
 * pass. inEdges[targetId] = [[sourceId, relType, fwdEdgeId], ...]. PR-D0b (spec
 * sec 6): a reverse edge is the SAME fact seen from the target -- it must INHERIT
 * the forward edge's evidence, not mint a new bare assertion. So we now also carry
 * the FORWARD edge_id (slot[4] / .edge_id) here; the reverse element points at it
 * (reverse_of), the double-count guard. Still ~O(E) memory (one short string added
 * per reversible edge). At 100M scale this must become a streamed pass (separate).
 *
 *   edgeRegistry: graph.edges -- { sourceId: [ [t,ty,w,refs,eid] | {target,type,weight,edge_id} ] }
 */
export function buildInverseAdjacency(edgeRegistry) {
    const inEdges = {};
    for (const sourceId of Object.keys(edgeRegistry || {})) {
        const list = edgeRegistry[sourceId];
        if (!Array.isArray(list)) continue;
        for (const edge of list) {
            const isArr = Array.isArray(edge);
            const target = isArr ? edge[0] : (edge && (edge.target || edge.target_id || edge.id));
            const relType = isArr ? edge[1] : (edge && (edge.type || edge.relation_type || edge.t));
            if (!target || !relType) continue;
            if (!reversedVerb(relType)) continue; // skip non-reversible early (no alloc)
            // PR-D0b: forward edge_id (slot[4] array / .edge_id object) so the
            // reverse element can reference the forward fact (sec 6).
            const fwdEdgeId = (isArr ? edge[4] : (edge && edge.edge_id)) || '';
            (inEdges[target] || (inEdges[target] = [])).push([sourceId, relType, fwdEdgeId]);
        }
    }
    return inEdges;
}

/**
 * Project a node's INBOUND edges into reversed-verb baked relation objects,
 * deduped against the node's existing OUTGOING relations and against each other
 * by (target_id, relation_type) so a genuinely bidirectional edge is not emitted
 * twice. Returns an array of baked-relation objects in the SAME shape the baker
 * emits for outgoing edges (so the distiller resolve-filters them identically).
 *
 *   inbound:    inEdges[nodeId] = [[sourceId, relType, fwdEdgeId], ...]
 *   nodeType:   the type of THIS node (the reverse-edge target)
 *   existing:   the node's already-baked outgoing relations (for dedupe)
 *   bakeEdge:   (sourceId, reversedVerb, fwdEdgeId) -> baked relation object | null
 *               (the baker passes a closure that resolves id/type/url/name/icon AND
 *               mints a reverse_of element referencing the forward edge_id, sec 6)
 */
export function projectReverseEdges(inbound, nodeType, existing, bakeEdge) {
    if (!Array.isArray(inbound) || inbound.length === 0) return [];
    const seen = new Set();
    for (const rel of (existing || [])) {
        if (rel && rel.target_id && rel.relation_type) {
            seen.add(`${rel.target_id}|${rel.relation_type}`);
        }
    }
    const out = [];
    for (const [sourceId, relType, fwdEdgeId] of inbound) {
        const sourceType = typeof sourceId === 'string' ? srcTypeFromId(sourceId) : '';
        const verb = reversedVerb(relType, sourceType, nodeType);
        if (!verb) continue;
        const baked = bakeEdge(sourceId, verb, fwdEdgeId);
        if (!baked || !baked.target_id) continue;
        const key = `${baked.target_id}|${verb}`;
        if (seen.has(key)) continue; // already outgoing OR already added -> no dup
        seen.add(key);
        out.push(baked);
    }
    return out;
}

// Lightweight source-type hint from an id prefix (benchmark-- / arxiv-paper-- /
// hf-model-- ...). Only the benchmark vs paper distinction changes a verb
// (CITES -> DEFINES), so a coarse prefix read is sufficient; the baker still
// derives the authoritative target type from the node registry for routing.
function srcTypeFromId(id) {
    const s = id.toLowerCase();
    if (s.startsWith('benchmark--')) return 'benchmark';
    if (s.startsWith('arxiv') || s.startsWith('s2-paper--') || s.startsWith('paper--') || s.startsWith('hf-paper--')) return 'paper';
    return '';
}
