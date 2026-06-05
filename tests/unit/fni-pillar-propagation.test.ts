/**
 * FNI gh-authority pillar propagation guard.
 *
 * DEFECT: every github-sourced entity surfaced fni.factors.authority=0 even though
 * stars+forks were populated. Two load-bearing root causes:
 *   1. fni-score.js estimateMeshPoints read ONLY top-level entity.stars/forks; the
 *      gh adapters write stars into meta_json.stars, so a recompute over a baseline
 *      that had not been re-promoted (processor-core.js 2/4 stage) saw 0 stars -> a=0.
 *   2. aggregator.js overlaid only fni_score from the 2/4 artifact, never the pillars,
 *      so the surfaced fni_a fell back to the previous bake's stale registry baseline.
 *
 * These tests are Rust-absent (initRustBridge is never called) so the verified JS
 * fallback path executes — the exact degraded prod path under test.
 */
import { describe, it, expect } from 'vitest';
import { calculateFNI } from '../../scripts/factory/lib/fni-score.js';
import { applyArtifactPillars } from '../../scripts/factory/lib/fni-pillar-overlay.js';

// gh entity whose stars live ONLY in meta_json (the baseline-not-re-promoted case).
const ghEntityMetaOnly = {
    id: 'gh-tool--ollama--ollama',
    type: 'tool',
    meta_json: JSON.stringify({ stars: 173119, forks: 16423 }),
    last_modified: new Date().toISOString(),
};

describe('FNI gh-authority — root cause #1 (meta_json stars fallback)', () => {
    it('computes a > 0 from meta_json.stars when top-level stars is absent', () => {
        const r = calculateFNI(ghEntityMetaOnly, { includeMetrics: true });
        // Authority pillar must be non-zero (driven by stars+forks), not 0.
        expect(r.metrics.a).toBeGreaterThan(0);
    });

    it('top-level stars still works (no regression)', () => {
        const r = calculateFNI(
            { id: 'gh-tool--x--y', type: 'tool', stars: 1000, forks: 50,
              last_modified: new Date().toISOString() },
            { includeMetrics: true });
        expect(r.metrics.a).toBeGreaterThan(0);
    });
});

describe('FNI gh-authority — root cause #2 (aggregator pillar overlay)', () => {
    it('JS path: overlays artifact pillars onto a stale-baseline entity', () => {
        // Baseline entity carries the previous bake's stale fni_a=0.
        const e = { id: 'gh-tool--ollama--ollama', type: 'tool', fni_a: 0, fni_p: 0,
                    fni_r: 0, fni_q: 0 };
        // buildFniMap value shape: { score, a, p, r, q } from the 2/4 artifact.
        applyArtifactPillars(e, { score: 60, a: 62.9, p: 80, r: 40, q: 55 });
        expect(e.fni_a).toBe(62.9);
        expect(e.fni_p).toBe(80);
    });

    it('Rust score-only path: recomputes pillars from the full baseline entity', () => {
        // Rust direct map carries only a score (a number) — pillars must be
        // recomputed from `e`, which retains meta_json stars/forks.
        const e = { ...ghEntityMetaOnly, fni_a: 0, fni_p: 0, fni_r: 0, fni_q: 0 };
        applyArtifactPillars(e, 60); // bare-number map value (Rust path)
        expect(e.fni_a).toBeGreaterThan(0);
    });
});

describe('FNI authority — hf / paper no-regression', () => {
    it('hf entity authority unchanged (likes-driven, > 0)', () => {
        const r = calculateFNI(
            { id: 'hf-model--meta-llama--llama-3-8b', type: 'model', popularity: 5000,
              last_modified: new Date().toISOString() },
            { includeMetrics: true });
        expect(r.metrics.a).toBeGreaterThan(0);
    });
});
