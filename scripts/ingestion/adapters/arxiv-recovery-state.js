/**
 * ArXiv OAI Recovery State Machine (WO-3-A1 PR-A1: Transport Recovery Core)
 *
 * SINGLE-ARBITER for ALL retry/budget/progress state of the OAI-PMH ListRecords
 * pagination loop; no independent retry budgets exist anywhere else.
 *
 * BLOCKER A -- TRUE ACTIVE-TRANSPORT BUDGET: measures ONLY active OAI transport
 * time (each fetch + XML read/parse + page-validation span, plus arbiter-owned
 * retry/backoff sleeps). It does NOT accumulate enrichBatch()/ar5iv time, the 20s
 * inter-page pacing, or normalize/relation work. The adapter wraps each
 * fetch+parse+validate with startSpan()/endSpan(); pacing + enrichment run
 * OUTSIDE any span. budgetExhausted()/remaining derive from `transportActiveMs`,
 * NOT wall-clock since startedAt. TOKEN LIFECYCLE: same-run only, never persisted.
 *
 * @module ingestion/adapters/arxiv-recovery-state
 */
import { FetchError } from './base-adapter.js';

// First page (cold ListRecords, no resumptionToken) absorbs the OAI slow-tail
// spike (observed 65-90s). Deep (resumptionToken) pages get the SAME raised 120s
// budget on every attempt (D-65 s3 / s III.1: resumption PAGE_TIMEOUT_MS 60000 ->
// 120000) so a 65-90s page clears on its FIRST attempt, paired with same-token
// retry for transient failures -- not a standalone bump (retry is mandatory).
export const FIRST_PAGE_TIMEOUT_MS = 120000;
export const PAGE_TIMEOUT_MS = 120000;
export const PAGE_RETRY_TIMEOUT_MS = 120000;
// Per-request hard cap regardless of remaining budget (D-65 deep-page envelope).
export const MAX_REQUEST_TIMEOUT_MS = 120000;

// Bounded same-token retry: max 3 total requests per token (initial + 2 retries).
export const MAX_REQUESTS_PER_TOKEN = 3;
// Bounded backoff between same-token retries, COUNTED against the single budget.
// Injectable/zeroable via the clock+sleep seam so tests never really sleep.
export const TOKEN_BACKOFF_MS = [15000, 30000];

// BLOCKER A -- ACTIVE-TRANSPORT ceiling (NOT wall-clock). Derivation: a healthy
// deep walk is ~60 resumption pages; worst-case deep slow-tail 90s/page ->
// 60*90s = 5400s, plus a bounded same-token retry allowance (a few pages with
// 1-2 retries + their 15s/30s arbiter backoff) ~600s -> 6000s, rounded to
// 6300000ms (105min) of PURE active transport. This EXCLUDES the 20s inter-page
// pacing (60*20s = 1200s) and all enrichBatch()/ar5iv time, so a healthy ~92min
// end-to-end walk stays well under it. The old 600000ms wall-clock ceiling
// counted pacing + enrichment + loop time and killed a healthy walk -- retired.
export const TOTAL_BUDGET_MS = 6300000;

// NO_PROGRESS: bounded window of accepted pages over which zero RAW transport
// progress (no new raw record IDs / fingerprint change / token advance) is
// treated as a stall (terminal). Distinct from TOKEN_CYCLE (token identity).
export const NO_PROGRESS_WINDOW = 3;

/**
 * Short, non-reversible fingerprint of a resumptionToken for logs (never the
 * full token, which is not a governance id and must not be persisted/leaked).
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
        this.currentToken = null;   // current token + its same-token attempt counter.
        this.tokenAttempts = 0;
        this.acceptedPages = 0;
        this.acceptedUniqueIds = 0;
        this.totalRetries = 0;
        this.lastProgressAt = this.startedAt;
        this.progressWindow = [];   // BLOCKER D: window keyed on RAW progress, not yield.
        this.seenPageFingerprints = new Set(); // replayed raw page = no-progress.
        this.tokenHistory = [];     // TOKEN_CYCLE: ordered accepted next-tokens.
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
        }
        this.tokenAttempts++;
        return this.tokenAttempts;
    }

    /** True if another retry of the SAME current token remains in the per-token budget. */
    canRetryToken() {
        return this.tokenAttempts < MAX_REQUESTS_PER_TOKEN;
    }

    /**
     * BLOCKER A: per-request timeout = min(120000 deep-page envelope, remaining
     * active-transport budget). remaining <= 0 -> caller issues no further request.
     */
    requestTimeoutMs() {
        return Math.min(MAX_REQUEST_TIMEOUT_MS, this.remainingTransportBudget());
    }

    /**
     * BLOCKER C: compute + EXECUTE an arbiter-owned retry wait, charged to the
     * active-transport budget. Retry-After (when present) wins over the default
     * backoff but is still bounded by remaining budget. Returns true if the wait
     * executed (retry SAME token); false if it cannot fit (caller fails loud).
     * @param {number} [retryAfterMs] - server Retry-After in ms (optional).
     */
    async executeRetryWait(retryAfterMs) {
        const idx = Math.min(this.tokenAttempts - 1, TOKEN_BACKOFF_MS.length - 1);
        const base = TOKEN_BACKOFF_MS[idx];
        const ms = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : base;
        // REFUSED-DUE-TO-BUDGET (Blocker 2): if the FULL wait cannot fit the remaining
        // active-transport budget, refuse without sleeping/charging so the adapter
        // classifies TOTAL_BUDGET_EXHAUSTED (budgetExhausted() true), not a clipped
        // partial wait masquerading as a retry. Refusal-due-to-ATTEMPTS is the
        // adapter's canRetryToken() gate; this gate is purely budget.
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
     * rescues the ids-absent fallback. PRODUCT yield drives paper count only.
     * TWO-PHASE: a rejected page mutates NOTHING (validate is pure), so snapshot()/
     * terminal_meta exclude it; mutation happens ONLY in the commit phase below.
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
        return {
            terminal,
            accepted_pages: this.acceptedPages,
            accepted_unique_ids: this.acceptedUniqueIds,
            total_retries: this.totalRetries,
            token_attempts: this.tokenAttempts,
            current_token_fp: tokenFingerprint(this.currentToken),
            elapsed_transport_ms: this.transportActiveMs,
            elapsed_ms: this.now() - this.startedAt,
        };
    }

    /**
     * BLOCKER E: build a fail-loud FetchError for a non-COMPLETE terminal, carrying
     * machine-readable structured terminal metadata (`err.meta`) from snapshot().
     * The adapter throws this; harvest-single propagates meta into terminal_meta.
     */
    terminalError(terminal, uniqueIds) {
        const snap = this.snapshot(terminal);
        const meta = {
            terminal, acceptedPages: snap.accepted_pages, totalRetries: snap.total_retries,
            uniqueIds, elapsedTransportMs: snap.elapsed_transport_ms,
            tokenFingerprint: snap.current_token_fp,
        };
        return new FetchError('arxiv', TERMINAL_KIND[terminal] || 'fetch',
            `${terminal}: ${uniqueIds} accepted before failure`, meta);
    }
}

// Non-COMPLETE terminal -> FetchError kind (H1 fetch/abort/parse taxonomy; all
// non-COMPLETE fail loud, never a green healthy-partial).
export const TERMINAL_KIND = {
    PAGE_TIMEOUT_EXHAUSTED: 'abort', TOTAL_BUDGET_EXHAUSTED: 'abort',
    FETCH_ERROR: 'fetch', OAI_ERROR: 'fetch', BAD_RESUMPTION_TOKEN: 'fetch',
    NO_PROGRESS: 'fetch', TOKEN_CYCLE: 'fetch', RATE_LIMIT_EXHAUSTED: 'fetch',
    MALFORMED_XML: 'parse',
};

export default ArxivRecoveryState;
