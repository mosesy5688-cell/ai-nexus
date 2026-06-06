/**
 * Identity Assertion SEMANTICS -- the per-pair predicates (PR-C1).
 * Design: IDENTITY_LAYER_DESIGN_v3 B / C / D7. Kept separate from the streaming
 * orchestrator (assertion-generator.js) to hold each file under CES 250.
 *
 * Closed-set v1: SAME_AS == method 'exact_source_url_xref' ONLY. Everything else
 * is MANIFESTATION_OF by construction. Ruthlessly conservative -- Identity Certainty
 * >> Coverage: in ANY doubt, MANIFESTATION_OF, never a false SAME_AS. ASCII-only.
 */

import crypto from 'crypto';
import { deriveSourceUrl } from './source-url-deriver.js';
import { weightForMethod, IDENTITY_WEIGHTS_VERSION } from './assertion-weights.js';

export const SAME_AS = 'SAME_AS';
export const MANIFESTATION_OF = 'MANIFESTATION_OF';

// D7: a paper placeholder identity must NEVER become an asserted identity. Any
// member matching this is barred from SAME_AS (MANIFESTATION_OF only).
const PAPER_PLACEHOLDER = /^arxiv-paper--unknown--/;

/** Paper-placeholder guard (D7). Exported for the verify-canary. */
export function isPaperPlaceholder(id) {
    return typeof id === 'string' && PAPER_PLACEHOLDER.test(id);
}

/**
 * Is this source_url provably HARVEST-SET (not back-derived from the id)?
 *
 * source-url-deriver.js back-derives source_url FROM the id when harvest left it
 * null (aggregator.js:158-160). An xref over a back-derived URL re-manufactures the
 * C1 case-fold collision as a FALSE SAME_AS (design B). There is no source_url_origin
 * marker in the corpus yet (Block-3 3b), so we PROVE harvest-set negatively: a URL
 * the deriver would reconstruct byte-identically from this id is INDISTINGUISHABLE
 * from a derived one -> treat as NOT-provably-harvest-set. SAME_AS fires only when
 * the URL could NOT have been derived from the id (deriver returns null OR a
 * different string) -- i.e. it genuinely originated in the raw harvest.
 * Conservative: a harvest-set URL that happens to coincide with the deriver output
 * is also excluded (false negative, acceptable per certainty>coverage).
 */
export function isHarvestSetSourceUrl(entity) {
    const su = entity && entity.source_url;
    if (typeof su !== 'string' || su.length < 8) return false;
    const derived = deriveSourceUrl(entity);
    // deriver could not reconstruct it -> must have come from harvest.
    // deriver reconstructs something DIFFERENT -> the stored URL is not the derived
    // one, so it is harvest-set. Equal -> cannot prove harvest-set; reject.
    return derived !== su;
}

/** Deterministic assertion_id = hash(member_a, member_b, method); pair pre-sorted. */
export function assertionId(memberA, memberB, method) {
    return crypto.createHash('sha256')
        .update(`${memberA}|${memberB}|${method}`)
        .digest('hex')
        .slice(0, 32);
}

/** One evidence row stamped from the FROZEN weight table (never a stored scalar). */
export function evidenceRow(signal, value, sourceField, method) {
    return { signal, value, source_field: sourceField, method, weight: weightForMethod(method) };
}

/**
 * Build a SAME_AS assertion for two DISTINCT canonical_ids that share a
 * byte-identical harvest-set source_url. Returns null when the pair is ineligible
 * (paper placeholder D7, identical ids, or missing evidence). Pair is sorted a<b.
 */
export function buildSameAs(idX, idY, sourceUrl) {
    if (!idX || !idY || idX === idY) return null;
    if (isPaperPlaceholder(idX) || isPaperPlaceholder(idY)) return null; // D7
    const [a, b] = idX < idY ? [idX, idY] : [idY, idX];
    const method = 'exact_source_url_xref';
    const evidence = [evidenceRow('shared_harvest_source_url', sourceUrl, 'source_url', method)];
    return finalize(a, b, SAME_AS, method, evidence, 'structural', true);
}

/**
 * Build a MANIFESTATION_OF assertion (non-authoritative, Agent decides). verified
 * is ALWAYS null, authority ALWAYS 'agent' (C.3 -- can never enter a SAME_AS fold).
 * relation-class cross-references (DERIVED_FROM/CITES/USES) and unverified shared
 * source_urls land here. Returns null on missing evidence / self-pair.
 */
export function buildManifestationOf(idX, idY, method, evidence) {
    if (!idX || !idY || idX === idY) return null;
    if (!Array.isArray(evidence) || evidence.length === 0) return null;
    const [a, b] = idX < idY ? [idX, idY] : [idY, idX];
    return finalize(a, b, MANIFESTATION_OF, method, evidence, 'agent', null);
}

/** Assemble the final assertion record + reject empty evidence at construction. */
function finalize(a, b, relation, method, evidence, authority, verified) {
    if (!Array.isArray(evidence) || evidence.length === 0) return null;
    return {
        assertion_id: assertionId(a, b, method),
        member_a: a, member_b: b,
        relation, method, evidence,
        verified, authority,
        conflicts_with: null,
        weights_version: IDENTITY_WEIGHTS_VERSION,
        asserted_at: new Date().toISOString(),
        superseded_by: null,
    };
}
