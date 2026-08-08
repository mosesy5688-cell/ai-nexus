/**
 * D-6 accounting repair (D-2026-0808-410 R2, design v1 Option B).
 *
 * WHY. shard-processor counted a FAILED entity as "processed": both the
 * success branch and the outer catch incremented processedCount, and
 * processor-core.js returns { success:false } rather than throwing, so the
 * overwhelmingly common failure path never even reached the catch. The
 * `processedCount === 0` guard therefore could not detect what its own comment
 * claimed - an all-entities-failed run - because every line that PARSED
 * incremented the counter regardless of outcome. Such a run emitted a shard
 * whose entities array held only failures and exited GREEN.
 *
 * OPTION B (Founder-approved): a zero-success FAIL-CLOSED gate plus
 * counts-only telemetry that gates nothing. No partial-failure threshold is
 * invented here - the repo has never measured a per-shard failure rate, so any
 * number would be a guess. The telemetry line IS the census a phase-2 threshold
 * would be derived from.
 *
 * REDACTION. Terminal and telemetry carry ONLY identity and counts. Entity ids
 * and error-reason strings are DELIBERATELY excluded: processor-core.js sets
 * `error: error.message` from an arbitrary throw, so a reason string can embed
 * entity-derived text. Admitting reasons would create exactly the content-leak
 * surface the R2a record-ceiling design exists to deny.
 */

export const ACCOUNTING_TERMINAL_ALL_FAILED = 'SHARD_ALL_ENTITIES_FAILED';
export const ACCOUNTING_SCHEMA = 'shard-accounting/1';
export const ACCOUNTING_MARKER = '[SHARD-ACCOUNTING]';

/**
 * PURE decision rule. No I/O.
 *
 * Ordering note: this rule is the THIRD guard. The caller must evaluate the
 * entityIndex===0 and processedCount===0 terminals FIRST, because all three
 * predicates are simultaneously true for an empty input and the first two are
 * pinned to exact messages. The predicate is written self-contained
 * (`successCount === 0 && processedCount > 0`) so it survives a reordering
 * rather than silently stealing those terminals.
 *
 * @returns {{ok:boolean, terminalCode:string|null, successRatio:number, ...counts}}
 */
export function evaluateShardAccounting({
    totalSeen = 0,
    malformedCount = 0,
    processedCount = 0,
    successCount = 0,
    failedCount = 0,
    writeErrorCount = 0,
} = {}) {
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const seen = n(totalSeen);
    const malformed = n(malformedCount);
    const processed = n(processedCount);
    const success = n(successCount);
    const failed = n(failedCount);
    const writeErrors = n(writeErrorCount);

    const allFailed = success === 0 && processed > 0;
    return {
        ok: !allFailed,
        terminalCode: allFailed ? ACCOUNTING_TERMINAL_ALL_FAILED : null,
        totalSeen: seen,
        malformedCount: malformed,
        processedCount: processed,
        successCount: success,
        failedCount: failed,
        writeErrorCount: writeErrors,
        successRatio: processed > 0 ? success / processed : 0,
        // The two invariants the design asserts; surfaced so a test can pin them
        // and a future refactor cannot drift the counters apart silently.
        countsConsistent: processed === success + failed + writeErrors,
        seenConsistent: seen === processed + malformed,
    };
}

/** Terminal message: identity + counts ONLY. Never ids, never reason strings. */
export function formatAccountingTerminal(shardId, inputIdentity, a) {
    return `${ACCOUNTING_TERMINAL_ALL_FAILED}: shard=${shardId} input=${inputIdentity} ` +
        `totalSeen=${a.totalSeen} malformed=${a.malformedCount} processed=${a.processedCount} ` +
        `success=0 failed=${a.failedCount} writeErrors=${a.writeErrorCount}`;
}

/** One machine-readable census line per shard, emitted on EVERY run. */
export function formatShardAccountingTelemetry(shardId, a) {
    return `${ACCOUNTING_MARKER} ` + JSON.stringify({
        schema: ACCOUNTING_SCHEMA,
        shardId,
        totalSeen: a.totalSeen,
        malformedCount: a.malformedCount,
        processedCount: a.processedCount,
        successCount: a.successCount,
        failedCount: a.failedCount,
        writeErrorCount: a.writeErrorCount,
        successRatio: a.successRatio,
        ok: a.ok,
        terminalCode: a.terminalCode,
    });
}
