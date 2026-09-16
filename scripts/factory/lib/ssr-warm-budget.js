/**
 * Warm-phase budget accounting: how one URL's time slot is derived from what
 * the phase budget has left. Split out of ssr-warm-core.js to stay inside the
 * 250-line Art 5.1 limit, the same way sentinel-budgets.js is split out of the
 * sentinel probe.
 */

/** Unchanged from the previous inline loop: one request per URL, 20s cap each. */
export const PER_URL_MAX_TIME_S = 20;

/**
 * ---------------------------------------------------------------------------
 * How one URL's slot is accounted for.
 * ---------------------------------------------------------------------------
 * An earlier revision wrote the subprocess bound as `capMs + 1000` and called
 * it a "hard stop". It was not one. Node documents, for execFileSync/spawnSync:
 *
 *   "When a timeout has been encountered and killSignal is sent, the method
 *    won't return until the process has completely exited."
 *   "If the child process intercepts and handles the SIGTERM signal and does
 *    not exit, the parent process will still wait until the child process has
 *    exited."
 *
 * and `killSignal` defaults to `'SIGTERM'`. So the default configuration bounds
 * NOTHING: a child that handles SIGTERM without exiting blocks the parent for
 * as long as it likes. The runner therefore passes `killSignal: 'SIGKILL'`,
 * which POSIX (signal(7)) specifies cannot be caught, blocked or ignored.
 *
 * A URL's slot is the sum of three explicitly named terms, so that nothing is
 * hidden inside a "+1000":
 *
 *   slot = curl cap  +  KILL_GRACE_MS  +  SPAWN_OVERHEAD_MS
 *
 *   curl cap          curl's own --max-time.
 *   KILL_GRACE_MS     how long the parent waits AFTER that cap should have
 *                     fired, letting curl print its write-out line and exit on
 *                     its own, before SIGKILL removes it. Consumed only on the
 *                     path where curl failed to honour its own --max-time.
 *   SPAWN_OVERHEAD_MS process spawn, argv marshalling, pipe teardown and reap -
 *                     work that happens outside curl's own clock.
 *
 * A URL only starts if a whole MIN_URL_SLOT_MS still fits, so every started URL
 * fits inside what the phase budget has left, and the phase is bounded by
 * PHASE_BUDGET_MS rather than overshooting it.
 *
 * TWO ASSUMPTIONS, named rather than assumed away:
 *   (a) spawn + teardown fits in SPAWN_OVERHEAD_MS;
 *   (b) SIGKILL removes curl promptly. It does not bound a process wedged in
 *       uninterruptible kernel I/O, which no userland caller can bound.
 * Neither is a proof; both are stated so a reviewer can attack them.
 */

/** Grace after the curl cap before SIGKILL. */
export const KILL_GRACE_MS = 2_000;

/** Spawn + teardown allowance, outside curl's own clock. */
export const SPAWN_OVERHEAD_MS = 1_000;

/** A curl cap below this cannot complete a warm request; do not start one. */
export const MIN_CURL_CAP_MS = 1_000;

/** Smallest slot a URL may start in. */
export const MIN_URL_SLOT_MS = MIN_CURL_CAP_MS + KILL_GRACE_MS + SPAWN_OVERHEAD_MS;

/**
 * curl's --max-time for a URL starting with `remainingMs` of phase budget left.
 * With a full budget this is the unchanged PER_URL_MAX_TIME_S.
 * Callers must not call this below MIN_URL_SLOT_MS (runWarmPlan skips instead).
 */
export function curlCapForRemaining(remainingMs) {
    const forCurl = remainingMs - KILL_GRACE_MS - SPAWN_OVERHEAD_MS;
    return Math.max(MIN_CURL_CAP_MS, Math.min(PER_URL_MAX_TIME_S * 1000, forCurl));
}

/** How long the parent waits on the subprocess before SIGKILL. */
export function subprocessWaitMs(capMs) {
    return capMs + KILL_GRACE_MS;
}
