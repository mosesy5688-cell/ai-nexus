/**
 * Semantic Scholar bulk-search RECOVERY ENVELOPE -- the FROZEN bounded retry
 * constants plus the PURE failure taxonomy and terminal-error builder.
 *
 * WHY IT EXISTS (2026-07-26 Factory 1/4 S2 incident, run 30189935455). The daily
 * cron Harvest Ecosystem job failed while Academic / GitHub / HuggingFace each
 * succeeded and established their own R2 authority; `Merge & Upload` was
 * correctly SKIPPED and nothing was published. Data safety held. But the
 * per-source telemetry LIED about the cause:
 *
 *   { "status": "floor_violation", "had_adapter_error": false,
 *     "errors": ["floor violation: 0 < 300"] }
 *
 * The real cause was a swallowed transport failure. semanticscholar-adapter.js
 * handled a throw from fetchWithTimeout() with `console.error` + `break`, and an
 * HTTP 500 reaching `!response.ok` with `console.warn` + `break`, then returned
 * an empty array WITHOUT throwing. harvest-single.js therefore saw a clean
 * zero-yield with no adapter error and reached the known-large FLOOR gate --
 * a misclassification produced by the swallow, not a telemetry display bug.
 *
 * WHAT THIS MODULE IS NOT. It is NOT a second retry mechanism. The repository's
 * existing authorities keep their jobs untouched:
 *   - BaseAdapter.handleRateLimit() stays the SOLE owner of 403 / 429 / 503
 *     (Retry-After precedence, escalation, circuit breaker). Those statuses are
 *     deliberately absent from RETRYABLE_STATUSES below.
 *   - BaseAdapter.fetchWithTimeout() stays the sole owner of the per-request
 *     abort window; this envelope never re-times a request.
 *   - FetchError (base-adapter.js) stays the canonical hard-error type; this
 *     module only fills it in.
 * What is genuinely new is a bounded same-query 5xx ladder, modelled on the
 * arXiv recovery lane's shape (arxiv-recovery-envelope.js / -recovery-state.js /
 * -terminal-meta.js: frozen constants module + single arbiter + terminal
 * metadata carried in FetchError.meta). The arXiv CONSTANTS are not imported:
 * every one of them is Founder-locked to the arXiv OAI resumption-token model
 * and the 180-minute arXiv step (ARXIV_STEP_TIMEOUT_MS, MAX_REQUESTS_PER_TOKEN,
 * TOTAL_BUDGET_MS), so importing them would silently bind Semantic Scholar to
 * numbers ruled for a different source and a different step timeout.
 *
 * NO CLAIM ABOUT THE PROVIDER. Nothing here asserts that the observed HTTP 500
 * was a temporary provider outage; there is no evidence for that. The ladder is
 * a bounded tolerance for a retryable status, and its EXHAUSTION fails loud.
 *
 * @module ingestion/adapters/s2-retry-envelope
 */
import { FetchError } from './base-adapter.js';

/** Frozen version, emitted in terminal metadata so evidence names its envelope. */
export const S2_RECOVERY_ENVELOPE_VERSION = 's2-bulk-recovery-v1-2026-07-26';

/** The `sourceName` harvest-single.js is invoked with (harvest-floors.js key). */
export const S2_SOURCE = 'semanticscholar';

/**
 * FAILURE KINDS -- the five outcomes that must stay DISTINGUISHABLE in evidence.
 * `retry_exhaustion` is a TERMINAL, not an attempt outcome, so it is not here:
 * an exhausted ladder reports TERMINAL.ATTEMPTS_EXHAUSTED together with the LAST
 * attempt's own kind, which is strictly more informative than collapsing both.
 */
export const FAILURE_KIND = Object.freeze({
    NETWORK: 'network_failure',
    TIMEOUT: 'request_timeout',
    HTTP_STATUS: 'non_2xx',
    PARSE: 'parse_failure',
});

/** Terminals. Each fails loud; none can produce a clean []. */
export const TERMINAL = Object.freeze({
    ATTEMPTS_EXHAUSTED: 'ATTEMPTS_EXHAUSTED',
    RETRY_BUDGET_EXHAUSTED: 'RETRY_BUDGET_EXHAUSTED',
    NON_RETRYABLE_HTTP: 'NON_RETRYABLE_HTTP',
    NON_RETRYABLE_PARSE: 'NON_RETRYABLE_PARSE',
});

/**
 * FAILURE_KIND -> FetchError.kind, using the EXISTING H1 taxonomy that
 * base-adapter.js documents and harvest-single.js already consumes
 * ('fetch' | 'abort' | 'parse'). `abort` is what makes harvest-single stamp
 * status=timeout + timeout_kind=request_timeout; every other kind lands on
 * status=failed. Both are fail-loud, non-zero.
 */
export const FETCH_ERROR_KIND = Object.freeze({
    [FAILURE_KIND.NETWORK]: 'fetch',
    [FAILURE_KIND.TIMEOUT]: 'abort',
    [FAILURE_KIND.HTTP_STATUS]: 'fetch',
    [FAILURE_KIND.PARSE]: 'parse',
});

/** Requests for ONE unchanged query+page (initial + 3 retries). */
export const MAX_REQUESTS_PER_PAGE = 4;

/** Arbiter-owned wait AFTER 1-based attempt N failed. No wait after the last. */
export const PAGE_BACKOFF_MS = Object.freeze([2000, 8000, 30000]);

/**
 * Bounded wall clock for ALL arbiter-owned retry waits in ONE run (not per
 * query). It caps the recovery lane's whole contribution to the 60-minute
 * `Harvest Semantic Scholar` step, so a provider that 5xx-es on every topic can
 * never turn the step into a runner kill (a kill leaves NO sidecar at all).
 * DERIVATION: one full ladder costs 2000+8000+30000 = 40000ms of waiting;
 * 300000 admits seven such ladders and refuses the eighth.
 */
export const TOTAL_RETRY_BUDGET_MS = 300000;

/** Worst case for ONE page, DERIVED from the arrays -- never hand-typed. */
export const WORST_CASE_PAGE_WAIT_MS = PAGE_BACKOFF_MS.reduce((a, b) => a + b, 0);

/**
 * Statuses the bounded ladder may retry. 503 is EXCLUDED on purpose: it carries
 * Retry-After semantics and already belongs to handleRateLimit(), as do 403/429.
 * 4xx are excluded: a bad request/quota/not-found does not become valid by
 * repetition, so those fail loud on the first response.
 */
export const RETRYABLE_STATUSES = Object.freeze([500, 502, 504, 522, 524]);

/** True when `status` is inside the bounded 5xx ladder. */
export function isRetryableStatus(status) {
    return RETRYABLE_STATUSES.includes(status);
}

/** Wait AFTER 1-based attempt `attempt` failed (clamped to the envelope). */
export function attemptBackoffMs(attempt) {
    const i = Math.min(Math.max(attempt, 1), PAGE_BACKOFF_MS.length) - 1;
    return PAGE_BACKOFF_MS[i];
}

/**
 * A thrown transport error -> FAILURE_KIND. AbortError is what
 * fetchWithTimeout() raises when its window elapses, so it is a TIMEOUT; every
 * other throw (undici TypeError 'fetch failed', DNS, reset) is a NETWORK
 * failure. The two are never collapsed.
 */
export function classifyThrown(error) {
    return error?.name === 'AbortError' ? FAILURE_KIND.TIMEOUT : FAILURE_KIND.NETWORK;
}

/** The CONFIGURED envelope as metadata fields (copies -- never the frozen refs). */
export function envelopeMetadata() {
    return {
        recovery_envelope_version: S2_RECOVERY_ENVELOPE_VERSION,
        max_requests_per_page: MAX_REQUESTS_PER_PAGE,
        attempt_backoffs_ms: [...PAGE_BACKOFF_MS],
        total_retry_budget_ms: TOTAL_RETRY_BUDGET_MS,
        retryable_statuses: [...RETRYABLE_STATUSES],
    };
}

/**
 * Build the fail-loud FetchError for a terminal, carrying machine-readable
 * evidence in `err.meta` -- the same contract arxiv-terminal-meta.js uses, which
 * harvest-single.js merges into the terminal_meta sidecar.
 *
 * HONESTY: every field describes a FAILURE. `failed_topic` and `last_http_status`
 * are preserved verbatim so the incident's real cause is never replaced by a
 * floor number. `last_http_status` is null -- never a synthesized 0/408/504 --
 * when the failure carried no HTTP status line (local abort, transport throw).
 * Nothing here can be read as asserting that a partial harvest established
 * Ecosystem authority.
 *
 * @param {Object} snap - S2RetryState.snapshot() output.
 * @param {string} terminal - a TERMINAL value.
 */
export function buildTerminalError(snap, terminal) {
    const kind = FETCH_ERROR_KIND[snap.last_failure_kind] || 'fetch';
    const detail = `${terminal} on topic "${snap.failed_topic}" `
        + `(failure=${snap.last_failure_kind}, http=${snap.last_http_status ?? 'none'}, `
        + `attempt ${snap.attempts}/${MAX_REQUESTS_PER_PAGE}): `
        + `${snap.accepted_unique_ids} accepted before failure -- source INCOMPLETE`;
    return new FetchError(S2_SOURCE, kind, detail, {
        terminal,
        failure_kind: snap.last_failure_kind,
        last_http_status: snap.last_http_status,
        failed_topic: snap.failed_topic,
        failed_page_index: snap.failed_page_index,
        attempts: snap.attempts,
        total_retries: snap.total_retries,
        retry_wait_ms: snap.retry_wait_ms,
        accepted_pages: snap.accepted_pages,
        accepted_unique_ids: snap.accepted_unique_ids,
        elapsed_ms: snap.elapsed_ms,
        source_complete: false,
        ...envelopeMetadata(),
    });
}

export default {
    S2_RECOVERY_ENVELOPE_VERSION, S2_SOURCE, FAILURE_KIND, TERMINAL,
    FETCH_ERROR_KIND, MAX_REQUESTS_PER_PAGE, PAGE_BACKOFF_MS,
    TOTAL_RETRY_BUDGET_MS, WORST_CASE_PAGE_WAIT_MS, RETRYABLE_STATUSES,
    isRetryableStatus, attemptBackoffMs, classifyThrown, envelopeMetadata,
    buildTerminalError,
};
