/**
 * Public Evidence Contract — Single Source of Truth (D-135 Lane B / F3).
 *
 * The Free2AITools search-results path exposes a per-result `fni_s` (Semantic
 * factor). `fni_s` is a constant factory baseline (50), NOT a per-entity
 * measurement, and live semantic/ANN ranking is not currently provided. The
 * honest-contract remediation nulls `fni_s` on the public surface and carries a
 * machine-readable note so Agents never ingest a bare `50` as measured relevance.
 *
 * Prior to D-135 the SAME wording was hard-coded inline in src/pages/api/v1/
 * search.ts while the MCP search/rank dispatch (src/pages/api/mcp.ts ->
 * /api/search) returned the raw `fni_s: 50` with NO caveat — a divergence the
 * audit confirmed. This module is the shared owner so REST v1 and MCP cannot
 * drift: both import FNI_S_NOTE + EVIDENCE_CONTRACT_VERSION and apply the SAME
 * normalization at their respective response boundaries.
 *
 * SCOPE: this is the SEARCH-RESULTS-path wording (`fni_s_note`). The
 * entity/select/compare projection path uses a sibling note ("scored live at
 * search; not a per-entity value") owned by entity-projection.ts — that path is
 * not part of this Lane-B change and is intentionally left untouched.
 *
 * Plain .js (mirrors shard-constants.js): consumed by Astro SSR (TS) routes and
 * any build-time tooling without needing native TS execution.
 */

/** Canonical machine-readable caveat for the nulled search-path Semantic factor. */
export const FNI_S_NOTE =
    'query-time baseline; semantic/ANN ranking not currently provided; not a per-entity value';

/** Public evidence-contract version tag carried on the search-results surface. */
export const EVIDENCE_CONTRACT_VERSION = 'fni_v2.0';

/**
 * Normalize the overlapping public Semantic-evidence fields on ONE search result
 * row IN PLACE: null the `fni_s` baseline and attach the canonical note. Other
 * fields (id/slug/ordering/totals/non-semantic pillars/fni_score) are untouched.
 * Idempotent and no-op when the row carries no `fni_s` key.
 *
 * @param {Record<string, any>} row a public search-result row
 * @returns {Record<string, any>} the same row reference (for chaining)
 */
export function normalizeSearchEvidence(row) {
    if (row && typeof row === 'object' && 'fni_s' in row) {
        row.fni_s = null;
        row.fni_s_note = FNI_S_NOTE;
    }
    return row;
}
