/**
 * Semantic Scholar BULK-SEARCH WALK -- the topic/page pagination, page acceptance
 * and the SOURCE-COMPLETENESS claim.
 *
 * Transport lives in s2-bulk-page.js; the retry/budget arbiter is S2RetryState.
 * This module owns the walk and, critically, the honest answer to "was this source
 * complete?". Extracted from semanticscholar-adapter.js so the adapter returns
 * under the CES 250-line ceiling instead of relying on its grandfathered
 * whitelist entry.
 *
 * TWO INDEPENDENT WAYS A RUN IS PREVENTED FROM PUBLISHING A PARTIAL:
 *  1. HARD failure (non-2xx / timeout / network / parse / exhausted ladder) leaves
 *     by `throw` as a FetchError -- harvest-single sets result.error, exit 1.
 *  2. NON-HARD early stop (the rate-limit breaker) publishes an INCOMPLETE
 *     completion claim -- harvest-single's completeness gate sets result.error,
 *     exit 1, before the green log, before the bridge, before the success return.
 * The second exists because a breaker trip has no error to throw, yet still
 * abandons planned work. NON-HARD CLASSIFICATION != AUTHORITY ELIGIBILITY.
 *
 * The 5000ms inter-page pacing, the NSFW filter and the per-topic cap are unchanged.
 *
 * @module ingestion/adapters/s2-bulk-search
 */
import { RateLimitExceededError } from './base-adapter.js';
import { TERMINAL } from './s2-retry-envelope.js';
import { buildCompletionRecord, TERMINATION_REASON } from '../harvest-completion.js';
// Re-exported so every existing import of these names from this module keeps working.
export { fetchBulkPage, buildBulkSearchUrl, classifyBulkBody } from './s2-bulk-page.js';
import { fetchBulkPage, buildBulkSearchUrl } from './s2-bulk-page.js';
export {
    S2_API_BASE, BULK_BATCH_SIZE, PAGE_PACING_MS, DEFAULT_TOPICS, BULK_FIELDS,
} from './s2-bulk-page.js';
import { PAGE_PACING_MS } from './s2-bulk-page.js';

/** De-duplicate + NSFW-filter one page's records. Pure w.r.t. the network. */
function collectBatch(adapter, papers, seenIds) {
    const batch = [];
    for (const paper of papers) {
        if (!paper.paperId || seenIds.has(paper.paperId)) continue;
        if (!adapter.isSafeForWork({ title: paper.title, description: paper.abstract })) continue;
        seenIds.add(paper.paperId);
        batch.push(paper);
    }
    return batch;
}

/** FetchError terminal -> the completion record's termination_reason. */
function reasonForTerminal(terminal) {
    if (terminal === TERMINAL.ATTEMPTS_EXHAUSTED) return TERMINATION_REASON.ATTEMPTS_EXHAUSTED;
    if (terminal === TERMINAL.RETRY_BUDGET_EXHAUSTED) return TERMINATION_REASON.RETRY_BUDGET_EXHAUSTED;
    return TERMINATION_REASON.ADAPTER_ERROR;
}

/**
 * Publish the completion CLAIM on the adapter. Called on EVERY exit -- clean end,
 * breaker trip and hard error alike -- so `completion_status` is never merely
 * absent when a run stopped early. Completeness is DERIVED from the counts by
 * harvest-completion.isComplete(); this function cannot declare it.
 */
function publishCompletion(adapter, { topics, seenIds, limit, state, reason, failedTopic }) {
    adapter.completion = buildCompletionRecord({
        unitLabel: 'topic',
        plannedTopics: topics.length,
        completedTopics: state.completedTopics || 0,
        limitSatisfied: seenIds.size >= limit,
        terminationReason: reason,
        failedTopic: failedTopic || null,
        lastHttpStatus: state.lastHttpStatus,
    });
    return adapter.completion;
}

/**
 * The whole bulk ingestion walk. A failed or abandoned topic makes the source
 * INCOMPLETE, and incompleteness is published on the adapter so harvest-single's
 * completeness gate blocks the bridge and withholds R2 source authority. A hard
 * failure additionally throws, so `result.error` is set either way and the step
 * exits non-zero: no partial Semantic Scholar authority can be published as
 * complete, whether or not the stop carried an error.
 */
export async function runBulkSearch({ adapter, state, limit, topics, onBatch, batchSize }) {
    const allPapers = [];
    const seenIds = new Set();
    const perTopic = limit / topics.length;
    state.completedTopics = 0;

    for (const topic of topics) {
        if (seenIds.size >= limit) break;
        state.beginTopic(topic);
        let token = null;
        let topicFetched = 0;
        const rate = { attempt: 0 };
        console.log(`   [S2] Searching: ${topic}...`);

        try {
            while (topicFetched < perTopic) {
                const url = buildBulkSearchUrl({ topic, token, batchSize });
                const page = await fetchBulkPage({ adapter, url, state, rate });
                if (page.empty) break; // legitimate end of this topic's pages.
                const batch = collectBatch(adapter, page.body.data, seenIds);
                topicFetched += batch.length;
                if (onBatch && batch.length > 0) await onBatch(batch);
                else if (!onBatch) allPapers.push(...batch);
                state.acceptPage(batch.length);
                console.log(`   [S2] ${topic}: +${batch.length} (unique: ${seenIds.size})`);
                token = page.body.token;
                if (!token || seenIds.size >= limit) break;
                await adapter.delay(PAGE_PACING_MS);
            }
            state.completedTopics++;
        } catch (error) {
            if (error instanceof RateLimitExceededError) {
                // NON-HARD CLASSIFICATION != AUTHORITY ELIGIBILITY. The error stays a
                // RateLimitExceededError (base-adapter.js:34-36 tolerance preserved:
                // had_adapter_error stays false, it is never converted to a
                // FetchError). What it no longer buys is completeness: the breaker
                // ended planned work early, so the claim says INCOMPLETE, which makes
                // harvest-single set result.error -> exit 1 -> no bridge, no authority.
                console.warn(`   [S2] rate-limit breaker on "${topic}" -- source INCOMPLETE`);
                state.markIncomplete('rate_limit_early_finish');
                adapter.terminalMeta = state.incompleteMeta();
                publishCompletion(adapter, {
                    topics, seenIds, limit, state,
                    reason: TERMINATION_REASON.RATE_LIMIT_BREAKER, failedTopic: topic,
                });
            } else {
                const rec = publishCompletion(adapter, {
                    topics, seenIds, limit, state,
                    reason: reasonForTerminal(error && error.meta && error.meta.terminal),
                    failedTopic: topic,
                });
                // Carry the Founder-required completion fields into the thrown
                // FetchError's meta as well, so they reach terminal_meta on the HARD
                // path too (harvest-single merges err.meta there).
                if (error && error.meta) Object.assign(error.meta, rec);
            }
            // Every hard error (FetchError included) propagates unchanged -- the
            // re-throw the pre-repair adapter already had at :130 is preserved here.
            throw error;
        }
    }

    // Clean end. `limit_satisfied` decides which of the two COMPLETE endings it was:
    // the configured limit was reached, or every planned topic was exhausted.
    const rec = publishCompletion(adapter, {
        topics, seenIds, limit, state,
        reason: seenIds.size >= limit
            ? TERMINATION_REASON.LIMIT_SATISFIED
            : TERMINATION_REASON.ALL_UNITS_EXHAUSTED,
    });
    console.log(`[Semantic Scholar] ${rec.completion_status}: ${seenIds.size} unique papers `
        + `(${rec.completed_topics}/${rec.planned_topics} topics, limit_satisfied=${rec.limit_satisfied})`);
    return onBatch ? [] : allPapers;
}

export default { runBulkSearch };
