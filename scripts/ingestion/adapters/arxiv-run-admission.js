/**
 * ArXiv OAI RUN-SCOPED ADMISSION (Founder ruling, 2026-07-25 arXiv P0).
 *
 * Pure policy + the run-scoped ledger. It owns NO retry advancement: every
 * function here is called ONLY by the single arbiter (arxiv-recovery-state.js),
 * which remains the unique owner of attempts, budget and waits. Splitting it out
 * keeps the arbiter under the CES ceiling and gives the two Founder-ruled runtime
 * controls one auditable surface.
 *
 * A. THIRD-ATTEMPT QUOTA. At most MAX_THIRD_ATTEMPT_TOKENS_PER_RUN tokens may
 *    enter attempt 3 in a run. Consumed BEFORE the third request is issued and
 *    never refunded, whether that attempt succeeds or fails. The ledger lives at
 *    MODULE scope, so it survives arbiter re-initialisation, token-loop
 *    reconstruction and exception re-entry inside one process; a run IS one
 *    process (`node harvest-single.js arxiv`), so it cannot leak across runs.
 *
 * B. WALL-CLOCK ADMISSION. Before ANY request -- an ordinary page request just as
 *    much as a retry -- and before any wait, the FULL bounded worst-case cost of
 *    the proposed action (any wait + the request's own timeout + the foreseeable
 *    pacing/enrichment tail) must fit inside the arXiv step deadline with
 *    TERMINALIZATION_RESERVE_MS still untouched. Otherwise the caller must not
 *    sleep, must not fetch, and must terminate non-zero. NBF-1: pacing and ar5iv
 *    enrichment follow EVERY accepted page, so gating only the retry path let a
 *    purely healthy walk run past the step and die as an evidence-free runner kill.
 *
 * @module ingestion/adapters/arxiv-run-admission
 */
import {
    MAX_THIRD_ATTEMPT_TOKENS_PER_RUN, MAX_RETRY_AFTER_MS, MAX_REQUESTS_PER_TOKEN,
    TERMINALIZATION_RESERVE_MS, ARXIV_STEP_TIMEOUT_MS, FORESEEABLE_TAIL_WORST_MS,
    attemptTimeoutMs,
} from './arxiv-recovery-envelope.js';

/** A fresh run ledger. `startedAtMs` is stamped once, by the first arbiter built in it. */
export function createRunScope() {
    return { thirdAttemptTokens: new Set(), startedAtMs: undefined };
}

// The real run's ledger: module scope = process scope = one workflow run.
export const PROCESS_RUN_SCOPE = createRunScope();

/**
 * Short, non-reversible fingerprint of a resumptionToken for logs (never the full
 * token, which is not a governance id and must not be persisted/leaked).
 */
export function tokenFingerprint(token) {
    if (!token) return 'none';
    let h = 0;
    for (let i = 0; i < token.length; i++) {
        h = (h * 31 + token.charCodeAt(i)) | 0;
    }
    return 'tok#' + (h >>> 0).toString(16);
}

/**
 * BF-2: the wait a Retry-After header may actually buy. Non-finite, zero, negative
 * and already-expired values yield null (no hint -> the configured backoff wins);
 * anything valid is clamped to MAX_RETRY_AFTER_MS. Applies identically to the
 * delta-seconds and HTTP-date forms because both reach here already reduced to ms.
 */
export function effectiveRetryAfterMs(rawMs) {
    if (!Number.isFinite(rawMs) || rawMs <= 0) return null;
    return Math.min(rawMs, MAX_RETRY_AFTER_MS);
}

/**
 * BF-1A: admit + CONSUME the run's third-attempt quota for `token`. Re-admitting
 * the SAME token is idempotent (it already holds the slot), so exception re-entry
 * cannot double-spend or refund. Returns false when the quota is gone -> caller
 * fails loud BEFORE fetching.
 */
export function admitThirdAttempt(scope, token) {
    const held = scope.thirdAttemptTokens;
    if (held.has(token)) return true;
    if (held.size >= MAX_THIRD_ATTEMPT_TOKENS_PER_RUN) return false;
    held.add(token);
    return true;
}

/**
 * BF-1B: runtime wall-clock admission. Returns null to admit, or the terminal.
 * FAIL CLOSED: a missing/corrupt run-start or a non-finite cost refuses rather
 * than guessing. Strict `<` so the reserve is preserved, never partly spent.
 */
export function admitWallClock(scope, nowMs, costMs) {
    const start = scope?.startedAtMs;
    if (!Number.isFinite(start) || !Number.isFinite(nowMs) || !Number.isFinite(costMs)) {
        return 'RUN_WALL_CLOCK_BUDGET_EXHAUSTED';
    }
    const projectedCompletion = (nowMs - start) + costMs;
    return projectedCompletion + TERMINALIZATION_RESERVE_MS < ARXIV_STEP_TIMEOUT_MS
        ? null
        : 'RUN_WALL_CLOCK_BUDGET_EXHAUSTED';
}

/**
 * Wall-clock admission for a proposed action costing `costMs`, RECORDING the
 * evidence (elapsed + projected completion) on the arbiter whether it admits or
 * refuses, so a refusal terminal carries the numbers that justify it. Evidence is
 * null (never a fabricated zero) when the run start is unusable.
 */
export function recordAdmission(state, costMs) {
    const start = state.runScope?.startedAtMs;
    state.runElapsedMs = Number.isFinite(start) ? state.now() - start : null;
    state.projectedCompletionMs = Number.isFinite(state.runElapsedMs) && Number.isFinite(costMs)
        ? state.runElapsedMs + costMs : null;
    return admitWallClock(state.runScope, state.now(), costMs);
}

/**
 * NBF-1: admission cost for an ORDINARY page request. Pacing + ar5iv enrichment
 * follow every accepted page, healthy ones included, so a plain request is gated
 * exactly like a retry. Priced entirely at the BOUND -- the worst attempt-1 window
 * (120s) plus the WORST tail (170.25s) -- never at expected values, so an admitted
 * action can never cost more than it was priced and the terminalization reserve is
 * never consumed by under-pricing. Close to the deadline this refuses pages that
 * would in fact have completed (~100s of discarded optimism per page): a deliberate
 * early fail-loud, bought in exchange for evidence a runner kill would destroy.
 */
export function nextPageCostMs() {
    return attemptTimeoutMs(1) + FORESEEABLE_TAIL_WORST_MS;
}

/**
 * THE composed retry decision, in strict precedence order. Returns null when the
 * retry is admitted AND its wait has already been executed by the arbiter; any
 * other return is the TERMINAL the caller must fail loud with. Nothing sleeps and
 * nothing is fetched on any refusing path.
 *
 * Precedence: (1) transport budget gone; (2) per-token attempts exhausted;
 * (3) wall-clock admission (wait + the next request's own timeout + the foreseeable
 * tail + the reserve); (4) third-attempt run quota gone; (5) the arbiter's
 * budget-fit refusal inside executeRetryWait; (6) admitted.
 *
 * The gate is checked BEFORE the quota deliberately: the quota is spent
 * irrevocably, so a wall-clock refusal must not burn the run's only third-attempt
 * slot on an action that is never going to happen.
 */
export async function retryDecision(state, retryAfterMs) {
    if (state.budgetExhausted()) return 'TOTAL_BUDGET_EXHAUSTED';
    if (!state.canRetryToken()) return 'ATTEMPTS_EXHAUSTED';
    const nextAttempt = state.tokenAttempts + 1;
    const cost = state.plannedWaitMs(retryAfterMs) + attemptTimeoutMs(nextAttempt) + FORESEEABLE_TAIL_WORST_MS;
    const gate = state.admit(cost);
    if (gate) return gate;
    if (nextAttempt === MAX_REQUESTS_PER_TOKEN && !admitThirdAttempt(state.runScope, state.currentToken)) {
        return 'THIRD_ATTEMPT_QUOTA_EXHAUSTED';
    }
    if (!(await state.executeRetryWait(retryAfterMs))) return 'TOTAL_BUDGET_EXHAUSTED';
    return null;
}

export default {
    createRunScope, PROCESS_RUN_SCOPE, tokenFingerprint,
    effectiveRetryAfterMs, admitThirdAttempt, admitWallClock, retryDecision,
};
