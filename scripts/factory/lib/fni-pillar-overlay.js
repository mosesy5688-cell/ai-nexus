/**
 * FNI Pillar Overlay (CES Art 5.1 extraction from aggregator.js)
 *
 * When the 2/4 artifact FNI score is overlaid onto a 4/4 baseline entity, the
 * pillar metrics (fni_a/p/r/q) must be overlaid too. Carrying only fni_score left
 * the pillars at the previous bake's stale registry baseline (registry-loader.js
 * `fni_a ?? 0`), which is why freshly-computed gh authority (stars/forks via #2117)
 * never reached the pack — every github entity surfaced authority=0 despite
 * populated stars/forks.
 *
 * Two score-map shapes feed the overlay:
 *   - Rust direct N-API `scores` map: id -> f64 (score only, no pillars).
 *   - JS buildFniMap: id -> { score, a, p, r, q } (carries the 2/4 pillars).
 * When the map carries pillars, overlay them directly. When it does not (Rust
 * score-only path, or an older artifact that omitted pillars), recompute from the
 * full baseline entity `e`, which retains stars/forks/meta_json so the authority
 * pillar is reconstructed identically to the 2/4 stage.
 */
import { calculateFniFFI } from './rust-bridge.js';

/**
 * Overlay the 2/4 artifact's FNI pillars onto entity `e` (mutates `e`).
 * @param {object} e baseline entity (full, retains stars/forks/meta_json)
 * @param {object|number} artifactEntry fniMap value (number=score, or {score,a,p,r,q})
 */
export function applyArtifactPillars(e, artifactEntry) {
    const hasPillars = typeof artifactEntry === 'object' && artifactEntry !== null
        && artifactEntry.a != null;
    if (hasPillars) {
        if (artifactEntry.a != null) e.fni_a = artifactEntry.a;
        if (artifactEntry.p != null) e.fni_p = artifactEntry.p;
        if (artifactEntry.r != null) e.fni_r = artifactEntry.r;
        if (artifactEntry.q != null) e.fni_q = artifactEntry.q;
        if (e.fni_metrics && typeof e.fni_metrics === 'object') {
            e.fni_metrics = { ...e.fni_metrics, a: e.fni_a, p: e.fni_p, r: e.fni_r, q: e.fni_q };
        }
        return;
    }
    // Score-only map (Rust path): recompute pillars from the full baseline entity.
    const result = calculateFniFFI(e, { includeMetrics: true, lastSeen: e._last_seen });
    e.fni_a = result.metrics.a; e.fni_p = result.metrics.p;
    e.fni_r = result.metrics.r; e.fni_q = result.metrics.q;
    if (e.fni_metrics && typeof e.fni_metrics === 'object') {
        e.fni_metrics = { ...e.fni_metrics, a: e.fni_a, p: e.fni_p, r: e.fni_r, q: e.fni_q };
    }
}
