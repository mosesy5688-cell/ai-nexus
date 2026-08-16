/**
 * REST-1a (D-2026-0816-438): directory-restore COMPLETENESS assertion.
 *
 * PLACEMENT. This module is consumed at the CLI/caller layer
 * (r2-workflow-cli.js `restore-dir`), which sits ABOVE the rust-FFI / JS
 * dual-engine fork. restoreDirectoryFromR2FFI is the single seam every
 * restore-dir invocation passes through, so an assertion here governs BOTH
 * engines. An assertion placed inside the JS restoreDirectoryFromR2 body would
 * be bypassed the moment the bridge stops delegating to JS.
 *
 * INDEPENDENT AUTHORITY. The expected count is the count the MANIFEST
 * declares - a record written by the producer in a previous workflow - never a
 * number this process derived from what it happened to download. A restore
 * that fetched 449 of a manifest-declared 654 is a FAILURE, even though every
 * individual GET it attempted succeeded and `failed` is 0. Partial success is
 * failure (D-1).
 *
 * REDACTION BY CONSTRUCTION. The emitted record carries COUNTS ONLY. Object
 * keys are reduced to `.length` before they can reach the record, so no key,
 * body, credential or upstream error text can enter it.
 */

// Re-exported so the caller layer takes ONE import for the whole above-fork gate.
export { registerPendingRestore, resolvePendingRestore } from './r2-restore-exit-guard.js';

export const RESTORE_INCOMPLETE_CODE = 'R2_RESTORE_INCOMPLETE';
export const RESTORE_GATE_MARKER = '[R2-RESTORE-GATE]';

const count = (v) => (Array.isArray(v) ? v.length : Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Decide whether a restore-dir result satisfies its manifest.
 *
 * Fires ONLY when an independent authority exists to be measured against, i.e.
 * a manifest was found and declares a positive expected count. When no manifest
 * was found there is no independent authority in this process, and the
 * pre-existing --strict semantics remain in force unchanged (a cold prefix on a
 * best-effort call site keeps behaving exactly as it does today). The absent
 * manifest case is closed OUT of process by the REST-2 equality floor.
 *
 * @param {object} result the restore-dir result
 * @returns {{ ok: boolean, code?: string, record?: object }}
 */
export function evaluateRestoreCompleteness(result) {
    const r = result || {};
    if (!r.manifestFound) return { ok: true };
    const expected = count(r.expected);
    if (expected <= 0) return { ok: true };
    const restored = count(r.restored);
    const missing = count(r.missing);
    const failed = count(r.failed);
    if (restored === expected && missing === 0 && failed === 0) return { ok: true };
    return {
        ok: false,
        code: RESTORE_INCOMPLETE_CODE,
        record: {
            code: RESTORE_INCOMPLETE_CODE,
            expected,
            restored,
            missing,
            failed,
            shortfall: expected - restored,
        },
    };
}

/**
 * Format the named terminal record. COUNTS ONLY - the input is already reduced
 * to numbers by evaluateRestoreCompleteness.
 */
export function formatRestoreGateRecord(record) {
    return `${RESTORE_GATE_MARKER} ${JSON.stringify(record)}`;
}
