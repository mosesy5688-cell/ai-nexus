/**
 * ArXiv OAI Slow-Tail Recovery Envelope -- the FROZEN per-token transport
 * constants. Extracted from arxiv-recovery-state.js so the envelope is one
 * auditable surface (and the single arbiter stays under the CES line ceiling).
 *
 * WHY IT WAS WIDENED (2026-07-25 arXiv P0). The daily Factory 1/4 Harvest run
 * 30145900897 failed at Harvest Academic: one OAI-PMH continuation token stalled
 * past 120s on three consecutive requests -> PAGE_TIMEOUT_EXHAUSTED after 867
 * records, exit 1 (Merge & Upload correctly SKIPPED). The primary cause is an
 * EXTERNAL arXiv transient slow/stall; the internal gap is that the previous
 * recovery envelope (3 x 120s with 15s/30s backoffs) is too narrow for current
 * minute-scale arXiv stalls. Not a code regression: the previous day passed on
 * the identical main, and on 2026-07-22 the same three-timeout pattern (run
 * 29895576000) was followed by a 53,198-record success (run 29899027798).
 *
 * SHAPE OF THE WIDENING. Attempt 1 keeps the 120s cap, so a NORMAL (fast) page
 * costs exactly what it cost before and performs NO backoff -- the healthy cycle
 * does not get slower. Only attempts 2 and 3, which exist ONLY after a failure,
 * widen to 300s.
 *
 * THE TOTAL BUDGET IS NOT RAISED. TOTAL_BUDGET_MS stays 6300000. Widening
 * redistributes spend INSIDE the same active-transport ceiling; it can never
 * extend the outer wall clock (180-minute arXiv step / 300-minute Academic job).
 *
 * @module ingestion/adapters/arxiv-recovery-envelope
 */

// Frozen EXPLICIT version of this envelope, emitted in terminal metadata so a
// failed run's evidence names the exact envelope that produced it. Bump ONLY
// together with a Founder-locked change to the numbers below.
export const RECOVERY_ENVELOPE_VERSION = 'arxiv-oai-slow-tail-v2-2026-07-25';

// Per-request abort window keyed by 1-based same-token attempt: 120s/300s/300s.
export const ATTEMPT_TIMEOUTS_MS = Object.freeze([120000, 300000, 300000]);

// Arbiter-owned wait AFTER attempt N fails, before attempt N+1: 60s then 300s.
// There is no backoff after the final attempt (there is no attempt 4). These
// waits are CHARGED to the same active-transport budget as the requests, and run
// through the injectable sleep seam so tests never wait in real time.
export const TOKEN_BACKOFF_MS = Object.freeze([60000, 300000]);

// Max requests for ONE unchanged continuation token (initial + 2 retries).
export const MAX_REQUESTS_PER_TOKEN = 3;

// Per-request hard ceiling regardless of remaining budget = widest attempt.
export const MAX_REQUEST_TIMEOUT_MS = Math.max(...ATTEMPT_TIMEOUTS_MS);

// ACTIVE-TRANSPORT ceiling (NOT wall-clock), UNCHANGED by the widening. It bounds
// the sum of every fetch+read+parse+validate span PLUS every arbiter-owned
// retry/backoff wait. It excludes the 20s inter-page pacing and all
// enrichBatch()/ar5iv time, which run outside any span.
//
// ORIGINAL DERIVATION (retained, from the pre-widening contract): a healthy deep
// walk is ~60 resumption pages; worst-case deep slow-tail 90s/page -> 60*90s =
// 5400s of transport, PLUS a bounded same-token retry allowance of ~600s ->
// ~6000s, rounded UP to 6300000ms (105min) of PURE active transport.
export const TOTAL_BUDGET_MS = 6300000;

// NO_PROGRESS: bounded window of accepted pages over which zero RAW transport
// progress (no new raw record IDs / fingerprint change / token advance) is
// treated as a stall (terminal). Distinct from TOKEN_CYCLE (token identity).
export const NO_PROGRESS_WINDOW = 3;

// Worst case for ONE token, DERIVED (never hand-typed) from the two arrays:
// 120s + 60s + 300s + 300s + 300s = 1080000ms = 18 minutes. Bounded by
// TOTAL_BUDGET_MS (105 min) and far below the 180-minute arXiv step timeout.
export const WORST_CASE_TOKEN_MS =
    ATTEMPT_TIMEOUTS_MS.reduce((a, b) => a + b, 0) + TOKEN_BACKOFF_MS.reduce((a, b) => a + b, 0);

// -- RUN-LEVEL ACCOUNTING (must stay honest; see the arithmetic note below) ----
// Inputs of the ORIGINAL budget derivation, now named so a test can pin them.
export const HEALTHY_WALK_PAGES = 60;
export const HEALTHY_PAGE_TRANSPORT_MS = 90000; // worst-case healthy slow-tail page
export const HEALTHY_WALK_TRANSPORT_MS = HEALTHY_WALK_PAGES * HEALTHY_PAGE_TRANSPORT_MS;

// WHAT THE WIDENING DID TO THE RUN-LEVEL SUM -- STATED PLAINLY. The old per-token
// retry allowance was ~600000ms; WORST_CASE_TOKEN_MS is now 1080000ms, i.e. 1.8x.
// 5400000 (healthy walk) + 1080000 (one worst-case token) = 6480000 > 6300000.
// So under the widened envelope a full 60-page 90s/page walk that ALSO burns one
// complete 3-attempt slow-tail window no longer fits the (Founder-locked, not to
// be raised) budget: it exhausts ~180000ms early and terminates
// TOTAL_BUDGET_EXHAUSTED. That is fail-loud, never a silent partial and never
// Academic authority -- but it IS a real narrowing of run-level slack that the
// per-token view (18min < 105min) hides, so it is recorded here, not smoothed over.

// NON-TRANSPORT time. Excluded from the budget by design, yet it shares the SAME
// 180-minute arXiv step. Pacing = the explicit 20s inter-page wait; polite = the
// 250ms pre-request spacing; ar5iv = enrichBatch()'s min(10, batch) fetches at the
// 5000ms RATE_LIMIT_MS floor in ar5iv-fetcher.js (>=50s/page). Enrichment RUNS in
// production: ENABLE_AR5IV is set nowhere in .github/, and the guard disables only
// on the exact string 'false'.
export const INTER_PAGE_PACING_MS = 20000;
export const POLITE_SPACING_MS = 250;
// FLOOR only: 10 fetches x the 5000ms RATE_LIMIT_MS spacing, with each fetch's OWN
// latency excluded. WORST adds that latency: ar5iv-fetcher's FETCH_TIMEOUT_MS caps a
// single fetch at 15000ms, and a fetch that slow already exceeds the 5000ms spacing,
// so the worst per-page cost is 10 x 15000 = 150000, not 50000.
export const AR5IV_PER_PAGE_FLOOR_MS = 50000;
export const AR5IV_FETCH_TIMEOUT_MS = 15000;
export const AR5IV_PER_PAGE_WORST_MS = 10 * AR5IV_FETCH_TIMEOUT_MS;

// The outer deadlines this run must fit inside (mirrors factory-harvest.yml).
export const ARXIV_STEP_TIMEOUT_MS = 180 * 60 * 1000;
export const ACADEMIC_JOB_TIMEOUT_MS = 300 * 60 * 1000;

// EXPECTED FLOOR (NOT a worst case -- named accordingly). Transport ceiling plus the
// non-transport FLOOR: 6300000 + 60*(20000+50000+250) = 10515000ms = 175.25min.
// Against the 180-minute step that leaves 285000ms = 4.75min -- and even this
// optimistic figure already fails to cover the 300000ms terminalization reserve.
export const EXPECTED_WALL_CLOCK_FLOOR_MS = TOTAL_BUDGET_MS +
    HEALTHY_WALK_PAGES * (INTER_PAGE_PACING_MS + AR5IV_PER_PAGE_FLOOR_MS + POLITE_SPACING_MS);
export const STEP_WALL_CLOCK_HEADROOM_MS = ARXIV_STEP_TIMEOUT_MS - EXPECTED_WALL_CLOCK_FLOOR_MS;

// THE ACTUAL WORST CASE, with ar5iv fetch latency included:
// 6300000 + 60*(20000+150000+250) = 16515000ms = 275.25min. That OVERRUNS the
// 180-minute step by 5715000ms = 95.25min. The static envelope therefore does NOT
// fit the step in the worst case, and no arrangement of the Founder-locked constants
// makes it fit. Only the RUNTIME admission gate keeps such a run auditable: it stops
// the walk with terminal evidence instead of letting the runner kill the step.
export const WORST_CASE_WALL_CLOCK_MS = TOTAL_BUDGET_MS +
    HEALTHY_WALK_PAGES * (INTER_PAGE_PACING_MS + AR5IV_PER_PAGE_WORST_MS + POLITE_SPACING_MS);
export const WORST_CASE_STEP_OVERRUN_MS = WORST_CASE_WALL_CLOCK_MS - ARXIV_STEP_TIMEOUT_MS;

// The non-transport tail that follows ONE accepted page, in two readings.
// FORESEEABLE_TAIL_MS is the EXPECTED figure and is used only for the run-level
// derivation/reporting. FORESEEABLE_TAIL_WORST_MS is the BOUND, and is the only one
// the runtime admission gate may use: a bound priced at a floor is not a bound. With
// the floor a single page could exceed its priced cost by 100000ms, so the
// terminalization reserve was silently absorbing under-pricing (about three pages'
// worth) -- the same hole NBF-1 closed, one level down. Pricing the bound means the
// gate never relies on the reserve for anything but terminalization.
// ar5iv bound: enrichBatch() issues at most 10 fetches; ar5iv-fetcher stamps
// _lastFetchTime BEFORE each fetch, so consecutive starts are >= RATE_LIMIT_MS apart
// and each fetch is capped by FETCH_TIMEOUT_MS -- every call therefore costs at most
// max(5000, 15000) = 15000, giving 10 x 15000 = 150000 per page. This holds ONLY
// because that timeout now covers the complete response lifecycle (NBF-4); with the
// timer cleared at headers the body read was unbounded and so was this figure.
// CAVEAT, stated rather than assumed away: the deadline covers up to response.text()
// returning. extractMainContent() then runs INSIDE the try but AFTER the read, so it
// is outside the bound. It is a synchronous regex pipeline over <= MAX_HTML_SIZE
// (500KB) -- sub-millisecond to low-millisecond, ~4 orders of magnitude below the
// 15000 term -- so it does not threaten 170250, but the bound is "<= 15000 to
// text() returning", not "<= 15000 to function return".
export const FORESEEABLE_TAIL_MS = INTER_PAGE_PACING_MS + AR5IV_PER_PAGE_FLOOR_MS + POLITE_SPACING_MS;
export const FORESEEABLE_TAIL_WORST_MS = INTER_PAGE_PACING_MS + AR5IV_PER_PAGE_WORST_MS + POLITE_SPACING_MS;

// -- FOUNDER-RULED RUNTIME CONTROLS (2026-07-25) ------------------------------
// Reserved wall clock, NEVER inside TOTAL_BUDGET_MS and never spendable on a real
// request or wait. It exists so the run can always emit terminal metadata + the
// sidecar and throw a non-zero terminal BEFORE the runner kills the step (a runner
// kill leaves no sidecar at all). The admission gate refuses any action whose
// bounded worst case would eat into it.
export const TERMINALIZATION_RESERVE_MS = 300000;
export const ADMISSION_DEADLINE_MS = ARXIV_STEP_TIMEOUT_MS - TERMINALIZATION_RESERVE_MS;

// HONEST CONSEQUENCE, STATED: even the OPTIMISTIC floor (10515000) exceeds the
// 10500000 admission line by 15000ms; the true worst case (16515000) exceeds it by
// 6015000ms. The static arithmetic leaves no room for the reserve under EITHER
// reading, which is exactly why the runtime gate must exist and must cover ordinary
// pages, not only retries.
export const FLOOR_RESERVE_SHORTFALL_MS = EXPECTED_WALL_CLOCK_FLOOR_MS - ADMISSION_DEADLINE_MS;

// At most ONE continuation token per run may enter attempt 3. Consumed BEFORE the
// third request; never refunded by that attempt's success or failure.
export const MAX_THIRD_ATTEMPT_TOKENS_PER_RUN = 1;

// A server Retry-After may still choose the wait, but only inside the repository's
// existing 5-minute safety policy (base-adapter.js MAX_WAIT_MS), which the arXiv
// path previously bypassed. Preserving precedence does not mean letting a server
// extend local execution without bound.
export const MAX_RETRY_AFTER_MS = 300000;

/** Abort window for a 1-based same-token attempt (clamped to the envelope). */
export function attemptTimeoutMs(attempt) {
    const i = Math.min(Math.max(attempt, 1), ATTEMPT_TIMEOUTS_MS.length) - 1;
    return ATTEMPT_TIMEOUTS_MS[i];
}

/** Default backoff to wait AFTER 1-based attempt `attempt` failed. */
export function attemptBackoffMs(attempt) {
    const i = Math.min(Math.max(attempt, 1), TOKEN_BACKOFF_MS.length) - 1;
    return TOKEN_BACKOFF_MS[i];
}

/**
 * The CONFIGURED envelope, as terminal-metadata fields. Copies of the frozen
 * arrays so a metadata consumer can never mutate the envelope. Describes only
 * what was configured -- it asserts nothing about the run's outcome and never
 * implies that a failed or partial harvest established Academic authority.
 */
export function envelopeMetadata() {
    return {
        attempt_timeouts_ms: [...ATTEMPT_TIMEOUTS_MS],
        attempt_backoffs_ms: [...TOKEN_BACKOFF_MS],
        recovery_envelope_version: RECOVERY_ENVELOPE_VERSION,
    };
}

export default {
    RECOVERY_ENVELOPE_VERSION, ATTEMPT_TIMEOUTS_MS, TOKEN_BACKOFF_MS,
    MAX_REQUESTS_PER_TOKEN, MAX_REQUEST_TIMEOUT_MS, TOTAL_BUDGET_MS,
    NO_PROGRESS_WINDOW, WORST_CASE_TOKEN_MS, HEALTHY_WALK_TRANSPORT_MS,
    EXPECTED_WALL_CLOCK_FLOOR_MS, WORST_CASE_WALL_CLOCK_MS, WORST_CASE_STEP_OVERRUN_MS,
    STEP_WALL_CLOCK_HEADROOM_MS, FLOOR_RESERVE_SHORTFALL_MS,
    attemptTimeoutMs, attemptBackoffMs, envelopeMetadata,
};
