/**
 * ArXiv OAI Recovery State Machine (WO-3-A1 PR-A1: Transport Recovery Core)
 *
 * SINGLE-ARBITER for ALL retry/budget/progress state of the OAI-PMH ListRecords
 * pagination loop; no independent retry budgets exist anywhere else.
 *
 * BLOCKER A -- TRUE ACTIVE-TRANSPORT BUDGET: measures ONLY active OAI transport
 * time (each fetch + XML read/parse + page-validation span, plus arbiter-owned
 * retry/backoff sleeps). It does NOT accumulate enrichBatch()/ar5iv time, the 20s
 * inter-page pacing, or normalize/relation work. budgetExhausted()/remaining derive
 * from `transportActiveMs`, NOT wall-clock since startedAt. TOKEN LIFECYCLE:
 * same-run only, never persisted.
 *
 * @module ingestion/adapters/arxiv-recovery-state
 */
// The FROZEN per-token envelope (2026-07-25 arXiv P0 slow-tail widening:
// 120/300/300s requests, 60/300s backoffs, 3 requests/token, UNCHANGED 6300000ms
// active-transport ceiling) lives in one auditable module, re-exported whole so
// the arbiter stays the single import surface for its existing consumers.
export * from './arxiv-recovery-envelope.js';
import {
    MAX_REQUESTS_PER_TOKEN, TOTAL_BUDGET_MS, NO_PROGRESS_WINDOW,
    attemptBackoffMs, attemptTimeoutMs,
} from './arxiv-recovery-envelope.js';
// Run-scoped admission policy (Founder ruling): third-attempt quota + wall-clock
// gate + Retry-After cap. It owns no advancement; this arbiter is its only caller.
import { PROCESS_RUN_SCOPE, createRunScope, effectiveRetryAfterMs, nextPageCostMs, recordAdmission, retryDecision, tokenFingerprint } from './arxiv-run-admission.js';
export { createRunScope, tokenFingerprint } from './arxiv-run-admission.js';
export { TERMINAL_KIND } from './arxiv-terminal-meta.js';
import { buildSnapshot, buildTerminalError } from './arxiv-terminal-meta.js';

/**
 * The single-arbiter transport budget + retry/progress state machine.
 * @param {Object} [deps] - seams: deps.now (clock, Date.now), deps.sleep (zeroable).
 */
export class ArxivRecoveryState {
    constructor(deps = {}) {
        this.now = deps.now || (() => Date.now());
        this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.startedAt = this.now();
        this.transportActiveMs = 0; // BLOCKER A: cumulative ACTIVE-transport (spans+sleeps).
        this._spanStartedAt = null; // open transport span marker.
        this.currentToken = null; this.tokenAttempts = 0; // token + same-token attempts.
        this.acceptedPages = 0; this.acceptedUniqueIds = 0; this.totalRetries = 0;
        this.lastProgressAt = this.startedAt;
        this.progressWindow = [];   // BLOCKER D: window keyed on RAW progress, not yield.
        this.seenPageFingerprints = new Set(); // replayed raw page = no-progress.
        this.tokenHistory = [];     // TOKEN_CYCLE: ordered accepted next-tokens.
        // 2026-07-25 slow-tail evidence: COMPLETED recoveries (page committed after a
        // slow-tail failure on the SAME token) -- never attempts; per-token-window
        // slow-tail flag; last FAILED attempt's kind/status (null when there was none).
        this.slowTailRecoveries = 0; this.tokenSlowTail = false;
        this.lastErrorKind = null; this.lastHttpStatus = null;
        this.lastRetryAfterRawMs = null; // RAW header value, diagnostics ONLY (never slept).
        this.runElapsedMs = null; this.projectedCompletionMs = null; // last admission evidence.
        // RUN scope (Founder ruling): PROCESS-scoped in production, so the third-attempt
        // quota and the run-start anchor survive arbiter re-initialisation / token-loop
        // reconstruction / exception re-entry within the process (= the run). PRODUCTION
        // NEVER passes deps: ArXivAdapter.fetch() calls fetchOAI(options) with no second
        // argument, so the live path always lands on PROCESS_RUN_SCOPE. A scope is only
        // comparable to the clock that stamped its start, so an INJECTED clock gets its
        // own scope unless the caller supplies one explicitly (how the quota/re-entry
        // tests deliberately share one). Stamped ONCE; a scope carrying a corrupt
        // (non-finite) start is never re-stamped and makes admitWallClock fail closed.
        this.runScope = deps.runScope || (deps.now ? createRunScope() : PROCESS_RUN_SCOPE);
        if (this.runScope.startedAtMs === undefined) this.runScope.startedAtMs = this.now();
    }

    // -- BLOCKER A: active-transport span accounting -------------------------

    /** Open a transport span (fetch+read+parse+validate). Charges on endSpan. */
    startSpan() {
        this._spanStartedAt = this.now();
    }

    /** Close the open transport span, charging its elapsed ms to the budget. */
    endSpan() {
        if (this._spanStartedAt === null) return 0;
        const elapsed = Math.max(0, this.now() - this._spanStartedAt);
        this.transportActiveMs += elapsed;
        this._spanStartedAt = null;
        return elapsed;
    }

    /** Remaining ACTIVE-transport budget (never negative). */
    remainingTransportBudget() {
        return Math.max(0, TOTAL_BUDGET_MS - this.transportActiveMs);
    }

    /** True once the cumulative ACTIVE-transport budget is exhausted. */
    budgetExhausted() {
        return this.remainingTransportBudget() <= 0;
    }

    // -- token lifecycle -----------------------------------------------------

    /**
     * Begin/continue work on a token (called before each request). Resets the
     * attempt counter when the token CHANGES, scoping the per-token budget.
     */
    beginToken(token) {
        if (token !== this.currentToken) {
            this.currentToken = token;
            this.tokenAttempts = 0;
            this.tokenSlowTail = false; // new token window: fresh slow-tail state.
        }
        this.tokenAttempts++;
        return this.tokenAttempts;
    }

    /** True if another retry of the SAME current token remains in the per-token budget. */
    canRetryToken() {
        return this.tokenAttempts < MAX_REQUESTS_PER_TOKEN;
    }

    /**
     * Record a FAILED transport attempt for the CURRENT token (adapter calls it on
     * every http/fetch/parse/oai failure branch, retryable or not). HONESTY:
     * httpStatus is stored ONLY when the failure carried a real HTTP status line; a
     * local abort/timeout, a transport throw, a parse failure, or an OAI <error>
     * envelope on an otherwise-200 body store null -- never a synthesized 0/408/504.
     * errorKind 'abort' (per-request timeout) marks a slow-tail token window.
     * @param {string} errorKind - 'abort' | 'fetch' | 'parse' | 'http' | 'oai'.
     */
    recordAttemptFailure(errorKind, httpStatus) {
        this.lastErrorKind = errorKind || null;
        this.lastHttpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
        if (errorKind === 'abort') this.tokenSlowTail = true;
    }

    /**
     * BLOCKER A: per-request timeout = min(this attempt's envelope window, remaining
     * active-transport budget). Attempt 1 = 120000 (normal/fast page, unchanged
     * cost); attempts 2-3 = 300000 (slow-tail recovery only). remaining <= 0 ->
     * caller issues no further request.
     */
    requestTimeoutMs() {
        return Math.min(attemptTimeoutMs(this.tokenAttempts), this.remainingTransportBudget());
    }

    /**
     * BLOCKER C: compute + EXECUTE an arbiter-owned retry wait, charged to the
     * active-transport budget. Retry-After (when present) wins over the default
     * backoff but is still bounded by remaining budget. Returns true if the wait
     * executed (retry SAME token); false if it cannot fit (caller fails loud).
     * @param {number} [retryAfterMs] - server Retry-After in ms (optional).
     */
    /**
     * The wait the arbiter WOULD execute next: the configured backoff for the
     * just-failed attempt (60s then 300s), unless a server Retry-After supplies a
     * shorter-or-capped hint. BF-2: the hint is clamped to MAX_RETRY_AFTER_MS, so
     * the CAPPED value is what gets slept, charged and wall-clock admitted; the raw
     * header is kept only as diagnostics. Used by the admission gate and the wait
     * itself, so both reason about exactly the same number.
     */
    plannedWaitMs(retryAfterMs) {
        this.lastRetryAfterRawMs = Number.isFinite(retryAfterMs) ? retryAfterMs : null;
        const hint = effectiveRetryAfterMs(retryAfterMs);
        return hint === null ? attemptBackoffMs(this.tokenAttempts) : hint;
    }

    /**
     * SINGLE retry entry point for the adapter. Returns null when the retry is
     * admitted (its wait already executed), else the TERMINAL to fail loud with.
     * The arbiter stays the only owner: this just composes its own state.
     */
    async requestRetry(retryAfterMs) {
        return retryDecision(this, retryAfterMs);
    }

    /** Wall-clock admission for a `costMs` action; records the evidence either way. */
    admit(costMs) {
        return recordAdmission(this, costMs);
    }

    /** NBF-1: admission for an ORDINARY page request (pacing/enrichment follow each). */
    admitNextPage() {
        return recordAdmission(this, nextPageCostMs());
    }

    async executeRetryWait(retryAfterMs) {
        const ms = this.plannedWaitMs(retryAfterMs);
        // REFUSED-DUE-TO-BUDGET (Blocker 2): if the FULL wait cannot fit the remaining
        // active-transport budget, refuse without sleeping/charging so the adapter
        // classifies TOTAL_BUDGET_EXHAUSTED, not a clipped partial wait masquerading as
        // a retry. Refusal-due-to-ATTEMPTS is the adapter's canRetryToken() gate.
        if (ms > this.remainingTransportBudget()) return false;
        await this.sleep(ms);
        this.transportActiveMs += ms; // arbiter-owned wait IS active-transport time.
        this.totalRetries++;
        return true;
    }

    // -- BLOCKER D: page acceptance (raw vs product progress) ----------------

    /**
     * BLOCKER D: validate a fully-fetched page; returns terminal hint 'TOKEN_CYCLE'
     * (nextToken repeats / A->B->A) | 'NO_PROGRESS' (zero RAW progress across the
     * window) | null (accepted, advance). RAW progress = a never-seen record-id-only
     * fingerprint (replayed page = no-progress even with a fresh token); rawNewIds
     * rescues the ids-absent fallback. PRODUCT yield drives paper count only. TWO-PHASE:
     * a rejected page mutates NOTHING (validate is pure), so snapshot()/terminal_meta
     * exclude it; mutation happens ONLY in the commit phase below.
     */
    acceptPage({ newProductYield, rawNewIds, pageFingerprint, nextToken }) {
        // PHASE 1 VALIDATE (PURE -- zero mutation before a pass).
        const freshFingerprint = pageFingerprint && !this.seenPageFingerprints.has(pageFingerprint);
        const rawProgress = (freshFingerprint || (!pageFingerprint && rawNewIds > 0)) ? 1 : 0;
        // Candidate window (committed tail + this page) evaluated WITHOUT pushing.
        const candidateWindow = [...this.progressWindow.slice(-(NO_PROGRESS_WINDOW - 1)), rawProgress];
        if (candidateWindow.length >= NO_PROGRESS_WINDOW && candidateWindow.every((d) => d === 0)) {
            return 'NO_PROGRESS';
        }
        // Exact repeat of the current token, or an A->B->A oscillation.
        if (nextToken && (nextToken === this.currentToken || this.tokenHistory.indexOf(nextToken) !== -1)) {
            return 'TOKEN_CYCLE';
        }

        // PHASE 2 COMMIT (only after validation passes). All mutation happens here.
        // A page committed on attempt >1 of a slow-tail (abort) token window IS a
        // completed recovery -- counted EXACTLY once, on the commit, never per attempt.
        if (this.tokenAttempts > 1 && this.tokenSlowTail) this.slowTailRecoveries++;
        if (pageFingerprint) this.seenPageFingerprints.add(pageFingerprint);
        if (rawProgress > 0) this.lastProgressAt = this.now();
        this.progressWindow.push(rawProgress);
        if (this.progressWindow.length > NO_PROGRESS_WINDOW) this.progressWindow.shift();
        this.acceptedPages++;
        this.acceptedUniqueIds += newProductYield;
        if (nextToken) this.tokenHistory.push(nextToken);
        return null;
    }

    /** Truthful partial-yield metadata for a terminal (never healthy-partial). */
    snapshot(terminal) {
        return buildSnapshot(this, terminal);
    }

    /** BLOCKER E: the fail-loud FetchError + structured `err.meta` for a terminal. */
    terminalError(terminal, uniqueIds) {
        return buildTerminalError(this, terminal, uniqueIds);
    }
}

export default ArxivRecoveryState;
