// scripts/factory/runner-capacity-preflight.test.mjs
//
// Hermetic node:test suite for the pipeline-wide runner capacity preflight gates
// (Founder ruling D-2026-0707-297, PR-B). NO network, NO R2, NO runner mutation:
// pure functions + static workflow-YAML step-order assertions (node built-ins
// only). Wired into the required `unit-test` job (.github/workflows/test-suite.yml).
//
// ANTI-VACUITY MAP (Founder §10 — removing/weakening a guard reds >=1 named test):
//   (1) disk-boundary        -> A1: free=required-1 => fail; free=required => pass.
//   (2) estimate-scaling     -> A2: doubling base doubles estimatedPeak (RED if the
//                                    estimate is made a constant).
//   (3) margin-enforcement   -> A3: margin changes the verdict (zero/ignored margin mutation reds).
//   (4) memory-boundary      -> A4: estimate clearly>cap => fail; well-under => pass;
//                                    config>RAM => fail.
//   (5) terminal-specificity -> A5: each phase exposes its EXACT named terminal code.
//   (6) workflow-ordering    -> A6: each gate step PRECEDES its heavy/publication step
//                                    in the SAME job (parsed from the yml); the 4/4
//                                    FINAL_UPLOAD gate precedes r2-upload-s3.js.
//   (7) healthy-fixture      -> A7: a well-provisioned synthetic runner passes ALL gates.
//   (8) RED-on-revert        -> A8: removing/bypassing ANY gate invocation from the
//                                    workflows reds this suite; factory-aggregate.yml
//                                    (PR-A / D-296 3/4 gate) is NOT touched by PR-B.
//
// FAILED-JOBS-RERUN STATEMENT (Founder §9): a failed capacity gate is a REAL
// shortfall; a bare "Re-run failed jobs" is NOT a fix — unless the phase's
// measured footprint, the runner class, or the measured inputs change, the gate
// re-fails (base/free are re-measured each run). This does not replace PR-D's
// deeper rerun-safety invariant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    evaluateDiskGate,
    evaluateMemoryGate,
    diskTerminalCode,
    memoryTerminalCode,
    DEFAULT_MARGIN_BYTES,
    MEMORY_CLEARLY_FACTOR,
    PHASE_SPECS,
} from './lib/runner-capacity-preflight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF = path.resolve(HERE, '../../.github/workflows');
const readWf = (f) => fs.readFileSync(path.join(WF, f), 'utf-8');

const PHASES = ['HARVEST_J5_MERGE', 'PROCESS_CONSOLIDATE', 'PROCESS_SHARD', 'UPLOAD_MASTER_FUSION', 'UPLOAD_PACKER', 'FINAL_UPLOAD'];

// Gate → (workflow file, heavy-step command that MUST run AFTER the gate).
const GATE_ORDER = [
    { phase: 'HARVEST_J5_MERGE', file: 'factory-harvest.yml', heavy: 'scripts/ingestion/merge-batches.js' },
    { phase: 'PROCESS_CONSOLIDATE', file: 'factory-process.yml', heavy: 'scripts/factory/split-registry.js' },
    { phase: 'PROCESS_SHARD', file: 'factory-process.yml', heavy: 'scripts/factory/shard-processor.js' },
    { phase: 'UPLOAD_MASTER_FUSION', file: 'factory-upload.yml', heavy: 'scripts/factory/master-fusion.js' },
    { phase: 'UPLOAD_PACKER', file: 'factory-upload.yml', heavy: 'scripts/factory/pack-db.js' },
    { phase: 'FINAL_UPLOAD', file: 'factory-upload.yml', heavy: 'scripts/factory/r2-upload-s3.js' },
];

// Slice the yml region of the job that CONTAINS `needle`. Job keys are 2-space
// indented (`^  name:`); a job runs to the next job key or EOF.
function jobSliceContaining(yml, needle) {
    const at = yml.indexOf(needle);
    assert.ok(at >= 0, `needle not found: ${needle}`);
    const jobKey = /^  [A-Za-z0-9_-]+:\s*$/gm;
    let start = 0, end = yml.length, m;
    const bounds = [];
    while ((m = jobKey.exec(yml)) !== null) bounds.push(m.index);
    for (let i = 0; i < bounds.length; i++) {
        if (bounds[i] <= at) { start = bounds[i]; end = bounds[i + 1] ?? yml.length; }
        else break;
    }
    return { start, end, slice: yml.slice(start, end), at };
}

// ── (1) disk-boundary ─────────────────────────────────────────────────────────
test('A1: disk-boundary — free=required-1 FAILS closed; free=required PASSES', () => {
    const base = 4 * 1e9, factor = 2.5, margin = DEFAULT_MARGIN_BYTES;
    const probe = evaluateDiskGate({ phase: 'PROCESS_SHARD', measuredFreeBytes: 0, measuredInputBaseBytes: base, phaseFactor: factor, marginBytes: margin });
    const required = probe.requiredTotalBytes;
    assert.equal(required, Math.ceil(base * factor) + margin);
    const below = evaluateDiskGate({ phase: 'PROCESS_SHARD', measuredFreeBytes: required - 1, measuredInputBaseBytes: base, phaseFactor: factor, marginBytes: margin });
    const exact = evaluateDiskGate({ phase: 'PROCESS_SHARD', measuredFreeBytes: required, measuredInputBaseBytes: base, phaseFactor: factor, marginBytes: margin });
    assert.equal(below.ok, false, 'one byte below required must fail closed');
    assert.equal(exact.ok, true, 'exactly required must pass');
});

// ── (2) estimate-scaling ────────────────────────────────────────────────────
test('A2: estimate-scaling — doubling the measured base doubles estimatedPeak (RED if constant)', () => {
    const factor = 2.5;
    const e1 = evaluateDiskGate({ phase: 'HARVEST_J5_MERGE', measuredFreeBytes: 0, measuredInputBaseBytes: 3e9, phaseFactor: factor });
    const e2 = evaluateDiskGate({ phase: 'HARVEST_J5_MERGE', measuredFreeBytes: 0, measuredInputBaseBytes: 6e9, phaseFactor: factor });
    assert.equal(e1.estimatedPeakBytes, Math.ceil(3e9 * factor));
    assert.equal(e2.estimatedPeakBytes, e1.estimatedPeakBytes * 2, 'estimate must scale linearly with the measured base');
    assert.equal(evaluateDiskGate({ phase: 'HARVEST_J5_MERGE', measuredFreeBytes: 0, measuredInputBaseBytes: 0, phaseFactor: factor }).estimatedPeakBytes, 0);
});

// ── (3) margin-enforcement ──────────────────────────────────────────────────
test('A3: margin-enforcement — margin changes the verdict (zero-margin mutation reds)', () => {
    const base = 5e9, factor = 2.0;
    const peak = Math.ceil(base * factor);
    // free exactly == peak (no room for margin): with the real margin it FAILS,
    // with a bypassed (zero) margin it would PASS — proving margin is enforced.
    assert.equal(evaluateDiskGate({ phase: 'UPLOAD_PACKER', measuredFreeBytes: peak, measuredInputBaseBytes: base, phaseFactor: factor }).ok, false);
    assert.equal(evaluateDiskGate({ phase: 'UPLOAD_PACKER', measuredFreeBytes: peak, measuredInputBaseBytes: base, phaseFactor: factor, marginBytes: 0 }).ok, true);
    assert.equal(evaluateDiskGate({ phase: 'UPLOAD_PACKER', measuredFreeBytes: peak + DEFAULT_MARGIN_BYTES, measuredInputBaseBytes: base, phaseFactor: factor }).ok, true);
});

// ── (4) memory-boundary ─────────────────────────────────────────────────────
test('A4: memory-boundary — estimate clearly>cap FAILS; well-under PASSES; config>RAM FAILS', () => {
    const oldSpace = 6 * 1024 ** 3, ram = 16 * 1024 ** 3; // 6 GiB heap on 16 GiB RAM
    const cap = Math.min(oldSpace, ram); // = oldSpace
    // Clearly exceeds: estimate 2× the clear-threshold => FAIL.
    const over = evaluateMemoryGate({ phase: 'UPLOAD_MASTER_FUSION', estimatedPeakHeapBytes: Math.ceil(cap * MEMORY_CLEARLY_FACTOR) * 2, oldSpaceLimitBytes: oldSpace, availableRamBytes: ram });
    assert.equal(over.ok, false);
    assert.equal(over.estimateClearlyExceeds, true);
    // Just over the ceiling but NOT clearly (within clearlyFactor) => still PASS (coarse guard, no false-fail).
    const marginal = evaluateMemoryGate({ phase: 'UPLOAD_MASTER_FUSION', estimatedPeakHeapBytes: cap + 1, oldSpaceLimitBytes: oldSpace, availableRamBytes: ram });
    assert.equal(marginal.ok, true, 'a marginal overage must NOT fail — clearly-exceeds only');
    // Well under => PASS.
    assert.equal(evaluateMemoryGate({ phase: 'UPLOAD_MASTER_FUSION', estimatedPeakHeapBytes: cap / 4, oldSpaceLimitBytes: oldSpace, availableRamBytes: ram }).ok, true);
    // Configured heap > physical RAM => unambiguous FAIL regardless of estimate.
    const cfg = evaluateMemoryGate({ phase: 'UPLOAD_MASTER_FUSION', estimatedPeakHeapBytes: 1, oldSpaceLimitBytes: 20 * 1024 ** 3, availableRamBytes: 16 * 1024 ** 3 });
    assert.equal(cfg.ok, false);
    assert.equal(cfg.configExceedsHardware, true);
});

// ── (5) terminal-specificity ────────────────────────────────────────────────
test('A5: terminal-specificity — each phase exposes its EXACT named terminal code', () => {
    for (const phase of PHASES) {
        const d = evaluateDiskGate({ phase, measuredFreeBytes: 0, measuredInputBaseBytes: 1e9, phaseFactor: 2 });
        assert.equal(d.ok, false);
        assert.equal(d.terminalCode, `INSUFFICIENT_RUNNER_DISK_${phase}`);
        const m = evaluateMemoryGate({ phase, estimatedPeakHeapBytes: 99e9, oldSpaceLimitBytes: 1e9, availableRamBytes: 2e9 });
        assert.equal(m.terminalCode, `INSUFFICIENT_RUNNER_MEMORY_${phase}`);
    }
    // helpers agree with the pure-fn output
    assert.equal(diskTerminalCode('FINAL_UPLOAD'), 'INSUFFICIENT_RUNNER_DISK_FINAL_UPLOAD');
    assert.equal(memoryTerminalCode('HARVEST_J5_MERGE'), 'INSUFFICIENT_RUNNER_MEMORY_HARVEST_J5_MERGE');
    // every terminal code phase suffix is a real PHASE_SPECS entry (no orphan codes)
    for (const phase of PHASES) assert.ok(PHASE_SPECS[phase], `PHASE_SPECS missing ${phase}`);
});

// ── (6) workflow-ordering + (8) RED-on-revert ───────────────────────────────
test('A6/A8: each gate PRECEDES its heavy step in the SAME job; removing a gate reds', () => {
    for (const { phase, file, heavy } of GATE_ORDER) {
        const yml = readWf(file);
        const invocation = `runner-capacity-preflight.mjs ${phase}`;
        // (8) presence: bypassing/removing the gate invocation reds here.
        assert.ok(yml.includes(invocation), `${file}: missing capacity gate invocation for ${phase}`);
        assert.ok(yml.includes(heavy), `${file}: heavy step ${heavy} not found`);
        // (6) ordering: the gate must be in the SAME job as the heavy step and precede it.
        const { slice, start } = jobSliceContaining(yml, heavy);
        const gateIdx = slice.indexOf(invocation);
        const heavyIdx = slice.indexOf(heavy);
        assert.ok(gateIdx >= 0, `${file}: gate ${phase} not in the same job as ${heavy}`);
        assert.ok(gateIdx < heavyIdx, `${file}: gate ${phase} must PRECEDE ${heavy} (gate@${start + gateIdx} < heavy@${start + heavyIdx})`);
    }
});

test('A6b: the 4/4 FINAL_UPLOAD gate precedes ANY public write (r2-upload-s3.js) — no partial-publish window', () => {
    const yml = readWf('factory-upload.yml');
    const { slice } = jobSliceContaining(yml, 'scripts/factory/r2-upload-s3.js');
    const gateIdx = slice.indexOf('runner-capacity-preflight.mjs FINAL_UPLOAD');
    const publishIdx = slice.indexOf('scripts/factory/r2-upload-s3.js');
    assert.ok(gateIdx >= 0 && gateIdx < publishIdx, 'FINAL_UPLOAD gate must precede the sole public CDN write');
    // r2-upload-s3.js is the ONLY public CDN publish in the upload job (state/ backups
    // are producer-internal). Assert it appears exactly once so the gate covers it.
    const occurrences = slice.split('scripts/factory/r2-upload-s3.js').length - 1;
    assert.equal(occurrences, 1, 'exactly one public CDN write step in the upload job');
});

test('A8b: PR-B does NOT touch factory-aggregate.yml (the PR-A / D-296 3/4 gate stays authoritative)', () => {
    const agg = readWf('factory-aggregate.yml');
    assert.ok(!agg.includes('runner-capacity-preflight'), 'factory-aggregate.yml must NOT reference PR-B capacity preflight (3/4 already gated by PR-A)');
    // sanity: PR-A's own 3/4 disk gate is still present + untouched
    assert.ok(agg.includes('INSUFFICIENT_RUNNER_DISK_FINALIZATION'), 'PR-A 3/4 gate must remain');
});

// ── (7) healthy-fixture ──────────────────────────────────────────────────────
test('A7: healthy-fixture — a well-provisioned synthetic runner passes ALL gates', () => {
    // Synthetic ubuntu-latest: ~14 GiB free after cleanup, 16 GiB RAM, modest inputs.
    const freeBytes = 14 * 1024 ** 3;
    const ram = 16 * 1024 ** 3;
    for (const [phase, spec] of Object.entries(PHASE_SPECS)) {
        const baseBytes = 1.2 * 1024 ** 3; // ~1.2 GiB measured input base (healthy)
        if (spec.mode === 'disk' || spec.mode === 'both') {
            const d = evaluateDiskGate({ phase, measuredFreeBytes: freeBytes, measuredInputBaseBytes: baseBytes, phaseFactor: spec.phaseFactor, marginBytes: spec.marginBytes });
            assert.equal(d.ok, true, `healthy disk gate should pass for ${phase} (required ${d.requiredTotalBytes} <= free ${freeBytes})`);
        }
        if (spec.mode === 'mem' || spec.mode === 'both') {
            const oldSpace = 8 * 1024 ** 3; // representative --max-old-space-size
            const est = Math.ceil(baseBytes * (spec.heapExpansionFactor || 0));
            const m = evaluateMemoryGate({ phase, estimatedPeakHeapBytes: est, oldSpaceLimitBytes: oldSpace, availableRamBytes: ram });
            assert.equal(m.ok, true, `healthy memory gate should pass for ${phase}`);
        }
    }
});

// ── extra: pure-fn field contract (Founder §4 exact shape) ───────────────────
test('DISK field contract — all Founder §4 fields present + typed on pass AND fail', () => {
    for (const free of [0, 999e9]) {
        const r = evaluateDiskGate({ phase: 'UPLOAD_PACKER', measuredFreeBytes: free, measuredInputBaseBytes: 2e9, phaseFactor: 3.0 });
        for (const k of ['measuredFreeBytes', 'measuredInputBaseBytes', 'phaseFactor', 'estimatedPeakBytes', 'requiredMarginBytes', 'requiredTotalBytes']) {
            assert.equal(typeof r[k], 'number', `field ${k} must be a number`);
        }
        assert.equal(r.estimatedPeakBytes, Math.ceil(2e9 * 3.0));
        assert.equal(r.requiredTotalBytes, r.estimatedPeakBytes + r.requiredMarginBytes);
        assert.equal(r.terminalCode, 'INSUFFICIENT_RUNNER_DISK_UPLOAD_PACKER');
        assert.equal(typeof r.ok, 'boolean');
    }
});
