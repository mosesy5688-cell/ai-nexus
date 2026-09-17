/**
 * Warm-phase budget accounting: how one URL's time slot is derived from what
 * the phase budget has left. Split out of ssr-warm-core.js to stay inside the
 * 250-line Art 5.1 limit, the same way sentinel-budgets.js is split out of the
 * sentinel probe.
 */

/**
 * Unchanged from the previous inline loop: one request per URL, and 20s as the
 * MAXIMUM per-URL cap. The effective cap is lower when the phase budget has
 * less than one worst-case slot (23s) left -- see curlCapForRemaining.
 */
export const PER_URL_MAX_TIME_S = 20;

/**
 * ---------------------------------------------------------------------------
 * How one URL's slot is accounted for.
 * ---------------------------------------------------------------------------
 * The bound this replaced was `timeout: (PER_URL_MAX_TIME_S + 10) * 1000` -- a
 * fixed 30s INDEPENDENT of the cap -- commented "Hard stop if curl itself wedges
 * past its own --max-time" (warm-ssr.js @82ece3305:43-44). It was not a hard
 * stop. Node documents, for execFileSync/spawnSync:
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
 * CORRECTION OF RECORD: an earlier revision of this comment attributed the old
 * bound to "`capMs + 1000`". No commit ever contained it AS THE BOUND: at base
 * the string occurs three times across three files -- that withdrawn comment, a
 * test header, and a `not.toContain` assertion literal -- and never once in
 * warm-ssr.js as the value passed to `timeout:`. Its origin as a bound is not
 * recoverable from the repository. Presenting it as a prior revision of the
 * code was a fabricated history, worse than the error it was correcting.
 *
 * STANDARD THIS SETS, for every "an earlier revision said X" in this changeset:
 * attribute to a REVISION only when `git log --all -S` finds X in a commit;
 * otherwise say DRAFT and say that no commit contains it. Two traps, both hit
 * while applying this rule: (a) a prose sentence ABOUT a value can ship while
 * the value itself never did -- different claims, check which one you mean;
 * (b) `-S` is case-sensitive and matches contiguous text, so a lowercased or
 * line-wrapped query returns 0 commits for a string that is present. Verify a
 * zero before acting on it.
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

/**
 * Floor for the per-URL curl cap. Below this we do not START a warm request.
 *
 * An earlier revision said a cap below this "cannot complete a warm request".
 * WITHDRAWN: that was an unmeasured absolute, asserted about every request on
 * every path, and nothing here establishes it.
 *
 * What is actually claimed: below 1,000ms we would not RELY on one of THESE SIX
 * URLs completing. The supporting measurement is the one recorded in
 * ssr-warm-core.js next to PHASE_BUDGET_MS -- single-shot curl, 2026-09-16, on
 * this exact URL set: / 12.90s, /ranking 4.89s, entity 6.06s and 6.70s, model
 * 6.38s, /models 4.58s. The FASTEST was 4.58s, about 4.6x this floor, so a cap
 * under a second would have completed none of them on that occasion.
 *
 * That is ONE production sample of unknown cache state, and it is not the cold
 * post-deploy path this phase targets -- no cold-path timing has been measured
 * at all. So the floor is a POLICY choice supported by the one relevant
 * measurement we have, not a proof of impossibility: a warm attempt that times
 * out consumes budget and produces no warming, so starting one is worse than
 * skipping it.
 */
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
