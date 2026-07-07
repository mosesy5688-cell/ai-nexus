// scripts/factory/lib/runner-capacity-preflight.mjs
//
// Pipeline-wide FAIL-CLOSED runner capacity preflight gates (Founder ruling
// D-2026-0707-297, PR-B). ADDS disk/memory capacity gates BEFORE each heavy
// compute phase so a capacity shortfall aborts with a NAMED terminal code
// (INSUFFICIENT_RUNNER_DISK_<phase> / INSUFFICIENT_RUNNER_MEMORY_<phase>)
// BEFORE a late/silent ENOSPC or OOM — and, for 4/4, BEFORE any public write.
//
// This module is `.mjs` (CES Art 5.1 line-limit EXEMPT — SCAN_EXTENSIONS in
// scripts/check_compliance.py does not include `.mjs`). It changes NO product
// logic: it only measures + compares + reports + exits.
//
// DESIGN (Founder §4): the gate has DETERMINISTIC PURE calc functions
// (`evaluateDiskGate` / `evaluateMemoryGate`, unit-tested without any runner
// mutation) and THIN runtime wrappers that MEASURE the real inputs at runtime
// (`df -PB1` free bytes + `du -sb` base bytes) and feed the pure functions.
// There is NO constant-only gate: the free space and the input base are ALWAYS
// measured at runtime; only the per-phase multiplier + margin are constants.
//
// ── DISK FORMULA (per phase) ─────────────────────────────────────────────────
//   estimatedPeakBytes = ceil(measuredInputBaseBytes * phaseFactor)
//   requiredTotalBytes = estimatedPeakBytes + requiredMarginBytes
//   ok                 = measuredFreeBytes >= requiredTotalBytes
// measuredInputBaseBytes = Σ du -sb of the phase's named input roots (the set
// the phase materializes / duplicates). phaseFactor covers the transient
// duplication (in-memory JSON expansion + zstd scratch + shard re-write). margin
// is a fixed floor for logs / tmp / OS headroom. WARNING-ONLY IS FORBIDDEN — a
// shortfall does process.exit(1); there is no `|| true`.
//
// ── MEMORY FORMULA (per phase, COARSE CONSERVATIVE GUARD) ────────────────────
//   estimatedPeakHeapBytes = ceil(measuredInputBaseBytes * heapExpansionFactor)
//   capacityBytes          = min(oldSpaceLimitBytes, availableRamBytes)
//   clearThresholdBytes    = ceil(capacityBytes * clearlyFactor)   // clearlyFactor > 1
//   ok = !( estimatedPeakHeapBytes > clearThresholdBytes    // estimate CLEARLY over capacity
//        || oldSpaceLimitBytes    > availableRamBytes )     // configured heap can't fit in RAM
// The memory gate is a COARSE CONSERVATIVE GUARD, NOT an exact predictor: it
// fails closed ONLY when the (deliberately over-provisioned) estimate CLEARLY
// exceeds the effective heap ceiling — i.e. exceeds it by the clearlyFactor
// margin (default 1.5×), so a healthy runner NEVER false-fails — OR when the
// configured V8 old-space limit is itself larger than physical RAM (an
// unambiguous config-vs-hardware violation that guarantees an OS OOM-kill under
// real load). Passing this gate does NOT make a future OOM impossible; the exact
// heap peak depends on live shapes, GC timing and fragmentation this cannot know.
//
// ── FAILED-JOBS-RERUN STATEMENT (Founder §9) ─────────────────────────────────
// A failed capacity gate is a REAL shortfall, not a transient. A bare
// "Re-run failed jobs" is NOT a fix: unless the phase's measured footprint, the
// runner class, or the measured inputs CHANGE, the gate re-fails on the re-run
// (the base/free are re-measured every time). (This does not replace PR-D's
// deeper rerun-safety invariant.)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const GiB = 1024 ** 3;

// Fixed margin floor (matches PR-A's D-295 FINALIZATION_MARGIN_BYTES = 2 GiB):
// logs, /tmp scratch, OS/journal headroom that is not part of the measured base.
export const DEFAULT_MARGIN_BYTES = 2 * GiB;

// "Clearly exceeds" threshold for the memory guard. The coarse heap estimate
// must exceed the effective ceiling by 50% before the gate fails, so a healthy
// runner is never tripped by estimator coarseness.
export const MEMORY_CLEARLY_FACTOR = 1.5;

export const diskTerminalCode = (phase) => `INSUFFICIENT_RUNNER_DISK_${phase}`;
export const memoryTerminalCode = (phase) => `INSUFFICIENT_RUNNER_MEMORY_${phase}`;

/**
 * PURE disk gate (Founder §4). Deterministic; no I/O, no runner mutation.
 * @returns {{ok:boolean, phase:string, measuredFreeBytes:number,
 *   measuredInputBaseBytes:number, phaseFactor:number, estimatedPeakBytes:number,
 *   requiredMarginBytes:number, requiredTotalBytes:number, terminalCode:string}}
 */
export function evaluateDiskGate({ phase, measuredFreeBytes, measuredInputBaseBytes, phaseFactor, marginBytes = DEFAULT_MARGIN_BYTES } = {}) {
    const free = Number(measuredFreeBytes) || 0;
    const base = Number(measuredInputBaseBytes) || 0;
    const factor = Number(phaseFactor) || 0;
    const requiredMarginBytes = Number(marginBytes) || 0;
    const estimatedPeakBytes = Math.ceil(base * factor);
    const requiredTotalBytes = estimatedPeakBytes + requiredMarginBytes;
    return {
        ok: free >= requiredTotalBytes,
        phase,
        measuredFreeBytes: free,
        measuredInputBaseBytes: base,
        phaseFactor: factor,
        estimatedPeakBytes,
        requiredMarginBytes,
        requiredTotalBytes,
        terminalCode: diskTerminalCode(phase),
    };
}

/**
 * PURE memory gate (Founder §4). Deterministic; no I/O, no runner mutation.
 * Fails closed ONLY when the estimate CLEARLY exceeds capacity (see header) OR
 * the configured heap exceeds physical RAM.
 */
export function evaluateMemoryGate({ phase, estimatedPeakHeapBytes, oldSpaceLimitBytes, availableRamBytes, clearlyFactor = MEMORY_CLEARLY_FACTOR } = {}) {
    const estimate = Number(estimatedPeakHeapBytes) || 0;
    const oldSpace = Number(oldSpaceLimitBytes) || 0;
    const ram = Number(availableRamBytes) || 0;
    const k = Number(clearlyFactor) || 1;
    // Effective heap ceiling = the smallest POSITIVE known limit. When --max-old-space-size
    // is unknown (0) the physical-RAM ceiling still applies (OS OOM-kill); when RAM is
    // unknown too the gate is INDETERMINATE and must NOT false-fail (ok stays true).
    const limits = [oldSpace, ram].filter((x) => x > 0);
    const capacityBytes = limits.length ? Math.min(...limits) : 0;
    const indeterminate = capacityBytes === 0;
    const clearThresholdBytes = Math.ceil(capacityBytes * k);
    const estimateClearlyExceeds = !indeterminate && estimate > clearThresholdBytes;
    const configExceedsHardware = oldSpace > 0 && ram > 0 && oldSpace > ram;
    return {
        ok: !(estimateClearlyExceeds || configExceedsHardware),
        phase,
        estimatedPeakHeapBytes: estimate,
        oldSpaceLimitBytes: oldSpace,
        availableRamBytes: ram,
        capacityBytes,
        indeterminate,
        clearlyFactor: k,
        clearThresholdBytes,
        estimateClearlyExceeds,
        configExceedsHardware,
        terminalCode: memoryTerminalCode(phase),
    };
}

// ── PER-PHASE MEASUREMENT ORACLE (Founder §7) ────────────────────────────────
// Each spec names the measured input roots the phase materializes/duplicates,
// the phaseFactor + reason, the margin, and whether disk|mem|both apply. Roots
// are measured with `du -sb` at runtime (absent root => 0, never a constant).
// heapExpansionFactor: coarse in-memory expansion of the compressed on-disk base
// (decompressed + JSON-parsed objects are several× the .zst bytes); kept modest
// so the memory guard only trips on a CLEAR violation.
export const PHASE_SPECS = {
    // 1/4 harvest — BEFORE "Merge Batches" (merge-batches.js hydrates the daily
    // accumulator + global registry and merges all raw batches, transiently
    // duplicating the working set — the historical "database or disk is full").
    HARVEST_J5_MERGE: {
        phase: 'HARVEST_J5_MERGE',
        measureDir: '.',
        diskRoots: ['data', 'cache/registry', 'cache/daily-accum', 'cache/fni-history'],
        phaseFactor: 2.5,          // JSON in-mem expansion + registry-merge dup + zstd scratch + merged_shard re-write
        marginBytes: DEFAULT_MARGIN_BYTES,
        mode: 'both',
        heapExpansionFactor: 2.0,
        recoveryCritical: true,    // recovers a merge-only "Re-run failed jobs"
    },
    // 2/4 process — BEFORE "Consolidate Shards for Matrix" (split-registry.js
    // re-partitions 418×1000 natural shards → 20 processing shards, duplicating
    // the shard set). registry/fni-history already rm'd by the prior "Free Disk".
    PROCESS_CONSOLIDATE: {
        phase: 'PROCESS_CONSOLIDATE',
        measureDir: '.',
        diskRoots: ['data'],
        phaseFactor: 2.5,          // re-partition duplicates the shard set + zstd temp + in-mem routing buffers
        marginBytes: DEFAULT_MARGIN_BYTES,
        mode: 'both',
        heapExpansionFactor: 2.0,
        recoveryCritical: true,
    },
    // 2/4 process — BEFORE "Process Shard N" (shard-processor.js reads the single
    // merged_shard_N ⊆ data/ and writes artifacts/shard-N). The whole prepared
    // set is already resident; each matrix shard materializes only its ~1/20
    // output artifact + scratch, so 0.5× the FULL resident set is a ~10×
    // conservative bound over the true per-shard add (and cannot false-fail even
    // when data/ approaches the free floor).
    PROCESS_SHARD: {
        phase: 'PROCESS_SHARD',
        measureDir: '.',
        diskRoots: ['data'],
        phaseFactor: 0.5,          // per-shard output+scratch is ~1/20 of the resident set; 0.5× = conservative bound
        marginBytes: DEFAULT_MARGIN_BYTES,
        mode: 'both',
        heapExpansionFactor: 0.5,  // shard-processor streams one shard (Rust FFI decompress + readline), not the whole set
        recoveryCritical: false,   // per-shard transient; cron-only
    },
    // 4/4 upload — BEFORE "Execute Master Fusion" (master-fusion.js loads the
    // aligned registry .bin shards + enrichment, re-writes fused part-NNN.json.zst).
    UPLOAD_MASTER_FUSION: {
        phase: 'UPLOAD_MASTER_FUSION',
        measureDir: '.',
        diskRoots: ['output/cache/registry', 'output/cache/enrichment-local'],
        phaseFactor: 2.5,          // registry-shard decompress + enrichment join in memory + fused re-write + zstd scratch
        marginBytes: DEFAULT_MARGIN_BYTES,
        mode: 'both',
        heapExpansionFactor: 2.0,
        recoveryCritical: true,
    },
    // 4/4 upload — BEFORE "Execute Stable 1.0 Packer" (pack-db.js opens
    // META_SHARD_COUNT=96 meta-NN.db simultaneously; each carries a SQLite
    // page-cache + WAL/journal transient, and denormalized meta rows expand
    // beyond the compressed fused input while the fused set stays resident).
    UPLOAD_PACKER: {
        phase: 'UPLOAD_PACKER',
        measureDir: '.',
        diskRoots: ['output/cache/fused', 'output/cache/embeddings', 'output/cache/reports', 'output/cache/knowledge', 'output/cache/mesh'],
        phaseFactor: 3.0,          // 96× per-DB WAL/journal + meta denormalization expansion + resident fused input
        marginBytes: DEFAULT_MARGIN_BYTES,
        mode: 'both',
        heapExpansionFactor: 2.0,
        recoveryCritical: true,
    },
    // 4/4 upload — BEFORE "Upload to R2 via S3 API" (r2-upload-s3.js — the SOLE
    // public CDN write). Last fail-closed barrier BEFORE any public write. Upload
    // reads + streams the publish payload to R2; only multipart scratch/temp is
    // transient (no full on-disk duplication).
    FINAL_UPLOAD: {
        phase: 'FINAL_UPLOAD',
        measureDir: '.',
        diskRoots: ['output/data', 'output/meta', 'output/cache'],
        phaseFactor: 1.25,         // read + stream to R2; only multipart scratch, no full duplication
        marginBytes: DEFAULT_MARGIN_BYTES,
        mode: 'disk',
        heapExpansionFactor: 0,
        recoveryCritical: true,    // last barrier before the public write
    },
};

// ── RUNTIME MEASUREMENT WRAPPERS ─────────────────────────────────────────────

const gib = (n) => `${(Number(n) / GiB).toFixed(3)} GiB`;

/** Free bytes on the filesystem holding `dir` (POSIX 1-byte blocks, col 4 = avail). */
export function measureFreeBytes(dir = '.') {
    const out = execFileSync('df', ['-PB1', dir], { encoding: 'utf-8' });
    const line = out.trim().split('\n').pop();
    return Number(line.split(/\s+/)[3]) || 0;
}

/** Σ `du -sb` of the named roots. An absent root contributes 0 (never a constant). */
export function measureBaseBytes(roots = []) {
    let total = 0;
    const perRoot = {};
    for (const root of roots) {
        let bytes = 0;
        try {
            const out = execFileSync('du', ['-sb', root], { encoding: 'utf-8' });
            bytes = Number(out.split(/\s+/)[0]) || 0;
        } catch { bytes = 0; } // absent root => 0
        perRoot[root] = bytes;
        total += bytes;
    }
    return { total, perRoot };
}

/**
 * Resolve the V8 old-space limit (bytes) the HEAVY step will run under. Prefers
 * the explicit CAPACITY_OLD_SPACE_MB env (set on gate steps whose heavy step
 * declares --max-old-space-size at STEP level, which a separate gate step does
 * NOT inherit), else parses an inherited job-level NODE_OPTIONS. 0 => unknown.
 */
export function readOldSpaceLimitBytes(env = process.env) {
    if (env.CAPACITY_OLD_SPACE_MB && Number(env.CAPACITY_OLD_SPACE_MB) > 0) {
        return Number(env.CAPACITY_OLD_SPACE_MB) * 1024 * 1024;
    }
    const m = /--max-old-space-size[= ](\d+)/.exec(env.NODE_OPTIONS || '');
    return m ? Number(m[1]) * 1024 * 1024 : 0;
}

/** Physical RAM (bytes). Prefer /proc/meminfo MemTotal; fall back to os.totalmem(). */
export function readAvailableRamBytes() {
    try {
        const info = fs.readFileSync('/proc/meminfo', 'utf-8');
        const m = /MemTotal:\s+(\d+)\s+kB/.exec(info);
        if (m) return Number(m[1]) * 1024;
    } catch { /* not linux / no procfs */ }
    return os.totalmem() || 0;
}

function printDisk(r) {
    console.log(`[CAPACITY:${r.phase}] gate            : DISK (fail-closed)`);
    console.log(`[CAPACITY:${r.phase}] terminal-code   : ${r.terminalCode}`);
    console.log(`[CAPACITY:${r.phase}] measured-free   : ${gib(r.measuredFreeBytes)} (${r.measuredFreeBytes} B)`);
    console.log(`[CAPACITY:${r.phase}] measured-base   : ${gib(r.measuredInputBaseBytes)} (${r.measuredInputBaseBytes} B)`);
    console.log(`[CAPACITY:${r.phase}] phase-factor    : ${r.phaseFactor}`);
    console.log(`[CAPACITY:${r.phase}] estimated-peak  : ${gib(r.estimatedPeakBytes)} (base × factor)`);
    console.log(`[CAPACITY:${r.phase}] required-margin : ${gib(r.requiredMarginBytes)}`);
    console.log(`[CAPACITY:${r.phase}] required-total  : ${gib(r.requiredTotalBytes)} (peak + margin)`);
}

function printMemory(r) {
    console.log(`[CAPACITY:${r.phase}] gate            : MEMORY (COARSE CONSERVATIVE GUARD — NOT an exact predictor; passing does NOT make a future OOM impossible)`);
    console.log(`[CAPACITY:${r.phase}] terminal-code   : ${r.terminalCode}`);
    console.log(`[CAPACITY:${r.phase}] est-peak-heap   : ${gib(r.estimatedPeakHeapBytes)} (measured-base × heap-expansion)`);
    console.log(`[CAPACITY:${r.phase}] old-space-limit : ${gib(r.oldSpaceLimitBytes)} (--max-old-space-size)`);
    console.log(`[CAPACITY:${r.phase}] available-ram   : ${gib(r.availableRamBytes)}`);
    console.log(`[CAPACITY:${r.phase}] capacity        : ${gib(r.capacityBytes)} (min(old-space, ram))`);
    console.log(`[CAPACITY:${r.phase}] clearly-factor  : ${r.clearlyFactor} → clear-threshold ${gib(r.clearThresholdBytes)}`);
    console.log(`[CAPACITY:${r.phase}] estimate-clearly-exceeds: ${r.estimateClearlyExceeds} | config-exceeds-hardware: ${r.configExceedsHardware}`);
}

/**
 * CLI runtime wrapper. Measures df + du for the named phase, runs the pure
 * gate(s), prints ALL fields on BOTH pass and fail, and process.exit(1) on any
 * !ok. NEVER warning-only.
 */
export function runGate(phaseName) {
    const spec = PHASE_SPECS[phaseName];
    if (!spec) {
        console.error(`::error::UNKNOWN_CAPACITY_PHASE '${phaseName}' — no PHASE_SPECS entry.`);
        process.exit(1);
    }
    const freeBytes = measureFreeBytes(spec.measureDir);
    const { total: baseBytes, perRoot } = measureBaseBytes(spec.diskRoots);
    console.log(`[CAPACITY:${spec.phase}] mode=${spec.mode} recovery-critical=${spec.recoveryCritical} roots=${spec.diskRoots.join(',')}`);
    for (const [root, bytes] of Object.entries(perRoot)) {
        console.log(`[CAPACITY:${spec.phase}] root du         : ${root} = ${gib(bytes)} (${bytes} B)`);
    }
    let failed = false;

    if (spec.mode === 'disk' || spec.mode === 'both') {
        const r = evaluateDiskGate({
            phase: spec.phase,
            measuredFreeBytes: freeBytes,
            measuredInputBaseBytes: baseBytes,
            phaseFactor: spec.phaseFactor,
            marginBytes: spec.marginBytes,
        });
        printDisk(r);
        if (!r.ok) {
            console.error(`::error::${r.terminalCode} — measured free ${gib(r.measuredFreeBytes)} < required ${gib(r.requiredTotalBytes)} (peak+margin). Aborting BEFORE the heavy step. A bare failed-jobs re-run will re-fail unless the footprint / runner-class / measured inputs change.`);
            failed = true;
        } else {
            console.log(`[CAPACITY:${spec.phase}] DISK PASS — free covers estimated peak + margin.`);
        }
    }

    if (spec.mode === 'mem' || spec.mode === 'both') {
        const oldSpaceLimitBytes = readOldSpaceLimitBytes();
        const availableRamBytes = readAvailableRamBytes();
        const estimatedPeakHeapBytes = Math.ceil(baseBytes * (spec.heapExpansionFactor || 0));
        const r = evaluateMemoryGate({ phase: spec.phase, estimatedPeakHeapBytes, oldSpaceLimitBytes, availableRamBytes });
        printMemory(r);
        if (!r.ok) {
            const why = r.configExceedsHardware
                ? `configured old-space ${gib(r.oldSpaceLimitBytes)} > physical RAM ${gib(r.availableRamBytes)}`
                : `estimated heap ${gib(r.estimatedPeakHeapBytes)} clearly exceeds capacity ${gib(r.capacityBytes)} (>${r.clearlyFactor}×)`;
            console.error(`::error::${r.terminalCode} — ${why}. Aborting BEFORE the heavy step. Coarse guard: a re-run re-fails unless the footprint / runner-class / inputs change.`);
            failed = true;
        } else {
            console.log(`[CAPACITY:${spec.phase}] MEMORY PASS — coarse guard clear (NOT a guarantee against future OOM).`);
        }
    }

    if (failed) process.exit(1);
    console.log(`[CAPACITY:${spec.phase}] ALL GATES PASS.`);
}

// CLI entry: `node scripts/factory/lib/runner-capacity-preflight.mjs <PHASE>`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runner-capacity-preflight.mjs')) {
    const phaseName = process.argv[2];
    if (!phaseName) {
        console.error('::error::runner-capacity-preflight: missing <PHASE> argument.');
        process.exit(1);
    }
    runGate(phaseName);
}
