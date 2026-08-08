/**
 * T3 (D-2026-0808-405): progress heartbeat for the JS R2 directory-restore path.
 *
 * WHY. A directory restore that hangs mid-set is currently SILENT: the only
 * output is the "Manifest found: N files" line at the start and the terminal
 * line at the end. When the step is cancelled by its ceiling there is no record
 * of how far it got, so a hang is indistinguishable from slowness after the
 * fact. This emits a periodic record while members are in flight, and one
 * terminal record on every exit path.
 *
 * TELEMETRY IS OBSERVATION ONLY. It changes NO success/failure/retry/strict-exit
 * semantics, no concurrency, no manifest validation, and no returned shape.
 * Removing every call site would leave restore behaviour bit-identical.
 *
 * REDACTION BY CONSTRUCTION. The emitted record is built from a fixed set of
 * NUMERIC counters only. There is no code path by which an object key, an object
 * body, a credential, a signed URL, or an upstream error message can enter it -
 * the emitter never receives those values in the first place. A stuck batch is
 * reported with UNCHANGED counters rather than with any identifying detail.
 */

export const HEARTBEAT_INTERVAL_MS = 30000;
export const PROGRESS_MARKER = '[R2-RESTORE-PROGRESS]';
export const PROGRESS_SCHEMA = 'r2-restore-progress/1';

/**
 * @param {object} o
 * @param {number} o.expected      member count the restore must achieve
 * @param {number} o.concurrency   configured batch width (reported, never changed)
 * @param {number} [o.intervalMs]  heartbeat period; MUST stay <= 30s in production
 * @param {() => number} [o.now]           injectable clock (tests)
 * @param {(line: string) => void} [o.emit] injectable sink (tests)
 * @param {Function} [o.setTimer]   injectable setInterval (tests)
 * @param {Function} [o.clearTimer] injectable clearInterval (tests)
 */
export function createRestoreProgress({
    expected = 0,
    concurrency = 0,
    intervalMs = HEARTBEAT_INTERVAL_MS,
    now = () => Date.now(),
    emit = (line) => console.log(line),
    setTimer = setInterval,
    clearTimer = clearInterval,
} = {}) {
    const startedAt = now();
    let processed = 0;
    let restored = 0;
    let failed = 0;
    let restoredBytes = 0;
    let stopped = false;
    let timer = null;

    /** The COMPLETE set of fields that may ever be emitted. All numeric. */
    const snapshot = (phase) => ({
        schema: PROGRESS_SCHEMA,
        phase,
        elapsed_s: Math.max(0, Math.round((now() - startedAt) / 1000)),
        processed,
        restored,
        failed,
        expected,
        restored_bytes: restoredBytes,
        concurrency,
    });

    const emitLine = (phase) => {
        // JSON.stringify over the fixed numeric snapshot - nothing else reaches emit().
        emit(`${PROGRESS_MARKER} ${JSON.stringify(snapshot(phase))}`);
    };

    // The heartbeat fires on a wall-clock interval, NOT on member completion, so a
    // batch that is fully stuck still produces records (with unchanged counters).
    timer = setTimer(() => { if (!stopped) emitLine('in_progress'); }, intervalMs);
    // Never hold the event loop open on account of telemetry.
    if (timer && typeof timer.unref === 'function') timer.unref();

    return {
        /** One member restored. `size` is a byte count; anything else counts as 0. */
        onRestored(size) {
            processed += 1;
            restored += 1;
            const n = Number(size);
            if (Number.isFinite(n) && n > 0) restoredBytes += n;
        },
        /** One member failed. Deliberately takes NO argument, so no error text can leak. */
        onFailed() {
            processed += 1;
            failed += 1;
        },
        /**
         * Terminal record + timer teardown. Idempotent: safe to call from a
         * `finally` that may run after an earlier explicit stop.
         */
        stop(phase = 'complete') {
            if (stopped) return;
            stopped = true;
            if (timer !== null) { clearTimer(timer); timer = null; }
            emitLine(phase);
        },
        /** Test/inspection accessor. Returns a fresh plain object, never internal state. */
        snapshot,
        get stopped() { return stopped; },
        get timerActive() { return timer !== null; },
    };
}
