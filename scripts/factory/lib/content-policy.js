/**
 * Legal-Resilience Content Policy (L1, 2026-06-06) — "Raw Content = Fuel; Structure = Asset"
 *
 * Single source of truth for the type-aware store/serve rule that retires full
 * third-party text from the STORE + SERVE layers. Full body is a TRANSIENT
 * derivation input ONLY (clean_summary + embedding); it is proven NOT read by
 * keyword-search / FNI / mesh / ranking / semantic, so the persisted blob is cut.
 *
 * RATIFIED TYPE-AWARE POLICY:
 *   - PAPERS  → FULL removal. No body persisted to cold/enrichment/cold-bin.
 *               The abstract already ships in the warm projection (summary).
 *   - README  (models / tools / datasets / benchmarks / everything else)
 *             → Phase-1 BOUNDED excerpt (~1-2KB). NOT full removal — preserves
 *               quick-start / install snippets without storing the whole README.
 *
 * Applied at EVERY cut point (merge-batches cold write, master-fusion re-inject,
 * row-builders cold .bin, v25-distiller readme_html) so the rule is single-sourced,
 * never duplicated. Keep the cleanAbstract summary + embedding derivations intact:
 * they run on the RAW body before it is discarded; this helper only governs what is
 * PERSISTED, not what the transient derivations consume.
 */

// Phase-1 README excerpt bound. ~2KB keeps install/quick-start snippets while
// retiring the full third-party README body from storage.
export const README_EXCERPT_MAX = 2048;

/**
 * True when this entity type stores NO body at all (papers).
 * Papers carry full third-party academic text whose only legitimate persisted
 * form is the abstract (already in summary), so the body blob is fully removed.
 */
export function isFullBodyRemoved(type) {
    return type === 'paper';
}

/**
 * Type-aware store policy for a raw body.
 *   paper  → null  (nothing persisted)
 *   other  → ~1-2KB excerpt (README Phase-1 bounded), or null when empty
 * The RAW body is still available to callers BEFORE this gate for transient
 * derivations (cleanAbstract summary, embedding) — this only shapes what is stored.
 *
 * @param {string} type   entity type ('paper' | 'model' | 'tool' | 'dataset' | ...)
 * @param {string} body   raw third-party body (README / full_html / content)
 * @returns {string|null} null for papers; bounded excerpt for others; null if empty
 */
export function bodyForStore(type, body) {
    if (isFullBodyRemoved(type)) return null;
    if (!body || typeof body !== 'string') return null;
    if (body.length <= README_EXCERPT_MAX) return body;
    return body.slice(0, README_EXCERPT_MAX);
}
