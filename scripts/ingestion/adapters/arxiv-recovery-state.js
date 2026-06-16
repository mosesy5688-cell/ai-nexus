/**
 * ArXiv OAI Recovery State Machine (WO-3-A1 PR-A1: Transport Recovery Core)
 *
 * SINGLE-ARBITER transport budget for the OAI-PMH ListRecords pagination loop.
 * This module is the ONE owner of all retry/budget/progress state. The adapter,
 * the OAI client, and the outer pagination loop all consult THIS state object --
 * there are no independent retry budgets anywhere else.
 *
 * Responsibility split (CES <=250 line anti-monolith):
 *   - arxiv-oai-client.js  : transport (fetch + timeout) + OAI XML parse/error.
 *   - arxiv-recovery-state.js (this) : retry / budget / progress state machine.
 *   - arxiv-adapter.js     : drives the loop, maps records, normalize() (unchanged).
 *
 * TOKEN LIFECYCLE: same-run only. The resumptionToken is NEVER persisted for a
 * cross-day resume; no datestamp/id cursor is created. Logs use a short hash of
 * the token, never the full token as a governance id.
 *
 * @module ingestion/adapters/arxiv-recovery-state
 */

// First page (cold ListRecords, no resumptionToken) absorbs the OAI slow-tail
// spike (observed 65-90s). Deep (resumptionToken) pages get the SAME raised 120s
// budget on every attempt (D-65 s3 / s III.1: resumption PAGE_TIMEOUT_MS 60000 ->
// 120000) so a 65-90s page clears on its FIRST attempt, paired with same-token
// retry for transient failures -- not a standalone bump (retry is mandatory).
export const FIRST_PAGE_TIMEOUT_MS = 120000;
export const PAGE_TIMEOUT_MS = 120000;
export const PAGE_RETRY_TIMEOUT_MS = 120000;

// Bounded same-token retry: max 3 total requests per token (initial + 2 retries).
export const MAX_REQUESTS_PER_TOKEN = 3;
// Bounded backoff between same-token retries, COUNTED against the single budget.
// Injectable/zeroable via the clock+sleep seam so tests never really sleep.
export const TOKEN_BACKOFF_MS = [15000, 30000];

// Hard ceiling on cumulative transport wall-clock (request budgets + backoff
// sleeps). A persistently-dead endpoint can never hang the job indefinitely.
export const TOTAL_BUDGET_MS = 600000;

// NO_PROGRESS: bounded window of accepted pages over which zero unique new IDs
// is treated as a stall (terminal). Distinct from TOKEN_CYCLE (token identity).
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
 *
 * @param {Object} [deps] - Injectable seams (default to real wall clock).
 * @param {() => number} [deps.now] - Monotonic-ish clock (Date.now in prod).
 * @param {(ms:number)=>Promise<void>} [deps.sleep] - Backoff sleep (zeroable in tests).
 */
export class ArxivRecoveryState {
    constructor(deps = {}) {
        this.now = deps.now || (() => Date.now());
        this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.startedAt = this.now();
        this.deadline = this.startedAt + TOTAL_BUDGET_MS;
        // Current token + its attempt counter (initial + retries on the SAME token).
        this.currentToken = null;
        this.tokenAttempts = 0;
        // Progress accounting.
        this.acceptedPages = 0;
        this.acceptedUniqueIds = 0;
        this.lastProgressAt = this.startedAt;
        // NO_PROGRESS sliding window: unique-id deltas across recent accepted pages.
        this.progressWindow = [];
        // TOKEN_CYCLE detection: ordered history of accepted next-tokens.
        this.tokenHistory = [];
    }

    /** True once the cumulative transport wall-clock budget is exhausted. */
    budgetExhausted() {
        return this.now() >= this.deadline;
    }

    /** Whether a backoff of `ms` would fit inside the remaining budget. */
    backoffFitsBudget(ms) {
        return this.now() + ms <= this.deadline;
    }

    /**
     * Begin (or continue) work on a token. Called before each request. Resets the
     * attempt counter when the token CHANGES (a genuinely new page), so the
     * per-token budget is scoped to the exact same token only.
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
     * The timeout budget for the CURRENT request of the current token.
     * First page and every deep (resumptionToken) page attempt get the raised
     * 120s budget (D-65: resumption timeout 60000 -> 120000), so a 65-90s page
     * clears on its first attempt; same-token retry handles transient failures.
     */
    requestTimeoutMs() {
        if (this.currentToken === null) return FIRST_PAGE_TIMEOUT_MS;
        return this.tokenAttempts > 1 ? PAGE_RETRY_TIMEOUT_MS : PAGE_TIMEOUT_MS;
    }

    /** Sleep the next bounded backoff for this token, COUNTED against the budget. */
    async backoffForRetry() {
        const idx = Math.min(this.tokenAttempts - 1, TOKEN_BACKOFF_MS.length - 1);
        const ms = TOKEN_BACKOFF_MS[idx];
        if (!this.backoffFitsBudget(ms)) return false;
        await this.sleep(ms);
        return true;
    }

    /**
     * Record a fully-validated, accepted page. Advances progress accounting and
     * returns a terminal-state hint when the page cannot be safely accepted:
     *   - 'TOKEN_CYCLE' : nextToken repeats / forms an A->B->A cycle.
     *   - 'NO_PROGRESS' : zero unique new IDs across the bounded window.
     *   - null          : page accepted, advance to nextToken.
     *
     * @param {number} newUniqueIds - count of unique IDs newly accepted this page.
     * @param {string|null} nextToken - the next resumptionToken (null = clean end).
     */
    acceptPage(newUniqueIds, nextToken) {
        this.acceptedPages++;
        this.acceptedUniqueIds += newUniqueIds;
        if (newUniqueIds > 0) this.lastProgressAt = this.now();

        this.progressWindow.push(newUniqueIds);
        if (this.progressWindow.length > NO_PROGRESS_WINDOW) this.progressWindow.shift();
        const windowFull = this.progressWindow.length >= NO_PROGRESS_WINDOW;
        const windowDry = this.progressWindow.every((d) => d === 0);
        if (windowFull && windowDry) return 'NO_PROGRESS';

        if (nextToken) {
            // Exact repeat of the token we just used, or an A->B->A oscillation.
            const seenIdx = this.tokenHistory.indexOf(nextToken);
            if (nextToken === this.currentToken || seenIdx !== -1) return 'TOKEN_CYCLE';
            this.tokenHistory.push(nextToken);
        }
        return null;
    }

    /** Truthful partial-yield metadata for a terminal (never healthy-partial). */
    snapshot(terminal) {
        return {
            terminal,
            accepted_pages: this.acceptedPages,
            accepted_unique_ids: this.acceptedUniqueIds,
            token_attempts: this.tokenAttempts,
            current_token_fp: tokenFingerprint(this.currentToken),
            elapsed_ms: this.now() - this.startedAt,
        };
    }
}

export default ArxivRecoveryState;
