/**
 * Identity Assertion weight table -- FROZEN/PUBLISHED constant (identity-weights-v1).
 *
 * Phase 2-C / PR-C1 (IDENTITY_LAYER_DESIGN_v3 C.5). This is the ONLY source of an
 * assertion's per-evidence numeric weight. The assertion-generator stamps
 * evidence[].weight from THIS table, and NEVER reads a stored edge confidence
 * (relations-generator.js:27 writes Math.round(conf*100) -- default 1.0 => every
 * edge 100; reading it back would be a back-door producer scalar the never-collapse
 * invariant forbids). Served confidence (PR-C3) is a pure function of evidence[].weight
 * + this table, so it stays reproducible OFFLINE -- never a magic base + opaque bumps
 * (the named anti-precedent: rationale-builder.ts computeConfidence()).
 *
 * Versioned: bump VERSION + add a new keyed block; NEVER mutate a shipped weight
 * (a silent mutation re-scores every historical assertion). ASCII-only (Art 8.1).
 */

// Bump on ANY weight change. Persisted alongside assertions so a served confidence
// is always attributable to the exact table revision that produced it.
export const IDENTITY_WEIGHTS_VERSION = 'identity-weights-v1';

/**
 * Per-method evidence weight, in [0,1]. A weight is the confidence MASS one
 * signal of that method contributes; the serve layer (PR-C3) combines an
 * assertion's evidence[] weights into a derived confidence. Conservative by
 * construction -- SAME_AS (structural, threshold-free) carries full mass; every
 * MANIFESTATION_OF method is sub-1.0 (Agent-decides, non-authoritative).
 */
export const METHOD_WEIGHTS = Object.freeze({
    // --- SAME_AS (closed set v1, structural) ---
    // A byte-identical HARVEST-SET source_url shared by two distinct canonical_ids
    // is a structural identity proof: full mass.
    exact_source_url_xref: 1.0,

    // --- MANIFESTATION_OF (non-authoritative; Agent decides) ---
    // A derived/relation cross-reference: the two ids are LINKED, not proven one
    // artifact. Sub-1.0 so it can never alone read as certainty.
    derived_from_xref: 0.5,        // base_model / model lineage (DERIVED_FROM-class)
    cites_xref: 0.3,               // arxiv/paper reference (CITES-class)
    uses_xref: 0.3,                // models_used / model_id (USES-class)
    shared_source_url_unverified: 0.4, // same source_url but harvest-set origin NOT provable
});

/**
 * Resolve a method's frozen weight. An unknown method is a producer bug (a new
 * method shipped without registering a weight) -- fail loud, never default to a
 * silent scalar that the never-collapse invariant would then carry downstream.
 * @param {string} method
 * @returns {number} weight in [0,1]
 */
export function weightForMethod(method) {
    const w = METHOD_WEIGHTS[method];
    if (typeof w !== 'number') {
        throw new Error(`[assertion-weights] no frozen weight for method '${method}' (register it in ${IDENTITY_WEIGHTS_VERSION})`);
    }
    return w;
}
