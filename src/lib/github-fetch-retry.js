/**
 * Unified fetch wrapper for GitHub API (REST + GraphQL) with robust retry.
 *
 * V27.23 — extracted to share retry/backoff between search GraphQL calls
 * and standalone README fetches. Single source of truth keeps behavior
 * consistent and avoids drift like the slug-helper duplication caught earlier.
 *
 * Handles:
 *  - 5xx server errors → exponential backoff retry up to maxRetries
 *  - 429 / 403 secondary rate limit → respect Retry-After header
 *  - Primary rate limit → respect x-ratelimit-reset (does not consume retry budget)
 *  - Per-request soft timeout via AbortSignal
 *
 * GitHub doesn't document 502 as a rate-limit signal; observed behavior is
 * "query timed out at the backend" (10s GraphQL hard cap). Retrying the
 * same heavy query keeps hitting it; the real fix is to keep queries small.
 * This helper still gives oversized queries a fair chance under transient
 * load, but is not a substitute for query shape.
 */

const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_BASE_BACKOFF_MS = 10_000;
const DEFAULT_CAP_BACKOFF_MS = 240_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_PREFIX = '   ';

function jitter(ms, maxJitterMs = 5000) {
    return ms + Math.floor(Math.random() * maxJitterMs);
}

function computeBackoff(attempt, base, cap) {
    return Math.min(base * Math.pow(2, attempt - 1), cap);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch with retry. Returns { ok, status, response, error }.
 * Caller is responsible for reading the response body.
 */
export async function githubFetch(url, options = {}) {
    const {
        maxRetries = DEFAULT_MAX_RETRIES,
        baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
        capBackoffMs = DEFAULT_CAP_BACKOFF_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        logPrefix = DEFAULT_LOG_PREFIX,
        ...fetchOptions
    } = options;

    let attempt = 0;
    while (attempt <= maxRetries) {
        let response;
        try {
            const signal = AbortSignal.timeout(timeoutMs);
            response = await fetch(url, { ...fetchOptions, signal });
        } catch (err) {
            if (attempt >= maxRetries) {
                return { ok: false, status: 0, error: err.message || 'fetch failed', response: null };
            }
            attempt++;
            const wait = jitter(computeBackoff(attempt, baseBackoffMs, capBackoffMs));
            console.warn(`${logPrefix}⚠️ ${err.message || 'fetch error'}, retry ${attempt}/${maxRetries} in ${(wait / 1000).toFixed(1)}s...`);
            await sleep(wait);
            continue;
        }

        if (response.ok) {
            return { ok: true, status: response.status, response, error: null };
        }

        const status = response.status;
        const retryAfter = response.headers.get('retry-after');
        const rlRemaining = response.headers.get('x-ratelimit-remaining');
        const rlReset = response.headers.get('x-ratelimit-reset');

        // Primary rate limit (does NOT consume retry budget — wait it out)
        if (status === 403 && rlRemaining === '0' && rlReset) {
            const resetMs = (parseInt(rlReset, 10) * 1000) - Date.now();
            if (resetMs > 0 && resetMs < 3600_000) {
                console.warn(`${logPrefix}⚠️ Primary rate limit, waiting ${(resetMs / 1000).toFixed(0)}s for reset...`);
                await sleep(resetMs + 1000);
                continue;
            }
        }

        // Secondary rate limit / 429 with Retry-After
        if ((status === 429 || status === 403) && retryAfter) {
            const waitMs = parseInt(retryAfter, 10) * 1000;
            if (waitMs > 0 && waitMs < 600_000) {
                console.warn(`${logPrefix}⚠️ GitHub ${status} (Retry-After: ${retryAfter}s)...`);
                await sleep(waitMs + 1000);
                continue;
            }
        }

        // 5xx server errors → retry with backoff
        if (status >= 500 && status < 600) {
            if (attempt >= maxRetries) {
                return { ok: false, status, error: `${status} after ${maxRetries} retries`, response };
            }
            attempt++;
            let wait;
            if (retryAfter) {
                wait = parseInt(retryAfter, 10) * 1000 + jitter(1000, 1000);
            } else {
                wait = jitter(computeBackoff(attempt, baseBackoffMs, capBackoffMs));
            }
            console.warn(`${logPrefix}⚠️ GitHub ${status}, retry ${attempt}/${maxRetries} in ${(wait / 1000).toFixed(1)}s...`);
            await sleep(wait);
            continue;
        }

        // Non-retryable client error (404, 422, etc.)
        return { ok: false, status, error: `${status}`, response };
    }

    return { ok: false, status: 0, error: 'retry budget exhausted', response: null };
}
