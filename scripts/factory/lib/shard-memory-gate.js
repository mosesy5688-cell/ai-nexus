/**
 * PROCESS_SHARD consumer-side memory gate (D-2026-0806-404, repair R3).
 *
 * WHY THE DECISION RULE CHANGES, NOT JUST THE ESTIMATE
 * The existing pure gate fails closed only when the estimate CLEARLY exceeds
 * capacity, where "clearly" is capacity x MEMORY_CLEARLY_FACTOR (1.5). For
 * PROCESS_SHARD that is 6,144 MiB x 1.5 = 9,216 MiB. Erratum v2 S-1 measured
 * that even a PERFECT estimator fed the true live heap of 6,170.3 MiB
 * (= 6.0257 GiB) still returns ok = true, because 6.0257 GiB < 9.000 GiB.
 * Improving only the estimator therefore cannot ever trip the old rule. This
 * gate uses a comparison factor of 1.0 with an EXPLICIT reserve, plus a second
 * fully independent record-size criterion.
 *
 * R3 IS DETECTION ONLY. It does not remove the failure class; R1 does. R3
 * converts a mid-run OOM into a named pre-run terminal and supplies the
 * per-shard telemetry the chronic band never surfaced.
 */

const MiB = 1024 * 1024;

// Comparison factor <= 1.0 (the old rule used 1.5). At 1.0 the gate compares
// against real capacity rather than 1.5x capacity.
export const SHARD_COMPARISON_FACTOR = 1.0;

// Explicit reserved headroom withheld from the comparison: V8 GC slack, the
// compress stream's buffers, the loaded daily-accum / checksums / FNI context,
// and non-heap allocations that still count against the old-space limit.
export const SHARD_RESERVE_BYTES = 512 * MiB;        // 536,870,912

// Bounded pre-scan budgets. The scan is a prefix scan and says so; it never
// presents a truncated scan as a complete census.
export const SCAN_LINE_BUDGET = 25000;
export const SCAN_BYTE_BUDGET = 512 * MiB;

export const GATE_TERMINAL_PROJECTED = 'SHARD_MEMORY_GATE_PROJECTED_HEAP_EXCEEDED';
export const GATE_TERMINAL_RECORD = 'SHARD_MEMORY_GATE_RECORD_CEILING_EXCEEDED';

/**
 * PURE decision function. No I/O.
 *
 * usableBytes = floor(capacityBytes * comparisonFactor) - reserveBytes
 * FAIL when EITHER holds:
 *   (1) AGGREGATE : projectedPeakHeapBytes > usableBytes
 *   (2) RECORD    : maxRecordBytes > recordCeilingBytes   (independent of (1))
 *
 * capacityBytes is the smallest positive known limit (old-space, RAM). When no
 * limit is known the gate is INDETERMINATE and must not false-fail.
 */
export function evaluateShardMemoryGate({
    phase = 'PROCESS_SHARD',
    projectedPeakHeapBytes = 0,
    oldSpaceLimitBytes = 0,
    availableRamBytes = 0,
    maxRecordBytes = 0,
    recordCeilingBytes = 0,
    comparisonFactor = SHARD_COMPARISON_FACTOR,
    reserveBytes = SHARD_RESERVE_BYTES,
} = {}) {
    const projected = Number(projectedPeakHeapBytes) || 0;
    const oldSpace = Number(oldSpaceLimitBytes) || 0;
    const ram = Number(availableRamBytes) || 0;
    const k = Number(comparisonFactor) || 1;
    const reserve = Number(reserveBytes) || 0;
    const limits = [oldSpace, ram].filter((x) => x > 0);
    const capacityBytes = limits.length ? Math.min(...limits) : 0;
    const indeterminate = capacityBytes === 0;
    const usableBytes = Math.max(0, Math.floor(capacityBytes * k) - reserve);

    const projectedExceedsUsable = !indeterminate && projected > usableBytes;
    const recordExceedsCeiling = recordCeilingBytes > 0 && Number(maxRecordBytes) > Number(recordCeilingBytes);

    const reasons = [];
    if (projectedExceedsUsable) reasons.push(GATE_TERMINAL_PROJECTED);
    if (recordExceedsCeiling) reasons.push(GATE_TERMINAL_RECORD);

    return {
        ok: reasons.length === 0,
        phase,
        projectedPeakHeapBytes: projected,
        oldSpaceLimitBytes: oldSpace,
        availableRamBytes: ram,
        capacityBytes,
        indeterminate,
        comparisonFactor: k,
        reserveBytes: reserve,
        usableBytes,
        maxRecordBytes: Number(maxRecordBytes) || 0,
        recordCeilingBytes: Number(recordCeilingBytes) || 0,
        projectedExceedsUsable,
        recordExceedsCeiling,
        reasons,
        terminalCode: reasons[0] || null,
    };
}

/**
 * Project the peak heap for one shard from a scan profile plus the reader's
 * own declared retention cap. This is the ESTIMATOR; the rule above is the
 * DECISION. They are deliberately separate so either can be reviewed alone.
 */
export function projectShardPeakHeapBytes({
    baseContextBytes = 0,
    readerRetainedCapBytes = 0,
    maxRecordBytes = 0,
    parseAmplification = 3,
} = {}) {
    return Math.ceil(
        Number(baseContextBytes) +
        Number(readerRetainedCapBytes) +
        Number(maxRecordBytes) * Number(parseAmplification)
    );
}

/**
 * Bounded prefix scan over an NDJSON line source. Measures line byte lengths
 * ONLY - it does not parse. Returns a profile that DISCLOSES truncation.
 *
 * @param {AsyncIterable<string>} lines
 */
export async function scanShardProfile(lines, {
    lineBudget = SCAN_LINE_BUDGET,
    byteBudget = SCAN_BYTE_BUDGET,
} = {}) {
    let lineCount = 0;
    let scannedBytes = 0;
    let maxRecordBytes = 0;
    let truncated = false;
    for await (const line of lines) {
        const n = Buffer.byteLength(line, 'utf8');
        lineCount += 1;
        scannedBytes += n + 1;
        if (n > maxRecordBytes) maxRecordBytes = n;
        if (lineCount >= lineBudget || scannedBytes >= byteBudget) { truncated = true; break; }
    }
    return {
        lineCount,
        scannedBytes,
        maxRecordBytes,
        scanTruncated: truncated,
        // When truncated, maxRecordBytes is a LOWER BOUND over the whole shard,
        // not the shard maximum. Consumers must not treat it as complete.
        maxRecordBytesIsLowerBound: truncated,
        lineBudget,
        byteBudget,
    };
}

/** One machine-readable telemetry record per shard. */
export function formatShardGateTelemetry(shardId, profile, decision) {
    return '[SHARD-GATE] ' + JSON.stringify({
        schema: 'shard-memory-gate/1',
        shardId,
        phase: decision.phase,
        ok: decision.ok,
        terminalCode: decision.terminalCode,
        reasons: decision.reasons,
        lineCount: profile.lineCount,
        scannedBytes: profile.scannedBytes,
        maxRecordBytes: profile.maxRecordBytes,
        scanTruncated: profile.scanTruncated,
        maxRecordBytesIsLowerBound: profile.maxRecordBytesIsLowerBound,
        projectedPeakHeapBytes: decision.projectedPeakHeapBytes,
        capacityBytes: decision.capacityBytes,
        comparisonFactor: decision.comparisonFactor,
        reserveBytes: decision.reserveBytes,
        usableBytes: decision.usableBytes,
        recordCeilingBytes: decision.recordCeilingBytes,
    });
}
