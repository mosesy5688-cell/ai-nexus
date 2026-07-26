/**
 * Semantic Scholar bulk-search SINGLE ARBITER for retry/budget/progress state.
 *
 * Mirrors the role arxiv-recovery-state.js plays for the arXiv OAI walk: exactly
 * one object owns attempts, the bounded wait budget, the last observed failure and
 * the terminal-error construction, so no independent retry counter can exist
 * anywhere else in the Semantic Scholar lane. It holds NO transport: it never
 * fetches, never parses, and never decides what a page means. The loop
 * (s2-bulk-search.js) is its only caller.
 *
 * SEAMS. `now` and `sleep` are injectable exactly as they are on
 * ArxivRecoveryState, so the bounded ladder is unit-testable without waiting in
 * real time. PRODUCTION NEVER INJECTS: SemanticScholarAdapter.fetch() constructs
 * this with no deps, so the live path always uses Date.now + a real timer.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN:
 *   - 403/429/503 -> BaseAdapter.handleRateLimit() keeps that job, including
 *     Retry-After precedence and its RateLimitExceededError circuit breaker.
 *   - the per-request abort window -> BaseAdapter.fetchWithTimeout().
 *   - the hard-error type -> FetchError, via s2-retry-envelope.buildTerminalError.
 *
 * @module ingestion/adapters/s2-retry-state
 */
import {
    MAX_REQUESTS_PER_PAGE, TOTAL_RETRY_BUDGET_MS, TERMINAL,
    attemptBackoffMs, buildTerminalError, envelopeMetadata,
} from './s2-retry-envelope.js';

export class S2RetryState {
    /** @param {Object} [deps] - seams: deps.now (clock), deps.sleep (zeroable). */
    constructor(deps = {}) {
        this.now = deps.now || (() => Date.now());
        this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.startedAt = this.now();
        // Request identity: the EXACT url of the page being (re)requested. A retry
        // must repeat the same query and the same continuation token, so the url IS
        // the identity -- a changed url is a new page and resets the ladder.
        this.currentKey = null;
        this.attempts = 0;
        this.totalRetries = 0;
        this.retryWaitMs = 0;       // cumulative arbiter-owned wait (the budget).
        this.lastFailureKind = null; // never guessed; null until a failure happens.
        this.lastHttpStatus = null;  // ONLY when a real HTTP status line existed.
        this.acceptedPages = 0;
        this.acceptedUniqueIds = 0;
        // Evidence for the terminal: which topic/page was in flight when it failed.
        this.currentTopic = null;
        this.currentPageIndex = 0;
        // Incompleteness marker for a stop that carries NO hard error (the
        // rate-limit breaker). Read by the adapter to publish terminalMeta so the
        // run can never be classified `success`. See s2-bulk-search.js.
        this.incompleteReason = null;
    }

    /** Enter a topic. Page index is 1-based and only advances on acceptance. */
    beginTopic(topic) {
        this.currentTopic = topic;
        this.currentPageIndex = 1;
    }

    /**
     * Begin/continue work on one page request. Resets the attempt counter when the
     * url CHANGES, which is what scopes the ladder to a single unchanged query.
     * @param {string} url - the exact request url.
     * @returns {number} the 1-based attempt number for this url.
     */
    beginRequest(url) {
        if (url !== this.currentKey) {
            this.currentKey = url;
            this.attempts = 0;
        }
        this.attempts++;
        return this.attempts;
    }

    /**
     * Record a FAILED attempt for the CURRENT page. HONESTY: `httpStatus` is stored
     * ONLY when the failure carried a real HTTP status line. A local abort, a
     * transport throw or a body-parse failure store null -- never a synthesized
     * 0/408/504.
     * @param {string} failureKind - a FAILURE_KIND value.
     * @param {number|null} [httpStatus]
     */
    recordAttemptFailure(failureKind, httpStatus) {
        this.lastFailureKind = failureKind || null;
        this.lastHttpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
    }

    /** Remaining bounded wait budget for the whole run (never negative). */
    remainingRetryBudgetMs() {
        return Math.max(0, TOTAL_RETRY_BUDGET_MS - this.retryWaitMs);
    }

    /** True once the run's bounded wait budget is spent. */
    budgetExhausted() {
        return this.remainingRetryBudgetMs() <= 0;
    }

    /** True while another attempt at the SAME url remains in the bounded ladder. */
    canRetry() {
        return this.attempts < MAX_REQUESTS_PER_PAGE;
    }

    /** The wait the arbiter WOULD execute next: the configured backoff, nothing else. */
    plannedWaitMs() {
        return attemptBackoffMs(this.attempts);
    }

    /**
     * THE single retry entry point. Returns null when the retry is admitted AND its
     * wait has already been executed, so the caller may repeat the SAME url. Any
     * other return is the TERMINAL the caller must fail loud with. Nothing sleeps on
     * a refusing path.
     *
     * Precedence: (1) bounded wait budget already spent; (2) bounded attempts for
     * this url exhausted; (3) the FULL next wait does not fit the remaining budget
     * -- refuse without a clipped partial wait masquerading as a retry.
     */
    async requestRetry() {
        if (this.budgetExhausted()) return TERMINAL.RETRY_BUDGET_EXHAUSTED;
        if (!this.canRetry()) return TERMINAL.ATTEMPTS_EXHAUSTED;
        const ms = this.plannedWaitMs();
        if (ms > this.remainingRetryBudgetMs()) return TERMINAL.RETRY_BUDGET_EXHAUSTED;
        await this.sleep(ms);
        this.retryWaitMs += ms;
        this.totalRetries++;
        return null;
    }

    /** Commit an accepted page. Advances the page index; yield is product count. */
    acceptPage(newUniqueIds) {
        this.acceptedPages++;
        this.acceptedUniqueIds += newUniqueIds;
        this.currentPageIndex++;
    }

    /**
     * Mark the source INCOMPLETE for a stop that carries no hard error (today only
     * the handleRateLimit circuit breaker, whose RateLimitExceededError is a
     * deliberate CI-throughput tolerance that must stay a non-hard error). Recording
     * it here is what stops the run being reported as plain `success`.
     */
    markIncomplete(reason) {
        this.incompleteReason = reason;
    }

    /** Truthful evidence for a terminal. Describes a FAILURE; asserts no authority. */
    snapshot() {
        return {
            failed_topic: this.currentTopic,
            failed_page_index: this.currentPageIndex,
            last_failure_kind: this.lastFailureKind,
            last_http_status: this.lastHttpStatus,
            attempts: this.attempts,
            total_retries: this.totalRetries,
            retry_wait_ms: this.retryWaitMs,
            accepted_pages: this.acceptedPages,
            accepted_unique_ids: this.acceptedUniqueIds,
            elapsed_ms: this.now() - this.startedAt,
        };
    }

    /**
     * The fail-loud FetchError for `terminal`, carrying the snapshot as `err.meta`.
     * harvest-single.js merges that meta into the terminal_meta sidecar, so the HTTP
     * status and the failed topic survive into the run's evidence instead of being
     * replaced by a floor number.
     */
    terminalError(terminal) {
        return buildTerminalError(this.snapshot(), terminal);
    }

    /**
     * terminalMeta for a NON-error early stop. `budgetCapped` is deliberately absent
     * (that key belongs to the enrich-budget partial in datasets-adapter.js and
     * would misattribute the cause); what matters is that the object is non-null and
     * states source_complete:false.
     */
    incompleteMeta() {
        if (!this.incompleteReason) return null;
        return {
            source_complete: false,
            incomplete_reason: this.incompleteReason,
            accepted_pages: this.acceptedPages,
            accepted_unique_ids: this.acceptedUniqueIds,
            completed_topics: this.completedTopics || 0,
            abandoned_topic: this.currentTopic,
            ...envelopeMetadata(),
        };
    }
}

export default S2RetryState;
