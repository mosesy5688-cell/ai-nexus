/**
 * REST-1c (D-2026-0816-438): TERMINAL GUARANTEE for a directory restore.
 *
 * THE DEFECT. r2-restore-progress.js unref()s its heartbeat interval so that
 * telemetry can never hold the process open. On 08-16 the restore batch wedged,
 * the unref'd heartbeat was the only thing left referencing the event loop, the
 * loop drained, and node exited 0 WITHOUT running the `finally` that emits the
 * terminal record. The step then read a truncated 449-of-654 registry as if it
 * were whole.
 *
 * WHY THE FIX IS HERE AND NOT IN THE TELEMETRY MODULE. Three existing
 * executable pins forbid the in-module shapes:
 *   1. r2-restore-progress.test.mjs:129 asserts unref() IS called on the real
 *      interval handle, so the timer cannot simply be left ref'd.
 *   2. r2-restore-progress-wiring.test.mjs pins the construction site as
 *      exactly `createRestoreProgress({ expected: keys.length, concurrency })`
 *      and forbids any spread or extra opts, so no guard flag can be threaded
 *      through it.
 *   3. Two tests in r2-restore-progress.test.mjs create progress instances that
 *      are never stop()ed; registering the guard inside the constructor would
 *      make that suite exit non-zero.
 * The narrowest NON-REGRESSING placement is therefore the caller layer - which
 * is also ABOVE the rust-FFI / JS fork, so the guarantee covers both engines.
 *
 * THE GUARANTEE. A caller marks a restore pending BEFORE invoking the engine
 * and resolves it only once a terminal record has actually been emitted. If the
 * process reaches 'exit' with anything still pending, the guard emits a named
 * record and rewrites the exit code. Silence becomes a named non-zero exit.
 *
 * REDACTION BY CONSTRUCTION. The record carries COUNTS ONLY.
 */

export const TERMINAL_GUARD_MARKER = '[R2-RESTORE-TERMINAL-GUARD]';
export const NO_TERMINAL_RECORD_CODE = 'R2_RESTORE_NO_TERMINAL_RECORD';

const pending = new Set();
let nextToken = 1;
let listener = null;

/** Number of restores still awaiting a terminal record. */
export function pendingRestoreCount() {
    return pending.size;
}

/**
 * PURE decision, so the exit behaviour is unit-testable without exiting.
 * @param {number} count   pending restores at exit
 * @param {number} exitCode the exit code the process was about to use
 * @returns {object|null} the named record, or null when there is nothing to do
 */
export function evaluateExitGuard(count, exitCode) {
    if (!(count > 0)) return null;
    return {
        code: NO_TERMINAL_RECORD_CODE,
        pending: count,
        observed_exit_code: Number.isFinite(Number(exitCode)) ? Number(exitCode) : 0,
        forced_exit_code: 1,
    };
}

/**
 * Install the process-level 'exit' hook. Setting process.exitCode from an 'exit'
 * listener DOES change the code the process finally reports.
 *
 * Exactly ONE listener is held, and it is REMOVED again once nothing is pending,
 * so a long-lived host that drives many restores in-process (the CLI test
 * harnesses do) never accumulates listeners.
 */
function install(emit) {
    if (listener) return;
    listener = (code) => {
        const record = evaluateExitGuard(pending.size, code);
        if (!record) return;
        emit(`${TERMINAL_GUARD_MARKER} ${JSON.stringify(record)}`);
        process.exitCode = 1;
    };
    process.on('exit', listener);
}

/** Drop the hook while nothing is outstanding. */
function uninstallIfIdle() {
    if (listener && pending.size === 0) {
        process.removeListener('exit', listener);
        listener = null;
    }
}

/**
 * Mark a restore pending. Call BEFORE invoking the restore engine.
 * @param {(line: string) => void} [emit] injectable sink (tests)
 * @returns {number} token to hand back to resolvePendingRestore
 */
export function registerPendingRestore(emit = (line) => console.error(line)) {
    install(emit);
    const token = nextToken++;
    pending.add(token);
    return token;
}

/** Mark a restore terminal-recorded. Idempotent. */
export function resolvePendingRestore(token) {
    pending.delete(token);
    uninstallIfIdle();
}

/** Test-only: drop all pending state (never used by production paths). */
export function __resetPendingRestores() {
    pending.clear();
    uninstallIfIdle();
}
