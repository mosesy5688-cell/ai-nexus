/**
 * REST-1b (D-2026-0816-438): transport deadlines for the R2 client and for the
 * object-body read loop. A wedged member must become a THROWN error so that
 * withR2Retry sees it, the failed counter is honest, and the restore can never
 * hang forever behind a heartbeat that holds nothing open.
 *
 * ---------------------------------------------------------------------------
 * DERIVATION (08-15 healthy precedent, run 31875176698 job 94990288895).
 * Observed terminal record for the SAME code path and the SAME prefix
 * (state/registry/) that later wedged:
 *   phase=complete elapsed_s=68 processed=653 restored=653 failed=0
 *   expected=653 restored_bytes=1185628322 concurrency=5
 * Therefore:
 *   aggregate throughput = 1185628322 B / 68 s   = 17.4 MB/s
 *   per-stream (5 wide)  = 17.4 / 5              =  3.49 MB/s
 *   mean object          = 1185628322 / 653      =  1.82 MB  (~0.52 s/object)
 *   largest single object (work order)           = ~7 MB     (~2.0 s/object)
 *
 * CONNECTION deadline 10 s: the healthy connect phase is far below 1 s. 10 s is
 * a >10x margin and still bounded.
 *
 * NO REQUEST deadline is set. See the write-path note below - this is a
 * deliberate omission, not an oversight.
 *
 * STREAM-IDLE deadline 60 s: this is an INACTIVITY budget, not a total. A
 * transfer that delivers a single byte per minute never trips it, so a slow
 * network degrades into slowness, never into a false red. Only a true
 * zero-byte wedge - the observed 08-16 incident shape, where two consecutive
 * 30 s heartbeats reported byte-identical counters - trips it.
 *
 * BOUNDED COST. A wedged member now costs at most idle-deadline x retry
 * attempts (60 s x 4 = 240 s) instead of hanging unbounded, and it surfaces as
 * a counted failure rather than as silence.
 *
 * ---------------------------------------------------------------------------
 * WHY NO requestTimeout IS SET (D-2026-0816-439 gate-2 R1).
 * createR2Client is SHARED: the same client carries the directory-restore GETs
 * and every PUT in the backup path. `requestTimeout` is cleared only when
 * response HEADERS arrive, and a single-shot PutObjectCommand with a whole-file
 * body receives its headers only AFTER the entire body has been transmitted.
 * A request deadline is therefore a hard TOTAL-TRANSFER cap on every upload.
 *
 * Measured against the healthy WRITE precedent (archived VFS-Packing job):
 *   19682.1 MB / 295.6 s over concurrency 5 => ~13.3 MB/s per stream
 *   mean object 182.2 MB                    => ~13.7 s per PUT
 * A 60 s request deadline is only a 4.4x margin on the MEAN upload - not the
 * ~30x an earlier revision of this header claimed, because that figure was
 * derived from the READ path and silently applied to writes. Sizing it for the
 * write path instead would require >=300 s, at which point it is far too coarse
 * to bound anything on the read side.
 *
 * It is dropped rather than re-derived because it contributes NOTHING to the
 * incident mechanism: for a GET, response headers arrive inside the connect
 * window, so the connection deadline already covers everything a request
 * deadline would have. Its only remaining effect would be an undeclared cap on
 * uploads. The wedge this module exists to close happens during the BODY read,
 * which is covered by the stream-idle deadline below.
 *
 * WHY THE STREAM-IDLE DEADLINE IS OURS AND NOT socketTimeout.
 * The handler clears every registered timeout the moment response HEADERS
 * arrive (resolve() -> timeouts.forEach(clearTimeout)). `requestTimeout`
 * therefore covers connect -> headers only, and NOT the body stream. The SDK's
 * own `socketTimeout` defers its registration by 3000 ms whenever the value is
 * >= 6000 ms, so for a fast-header/slow-body response that registration is
 * cancelled before it ever arms. Neither knob covers a stall DURING the body
 * read, which is precisely the incident shape, so the idle deadline is applied
 * by us around the body iteration instead.
 */

/** Connection-phase deadline (ms). */
export const R2_CONNECTION_TIMEOUT_MS = 10000;
/** Body-stream INACTIVITY deadline (ms). */
export const R2_STREAM_IDLE_TIMEOUT_MS = 60000;

/**
 * requestHandler config for S3Client. Returned as a plain options object;
 * the SDK builds the NodeHttpHandler from it (NodeHttpHandler.create), so no
 * extra dependency is introduced.
 *
 * Deliberately connection-phase ONLY. No request deadline is set - on a shared
 * read/write client it is a total-transfer cap on every PUT while adding nothing
 * to the read path (see the header note). Body stalls are covered by
 * readBodyWithIdleDeadline, not by a handler-level deadline.
 */
export function r2RequestHandlerConfig() {
    return { connectionTimeout: R2_CONNECTION_TIMEOUT_MS };
}

/**
 * Build the idle-deadline error. Shaped so classifyR2Error() maps it to
 * retryable/transport exactly like a native SDK timeout. Carries NO object key,
 * body, credential or upstream message.
 */
export function createStreamIdleError(idleMs) {
    return Object.assign(
        new Error(`R2 object body stalled: no data for ${idleMs} ms (stream idle deadline)`),
        { name: 'TimeoutError', code: 'ETIMEDOUT', streamIdleTimeout: true },
    );
}

/**
 * Read an object body to a Buffer under an INACTIVITY deadline.
 *
 * PROGRESS IS BYTE-LEVEL, NOT REQUEST-LEVEL (D-2026-0816-441 §3). The deadline
 * is armed INSIDE the read loop and re-armed on every delivered chunk, so the
 * only thing that counts as progress is bytes actually arriving. A request that
 * is still open, still "in flight", and still holding a live socket does NOT
 * count as progress: if bytes stop flowing mid-body the deadline fires even
 * though the request never ended. That is the 08-16 shape - the members were
 * mid-request, not un-started - and a request-level notion of liveness would
 * have missed it entirely. Conversely a slow body that keeps delivering resets
 * the budget on each chunk and can run arbitrarily long without tripping.
 *
 * The deadline timer is deliberately NOT unref'd: a ref'd timer is what
 * guarantees the event loop cannot drain while a read is outstanding, which is
 * the mechanism that let the 08-16 incident exit 0 in silence.
 *
 * @param {AsyncIterable} body   the SDK response Body
 * @param {object} [opts]
 * @param {number} [opts.idleMs] inactivity budget per chunk
 * @param {Function} [opts.setTimer]   injectable setTimeout (tests)
 * @param {Function} [opts.clearTimer] injectable clearTimeout (tests)
 * @returns {Promise<Buffer>}
 */
export async function readBodyWithIdleDeadline(body, opts = {}) {
    const {
        idleMs = R2_STREAM_IDLE_TIMEOUT_MS,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = opts;
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
        const chunks = [];
        for await (const c of body) chunks.push(c);
        return Buffer.concat(chunks);
    }
    const iterator = body[Symbol.asyncIterator]();
    const chunks = [];
    try {
        for (;;) {
            let timer = null;
            const deadline = new Promise((_resolve, reject) => {
                timer = setTimer(() => reject(createStreamIdleError(idleMs)), idleMs);
            });
            let step;
            try {
                step = await Promise.race([iterator.next(), deadline]);
            } finally {
                if (timer !== null) clearTimer(timer);
            }
            if (step && step.done) break;
            if (step) chunks.push(step.value);
        }
    } catch (e) {
        // Release the socket so a wedged connection cannot linger behind us.
        if (body && typeof body.destroy === 'function') { try { body.destroy(); } catch { /* best effort */ } }
        throw e;
    }
    return Buffer.concat(chunks);
}
