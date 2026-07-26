/**
 * Semantic Scholar BULK-SEARCH PAGE TRANSPORT -- url construction, body shape
 * classification, and ONE page fetched through the bounded recovery ladder.
 *
 * Split out of s2-bulk-search.js purely to keep both files under the CES 250-line
 * ceiling, matching the decomposition the arXiv family already uses (adapter /
 * oai-client / recovery-state / envelope). It owns transport only: it holds no
 * retry state (the single arbiter S2RetryState does) and no notion of topics,
 * yield or completeness (the walk in s2-bulk-search.js does).
 *
 * THE DEFECT THIS REPLACES (Factory 1/4 run 30189935455, natural cron). The old
 * in-line loop handled a throw from fetchWithTimeout() with `console.error` +
 * `break` (semanticscholar-adapter.js:79-82 at 919d07f9) and an HTTP 500 reaching
 * `!response.ok` with `console.warn` + `break` (:88-89), then returned an empty
 * array without throwing. harvest-single.js therefore observed a clean zero-yield
 * with `had_adapter_error: false` and classified it `floor_violation: 0 < 300` --
 * a misclassification manufactured by the swallow.
 *
 * THE CONTRACT NOW. fetchBulkPage() has exactly ONE non-failure exit: a page whose
 * body is a well-formed bulk-search envelope. Everything else -- transport throw,
 * timeout, non-2xx, malformed body, or an exhausted bounded ladder -- leaves by
 * `throw`, never by `return`. There is no code path from a failed request to a
 * returned array, so the clean-yield floor classification is STRUCTURALLY
 * unreachable after an adapter error rather than merely overridden.
 *
 * PRESERVED ON PURPOSE:
 *   - BaseAdapter.handleRateLimit() remains the SOLE owner of 403/429/503,
 *     including its RateLimitExceededError circuit breaker, which stays a NON-hard
 *     error (base-adapter.js:34-36 CI-throughput tolerance).
 *   - BaseAdapter.fetchWithTimeout() remains the sole owner of the abort window.
 *   - A genuinely empty page (HTTP 200, well-formed, zero records) still ends the
 *     walk cleanly and still resolves to a success -- exactly as before.
 *
 * NO PROVIDER CLAIM. Nothing here treats the observed HTTP 500 as a proven
 * temporary provider outage. The ladder is a bounded tolerance whose exhaustion
 * fails loud, and it is correct whether or not the provider has recovered.
 *
 * @module ingestion/adapters/s2-bulk-page
 */
import {
    FAILURE_KIND, TERMINAL, classifyThrown, isRetryableStatus,
} from './s2-retry-envelope.js';

export const S2_API_BASE = 'https://api.semanticscholar.org/graph/v1';
export const BULK_BATCH_SIZE = 1000;
export const PAGE_PACING_MS = 5000;
export const DEFAULT_TOPICS = Object.freeze([
    'machine learning', 'artificial intelligence', 'nlp', 'computer vision',
]);
export const BULK_FIELDS = [
    'paperId', 'externalIds', 'title', 'abstract', 'authors', 'venue', 'year',
    'referenceCount', 'citationCount', 'influentialCitationCount', 'openAccessPdf',
    'fieldsOfStudy', 's2FieldsOfStudy', 'publicationTypes', 'publicationDate',
].join(',');

/** The bulk-search page url. A retry MUST reuse this exact string. */
export function buildBulkSearchUrl({ topic, token, batchSize = BULK_BATCH_SIZE }) {
    let url = `${S2_API_BASE}/paper/search/bulk?query=${encodeURIComponent(topic)}`
        + `&limit=${batchSize}&fields=${BULK_FIELDS}`;
    if (token) url += `&token=${token}`;
    return url;
}

/**
 * Classify a parsed 200 body WITHOUT guessing. 'ok' = a records array is present;
 * 'empty' = the documented zero-result shape (`total: 0`, no `data` key), which is
 * a LEGITIMATE clean end; 'malformed' = anything else, including `data` present
 * but not an array. The empty case is kept narrow on purpose: a body that is
 * merely missing its records array is a failure, not a quiet zero.
 */
export function classifyBulkBody(body) {
    if (!body || typeof body !== 'object') return 'malformed';
    if (Array.isArray(body.data)) return body.data.length === 0 ? 'empty' : 'ok';
    if (body.data === undefined && body.total === 0) return 'empty';
    return 'malformed';
}

/**
 * ONE page, with the bounded same-url recovery ladder. Returns the parsed body on
 * success; every failure path throws the arbiter's FetchError. It NEVER returns a
 * sentinel and NEVER returns empty on failure.
 *
 * @param {Object} args
 * @param {Object} args.adapter - the adapter (fetchWithTimeout/getHeaders/handleRateLimit).
 * @param {string} args.url - the exact page url; a retry repeats it verbatim.
 * @param {Object} args.state - the S2RetryState arbiter.
 * @param {{attempt:number}} args.rate - handleRateLimit's own escalation counter.
 */
export async function fetchBulkPage({ adapter, url, state, rate }) {
    for (;;) {
        state.beginRequest(url);
        let response;
        try {
            response = await adapter.fetchWithTimeout(url, { headers: adapter.getHeaders() });
        } catch (error) {
            // Timeout (AbortError from fetchWithTimeout) and network failure are
            // recorded as DISTINCT kinds -- never collapsed into one "fetch error".
            state.recordAttemptFailure(classifyThrown(error), null);
            const terminal = await state.requestRetry();
            if (terminal) throw state.terminalError(terminal);
            continue; // retry the EXACT same url; never restart, never skip.
        }

        if (!response.ok) {
            // 403/429/503 -> the existing authority, unchanged. Its breaker throws
            // RateLimitExceededError, which propagates as a NON-hard error.
            if (await adapter.handleRateLimit(response, rate.attempt++)) continue;
            state.recordAttemptFailure(FAILURE_KIND.HTTP_STATUS, response.status);
            if (!isRetryableStatus(response.status)) {
                // 4xx and every other non-retryable status: repetition cannot make
                // it valid, so fail loud on the first response.
                throw state.terminalError(TERMINAL.NON_RETRYABLE_HTTP);
            }
            const terminal = await state.requestRetry();
            if (terminal) throw state.terminalError(terminal);
            continue; // bounded 5xx recovery, same query, same token.
        }

        let body;
        try {
            body = await response.json();
        } catch (error) {
            state.recordAttemptFailure(FAILURE_KIND.PARSE, response.status);
            throw state.terminalError(TERMINAL.NON_RETRYABLE_PARSE);
        }
        const shape = classifyBulkBody(body);
        if (shape === 'malformed') {
            state.recordAttemptFailure(FAILURE_KIND.PARSE, response.status);
            throw state.terminalError(TERMINAL.NON_RETRYABLE_PARSE);
        }
        rate.attempt = 0; // page fetched OK -> reset the 429 escalation counter.
        return { body, empty: shape === 'empty' };
    }
}

export default { fetchBulkPage, buildBulkSearchUrl, classifyBulkBody };
