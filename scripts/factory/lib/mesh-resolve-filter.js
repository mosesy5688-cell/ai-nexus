/**
 * Mesh resolve-filter (PR-1 "No Fake Density at the source").
 *
 * The per-entity served graph `ui_related_mesh` (entity-projection.ts:142
 * relations.related) must contain ONLY edges that resolve to a real, packed,
 * provenanced node — never a fabricated target that 404s. Before PR-1 the
 * distiller KEPT every unresolved target with a humanized display name (the
 * No-Fake-Density violation) to avoid tripping the degeneracy canary; that fake
 * density masked real sparsity. PR-1 moves the authority upstream (mirroring the
 * client-side isValidNode guard at src/utils/mesh-processor.js:18) and drops the
 * fakes at the producer for EVERY entity + the API, then teaches the canary that
 * honest sparsity is valid.
 *
 * This module is the SINGLE source of truth for two questions, shared by the
 * distiller (which drops) and verify-canaries (which asserts none survived):
 *   1. isConceptStubEdge(...)  — a concept/knowledge target that has no packed
 *      node (EXPLAINS verb, or knowledge/concept target type / id prefix).
 *   2. isResolvedMeshNode(...) — a served ui_related_mesh node that resolves to a
 *      real entity (has an id + a name that isn't a degenerate echo of the id).
 */

const CONCEPT_TYPES = new Set(['knowledge', 'concept']);
const CONCEPT_PREFIXES = ['knowledge--', 'concept--'];

/**
 * True when this edge points at a concept / knowledge stub that is NOT a packed
 * entity (the ~50-word dictionary node injected by knowledge-linker EXPLAINS
 * edges, plus any concept-typed target). Such targets never enter entity_lookup,
 * so they would 404 — they must be dropped regardless of an entity_lookup miss.
 *
 * Signals (any one):
 *   - relation verb is EXPLAINS (knowledge-linker hub edge),
 *   - declared target type is knowledge | concept,
 *   - target id is prefixed knowledge-- | concept--.
 */
export function isConceptStubEdge(relationVerb, targetType, targetId) {
    const verb = typeof relationVerb === 'string' ? relationVerb.toUpperCase() : '';
    if (verb === 'EXPLAINS') return true;
    const tt = typeof targetType === 'string' ? targetType.toLowerCase() : '';
    if (CONCEPT_TYPES.has(tt)) return true;
    const id = typeof targetId === 'string' ? targetId : '';
    return CONCEPT_PREFIXES.some(p => id.startsWith(p));
}

/**
 * Resolve-filter decision: given a canonicalized target id and the entity_lookup
 * hit (or undefined on a miss), return the served node ONLY when the target
 * resolves to a real packed entity. Returns null to DROP (entity_lookup miss, or
 * a concept/knowledge stub) — no humanized fake is ever emitted.
 *
 *   lookupHit: the entity_lookup.get(targetId) value ({ name, icon } | undefined)
 */
export function resolveMeshEdge(targetId, relationType, lookupHit, opts = {}) {
    if (isConceptStubEdge(relationType, opts.targetType, targetId)) return null;
    if (!lookupHit || !lookupHit.name) return null; // entity_lookup MISS -> drop
    return {
        id: targetId,
        type: relationType,
        name: lookupHit.name,
        icon: lookupHit.icon || '\u{1F4E6}', // 📦
    };
}

/**
 * Canary predicate: is a served ui_related_mesh node a genuinely resolved edge?
 * After PR-1 every surviving node MUST satisfy this — a node that fails it is a
 * fabricated/unresolved edge that escaped the filter and FAILS the bake.
 * A node fails when it has no id, an explicitly unresolved marker, a name that is
 * a degenerate echo of the id (name === id or missing), or a concept/knowledge id.
 */
export function isResolvedMeshNode(node) {
    if (!node || typeof node !== 'object') return false;
    if (node._unresolved) return false;
    if (!node.id || typeof node.id !== 'string') return false;
    if (node.name == null || node.name === node.id) return false;
    if (CONCEPT_PREFIXES.some(p => node.id.startsWith(p))) return false;
    return true;
}
