/**
 * FULL-RESPONSE deadline for the arXiv OAI lane (NBF-4, 2026-07-25).
 *
 * THE DEFECT THIS CLOSES. `base-adapter.fetchWithTimeout` clears its abort timer in
 * a `finally` that runs as soon as `fetch()` resolves -- i.e. when HEADERS arrive.
 * The subsequent `await response.text()` in arxiv-oai-client ran with NO deadline at
 * all, so an attempt priced at N ms could take arbitrarily longer and still return a
 * SUCCESSFUL page. A per-attempt window that does not cover the body is not a bound,
 * and the admission gate's cost model is only as sound as that bound.
 *
 * SHAPE (deliberately NOT a second budget). The attempt's deadline is `start + N`.
 * The header phase consumes part of N; the body read is granted exactly the
 * REMAINING `N - elapsed`. Total attempt time is therefore bounded by N. Granting a
 * fresh N to the body would silently turn 120000 into 240000 and is forbidden.
 *
 * TOTAL-DURATION, NOT IDLE. The guard timer is armed once, for the whole remaining
 * window; a body that keeps trickling bytes past the deadline is still terminated.
 *
 * SETTLEMENT -- WHY THIS DRIVES A READER INSTEAD OF response.text().
 * `response.text()` LOCKS the body stream via getReader(). Calling
 * `response.body.cancel()` on a locked stream is a spec error: it does not throw,
 * it returns a REJECTED promise (TypeError ERR_INVALID_STATE "ReadableStream is
 * locked"). Swallowing that rejection makes the cancellation a silent no-op -- the
 * body is merely ABANDONED, the server keeps pushing, and the socket stays open.
 * Measured against a real trickling localhost server (deadline 200ms): the caller
 * returned at 226ms with errorKind='abort', but `response.body.locked` was still
 * true, `process.getActiveResourcesInfo()` still held ["TCPSocketWrap",
 * "TCPSocketWrap"], and the process HUNG to the watchdog (exit 124).
 *
 * That leak is reachable on the SUCCESS path: harvest-single's main() has no
 * process.exit(0), so a completed harvest relies on natural event-loop drain. One
 * breached attempt followed by a successful retry would leave the run alive until
 * the runner killed the step -- no sidecar, i.e. exactly what
 * TERMINALIZATION_RESERVE_MS exists to prevent. undici's idle-based bodyTimeout
 * cannot bound a trickling body, so it could not be priced either.
 *
 * So the body is consumed through an explicit reader pump. The READER owns the
 * lock, so `reader.cancel()` genuinely succeeds and undici destroys the socket.
 * The guard timer is cleared on EVERY path (success, body failure, timeout); no
 * promise is left without a handler; cancellation is initiated synchronously and
 * not awaited, so settlement adds no measurable tail to the cost model.
 *
 * ar5iv does NOT need this: it owns a real AbortController, and aborting the
 * signal makes undici destroy the connection. Only this lane -- where
 * base-adapter.fetchWithTimeout owns (and has already cleared) the controller, and
 * overwrites any caller-supplied signal at base-adapter.js:392 -- needs the pump.
 *
 * SCOPE: local to the arXiv lane. base-adapter.fetchWithTimeout is NOT changed.
 *
 * @module ingestion/adapters/arxiv-response-deadline
 */

const EXPIRED = Symbol('deadline-expired');

/** An AbortError-shaped failure so callers classify a body timeout as a timeout. */
function deadlineError(message) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

/** Release the socket. The reader holds the lock, so this cancel really cancels. */
function cancelReader(reader) {
    try {
        const cancelled = reader.cancel();
        if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
    } catch {
        // Already released: nothing left to cancel.
    }
}

/**
 * Consume a real ReadableStream body under a single total-duration deadline,
 * cancelling the reader (and therefore the socket) the moment it is breached.
 */
async function pumpWithinDeadline(reader, remainingMs, setTimer, clearTimer) {
    const chunks = [];
    let timer = null;
    const deadline = new Promise((resolve) => { timer = setTimer(() => resolve(EXPIRED), remainingMs); });
    try {
        for (;;) {
            const next = await Promise.race([reader.read(), deadline]);
            if (next === EXPIRED) {
                cancelReader(reader);
                return {
                    ok: false, errorKind: 'abort',
                    error: deadlineError(`body read exceeded the remaining ${remainingMs}ms of the attempt deadline`),
                };
            }
            if (next.done) break;
            if (next.value) chunks.push(next.value);
        }
        // CONCAT-THEN-DECODE, never per-chunk: a UTF-8 sequence straddling a chunk
        // boundary would decode to U+FFFD on both sides if each chunk were decoded
        // separately. DIVERGENCE FROM response.text(), stated rather than assumed:
        // text() runs a WHATWG UTF-8 decode, which STRIPS a leading U+FEFF BOM;
        // Buffer.toString('utf8') RETAINS it. Harmless at the only consumer --
        // xml2js parses a BOM-prefixed "﻿<?xml ...?>" fine -- but it is a real
        // behavioural difference from the code this replaced.
        return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
    } catch (error) {
        cancelReader(reader);
        return { ok: false, errorKind: 'fetch', error };
    } finally {
        clearTimer(timer);
    }
}

/**
 * Read a response body within the REMAINING part of an attempt deadline.
 *
 * @param {Object} args
 * @param {Response} args.response - the already-headered response.
 * @param {number} args.remainingMs - `N - elapsed`; <= 0 means the attempt is spent.
 * @param {Object} [args.timers] - {setTimeout, clearTimeout} seam for tests.
 * @returns {Promise<{ok:boolean, text?:string, error?:Error, errorKind?:string}>}
 *   errorKind 'abort' = deadline exceeded; 'fetch' = the body itself failed.
 */
export async function readBodyWithinDeadline({ response, remainingMs, timers = {} }) {
    const setTimer = timers.setTimeout || setTimeout;
    const clearTimer = timers.clearTimeout || clearTimeout;
    const streamed = response && response.body && typeof response.body.getReader === 'function';

    if (!(remainingMs > 0)) {
        if (streamed) cancelReader(response.body.getReader());
        return { ok: false, errorKind: 'abort', error: deadlineError('attempt deadline consumed before the body read') };
    }

    // PRODUCTION ALWAYS TAKES THIS PATH: undici gives every Response a ReadableStream
    // body, so the reader pump (and therefore a real, socket-destroying cancel) is
    // what runs live. The text() fallback below exists only for body-less test
    // doubles and makes no cancellation claim.
    if (streamed) return pumpWithinDeadline(response.body.getReader(), remainingMs, setTimer, clearTimer);

    const bodyPromise = response.text();
    if (bodyPromise && typeof bodyPromise.catch === 'function') bodyPromise.catch(() => {});
    let timer = null;
    const guard = new Promise((resolve) => { timer = setTimer(() => resolve(EXPIRED), remainingMs); });
    try {
        const winner = await Promise.race([bodyPromise.then((text) => ({ text })), guard]);
        if (winner === EXPIRED) {
            return {
                ok: false, errorKind: 'abort',
                error: deadlineError(`body read exceeded the remaining ${remainingMs}ms of the attempt deadline`),
            };
        }
        return { ok: true, text: winner.text };
    } catch (error) {
        return { ok: false, errorKind: 'fetch', error };
    } finally {
        clearTimer(timer); // cleared on success, body failure AND timeout
    }
}

export default { readBodyWithinDeadline };
