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
 *   - JS buildFniMap: id -> { score, a, p, r, q } (carries the A/P/R/Q pillars; S
 *     and raw_pop are NOT in the map and are always recomputed below).
 * When the map carries A/P/R/Q, overlay them directly; otherwise (Rust score-only
 * path, or an older artifact that omitted pillars), recompute A/P/R/Q from the full
 * baseline entity `e`, which retains stars/forks/meta_json so the authority pillar
 * is reconstructed identically to the 2/4 stage.
 *
 * PR-C (#2140 generalization): the prior version stamped ONLY A/P/R/Q, leaving fni_s
 * and raw_pop at the stale baseline registry shard (same #2140 class, ×2 more fields).
 * S (semantic) and raw_pop never live in the score-map, so BOTH are always recomputed
 * from `e` via one calculateFniFFI call. S=50.0 here is the documented factory-time
 * neutral placeholder (SSR overrides it with real cosine sim at query time) — same
 * input → same deterministic value, so it stays consistent with the artifact score.
 */
import { calculateFniFFI } from './rust-bridge.js';

/**
 * Overlay the 2/4 artifact's FNI pillars onto entity `e` (mutates `e`).
 * Stamps all of S/A/P/R/Q + raw_pop so the pillar cards stay consistent with
 * fni_score (which the caller has already set to the artifact score).
 * @param {object} e baseline entity (full, retains stars/forks/meta_json)
 * @param {object|number} artifactEntry fniMap value (number=score, or {score,a,p,r,q})
 */
export function applyArtifactPillars(e, artifactEntry) {
    // S and raw_pop are never carried in either map shape — recompute once from the
    // full baseline entity (deterministic; matches the 2/4 score for the same input).
    const result = calculateFniFFI(e, { includeMetrics: true, lastSeen: e._last_seen });
    e.fni_s = result.metrics.s;
    e.raw_pop = result.rawPop;

    const hasPillars = typeof artifactEntry === 'object' && artifactEntry !== null
        && artifactEntry.a != null;
    if (hasPillars) {
        // A/P/R/Q carried by the JS buildFniMap — use the fresh 2/4 values.
        if (artifactEntry.a != null) e.fni_a = artifactEntry.a;
        if (artifactEntry.p != null) e.fni_p = artifactEntry.p;
        if (artifactEntry.r != null) e.fni_r = artifactEntry.r;
        if (artifactEntry.q != null) e.fni_q = artifactEntry.q;
    } else {
        // Score-only map (Rust path): reuse the recompute above for A/P/R/Q too.
        e.fni_a = result.metrics.a; e.fni_p = result.metrics.p;
        e.fni_r = result.metrics.r; e.fni_q = result.metrics.q;
    }
    if (e.fni_metrics && typeof e.fni_metrics === 'object') {
        e.fni_metrics = { ...e.fni_metrics, s: e.fni_s, a: e.fni_a, p: e.fni_p, r: e.fni_r, q: e.fni_q };
    }
}

/**
 * Distiller-side FNI pillar promotion (mutates `e`). PR-C honest-contract:
 * when EVERY A/P/R/Q is genuinely absent, recompute the whole vector from the
 * entity (deterministic, matches the factory formula) rather than default-filling
 * A/P/R/Q=0 — a fabricated measured-zero authority/popularity/recency/quality. S
 * keeps the documented neutral 50.0 query-time-overridden default.
 * @param {object} e entity (mutated)
 * @param {object} meta parsed meta_json (carries legacy fni_metrics / fni.* shapes)
 */
export function promoteFniPillars(e, meta = {}) {
    const fm = e.fni_metrics || meta.fni_metrics || meta.fni?.metrics || {};
    const fa = e.fni_a ?? fm.a ?? fm.v ?? meta.fni?.v;
    const fp = e.fni_p ?? fm.p ?? meta.fni?.p;
    const fr = e.fni_r ?? fm.r ?? fm.f ?? meta.fni?.f;
    const fq = e.fni_q ?? fm.q;
    if (fa == null && fp == null && fr == null && fq == null) {
        const m = calculateFniFFI(e, { includeMetrics: true, lastSeen: e._last_seen });
        e.fni_s ??= m.metrics.s; e.fni_a ??= m.metrics.a; e.fni_p ??= m.metrics.p;
        e.fni_r ??= m.metrics.r; e.fni_q ??= m.metrics.q; e.raw_pop ??= m.rawPop;
        return;
    }
    e.fni_s ??= fm.s ?? 50.0; // Semantic — factory neutral default (query-time override)
    e.fni_a ??= fa ?? 0; e.fni_p ??= fp ?? 0; e.fni_r ??= fr ?? 0; e.fni_q ??= fq ?? 0;
}
