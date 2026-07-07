// scripts/factory/aggregate-bounded-finalization.test.mjs
//
// Hermetic node:test suite for the Factory 3/4 finalization bounded-footprint
// repair (Founder ruling D-2026-0707-295, PR-A). NO network, NO R2, NO @aws-sdk:
// pure functions + real temp dirs (node built-ins + local zstd only).
//
// ANTI-VACUITY MAP (removing/weakening a guard reds >=1 named test):
//   * df-gate fail-closed (C1)      -> (G1) free < peak+margin => ok=false + terminal code;
//                                      make the gate warning-only / always-ok => G1 flips green-when-broke.
//   * df-gate is MEASURED not const -> (G2) doubling measured sizes doubles the estimate; a constant estimate
//                                      => G2 reds. (G3) margin is enforced (free==peak w/o margin still fails).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    estimateFinalizationPeakBytes,
    evaluateDiskGate,
    DISK_GATE_TERMINAL_CODE,
    FINALIZATION_MARGIN_BYTES,
    FINALIZATION_SAFETY_FACTOR,
} from './lib/aggregator-maintenance.js';

// ---------- Component 1: df-gate ---------------------------------------------

test('G1: df-gate FAILS CLOSED when free < estimated peak + margin (terminal code)', () => {
    const sizes = { fniBytes: 3 * 1e9, regBytes: 1 * 1e9, trendBytes: 0.5e9 }; // 4.5 GB base
    const peak = estimateFinalizationPeakBytes(sizes);
    const r = evaluateDiskGate({ freeBytes: peak + FINALIZATION_MARGIN_BYTES - 1, sizes });
    assert.equal(r.ok, false, 'one byte below required must fail closed');
    assert.equal(r.terminalCode, DISK_GATE_TERMINAL_CODE);
    assert.equal(r.terminalCode, 'INSUFFICIENT_RUNNER_DISK_FINALIZATION');
    // reports all four telemetry fields on the fail path
    for (const k of ['measuredFreeBytes', 'estimatedPeakBytes', 'requiredMarginBytes', 'requiredTotalBytes']) {
        assert.equal(typeof r[k], 'number');
    }
    // passes with exactly enough
    const ok = evaluateDiskGate({ freeBytes: peak + FINALIZATION_MARGIN_BYTES, sizes });
    assert.equal(ok.ok, true, 'exactly peak+margin must pass');
});

test('G2: estimate is MEASURED not constant — doubling sizes doubles the estimate', () => {
    const base = { fniBytes: 1e9, regBytes: 2e9, trendBytes: 0.3e9 };
    const dbl = { fniBytes: 2e9, regBytes: 4e9, trendBytes: 0.6e9 };
    const e1 = estimateFinalizationPeakBytes(base);
    const e2 = estimateFinalizationPeakBytes(dbl);
    assert.equal(e2, e1 * 2, 'estimate must scale linearly with measured on-disk sizes');
    assert.equal(e1, Math.ceil((1e9 + 2e9 + 0.3e9) * FINALIZATION_SAFETY_FACTOR));
    // an all-zero measured base yields a zero peak (pure margin gate) — not a constant floor
    assert.equal(estimateFinalizationPeakBytes({ fniBytes: 0, regBytes: 0, trendBytes: 0 }), 0);
});

test('G3: margin is enforced — free == peak (no margin room) still fails', () => {
    const sizes = { fniBytes: 5e9, regBytes: 5e9, trendBytes: 0 };
    const peak = estimateFinalizationPeakBytes(sizes);
    assert.equal(evaluateDiskGate({ freeBytes: peak, sizes }).ok, false);
    assert.equal(evaluateDiskGate({ freeBytes: peak + FINALIZATION_MARGIN_BYTES, sizes }).ok, true);
});
