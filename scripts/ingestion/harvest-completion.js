/**
 * SOURCE-COMPLETENESS SEAM (Founder ruling, 2026-07-26 Factory 1/4 S2 incident).
 *
 * THE HOLE THIS CLOSES. `terminalMeta` + `status: partial` already existed, and
 * harvest-state.js documents them as an OBSERVATION layer that "never changes
 * harvest exit code". For a REQUIRED source that is precisely the defect: a run
 * that abandoned planned work could record a partial and still exit 0, so the
 * NDJSON bridge ran, the (non-`always()`) R2 source-authority step ran, and an
 * incomplete harvest was published as the authoritative record of that source.
 *
 * Marking a required source incomplete WITHOUT exiting non-zero is not a repair.
 * The ruled outcome is all four together:
 *     mark incomplete  AND  exit non-zero  AND  block bridge  AND  block authority
 *
 * WHY THE FLOOR GATE CANNOT DO THIS JOB. The floor is ~10% of a source's healthy
 * minimum -- an ANTI-ZERO control, not a completeness gate. Semantic Scholar with
 * 3 of 4 topics done yields ~2,250 rows against a floor of 300, so the floor
 * passes and the run looks healthy. Completeness is a separate question from
 * "did we get a non-trivial number of rows", and it needs its own gate.
 *
 * SOURCE-AGNOSTIC BY CONSTRUCTION. Nothing here names a source, and the gate has
 * no per-source branch: it consumes a CLAIM that an adapter publishes on itself
 * (`adapter.completion`). An adapter that publishes nothing is completely
 * unaffected -- absence is NOT treated as incompleteness, because that would
 * silently redden every un-migrated source. Lane 1 instruments Semantic Scholar
 * only; migrating the other required adapters onto this seam is Lane 3.
 *
 * FIELD NAMES ARE THE FOUNDER-SPECIFIED ONES (`planned_topics`, `completed_topics`,
 * `limit_satisfied`, `completion_status`, `termination_reason`, `failed_topic`,
 * `last_http_status`). A "topic" is generic here: it means one unit of the
 * adapter's planned pagination work, and `unit_label` records what that unit
 * actually is for the publishing adapter (topic / day / tag / page).
 *
 * @module ingestion/harvest-completion
 */
import { STATUS } from './harvest-state.js';

export const COMPLETION_STATUS = Object.freeze({
    COMPLETE: 'complete',
    INCOMPLETE: 'incomplete',
});

/**
 * WHY a source stopped. The first two are the ONLY complete endings; every other
 * value describes abandoned planned work and is therefore incomplete.
 */
export const TERMINATION_REASON = Object.freeze({
    ALL_UNITS_EXHAUSTED: 'all_planned_units_exhausted',
    LIMIT_SATISFIED: 'configured_limit_satisfied',
    RATE_LIMIT_BREAKER: 'rate_limit_breaker',
    RETRY_BUDGET_EXHAUSTED: 'retry_budget_exhausted',
    ATTEMPTS_EXHAUSTED: 'attempts_exhausted',
    ADAPTER_ERROR: 'adapter_error',
});

/**
 * THE COMPLETENESS PREDICATE (binding definition). A source is complete ONLY if
 *     limit_satisfied  OR  every planned unit was cleanly exhausted.
 * Anything else -- an abandoned unit, a breaker trip, a budget stop, an early stop
 * after a request exception, a stop after a non-2xx, a parse failure, or a unit
 * silently skipped -- is INCOMPLETE.
 *
 * Fails CLOSED: non-numeric or negative counts, or a planned count of zero with no
 * satisfied limit, are incomplete rather than vacuously complete.
 */
export function isComplete({ limit_satisfied: limitSatisfied, planned_topics: planned, completed_topics: completed }) {
    if (limitSatisfied === true) return true;
    if (!Number.isFinite(planned) || !Number.isFinite(completed)) return false;
    if (planned <= 0) return false;
    return completed >= planned;
}

/**
 * Build the completion record an adapter publishes as `adapter.completion`. The
 * record is DERIVED: `completion_status` is computed from the counts by
 * isComplete(), never passed in, so an adapter cannot declare itself complete
 * while its own numbers say otherwise.
 *
 * @param {Object} p
 * @param {number} p.plannedTopics    - units of planned work for this invocation.
 * @param {number} p.completedTopics  - units cleanly exhausted.
 * @param {boolean} p.limitSatisfied  - the configured entity limit was reached.
 * @param {string} p.terminationReason - a TERMINATION_REASON value.
 * @param {string|null} [p.failedTopic]     - the unit in flight when it stopped.
 * @param {number|null} [p.lastHttpStatus]  - ONLY a real status line; never synthesized.
 * @param {string} [p.unitLabel='topic']    - what one unit IS for this adapter.
 */
export function buildCompletionRecord({
    plannedTopics, completedTopics, limitSatisfied, terminationReason,
    failedTopic = null, lastHttpStatus = null, unitLabel = 'topic',
}) {
    const record = {
        unit_label: unitLabel,
        planned_topics: plannedTopics,
        completed_topics: completedTopics,
        limit_satisfied: limitSatisfied === true,
        termination_reason: terminationReason,
        failed_topic: failedTopic,
        last_http_status: Number.isInteger(lastHttpStatus) ? lastHttpStatus : null,
    };
    record.completion_status = isComplete(record)
        ? COMPLETION_STATUS.COMPLETE
        : COMPLETION_STATUS.INCOMPLETE;
    return record;
}

/**
 * THE GATE. Must be evaluated on the success path BEFORE the green "Complete"
 * log, BEFORE the NDJSON bridge and BEFORE the normal success return, so a
 * blocked run can neither print a green line, nor produce bridge shards, nor
 * return without `error` (the exit gate reads `result.error`).
 *
 * @param {Object|null} record - `adapter.completion`, or null when unpublished.
 * @returns {{blocked:boolean, record:Object|null, error?:string}}
 */
export function evaluateCompletionGate(record) {
    if (!record) return { blocked: false, record: null };
    if (record.completion_status === COMPLETION_STATUS.COMPLETE) {
        return { blocked: false, record };
    }
    return { blocked: true, record, error: completionErrorMessage(record) };
}

/** The `result.error` text for a blocked run. Names the numbers, claims nothing else. */
export function completionErrorMessage(record) {
    const unit = record.unit_label || 'topic';
    return `source incomplete: ${record.completed_topics}/${record.planned_topics} ${unit}s completed`
        + `, limit_satisfied=${record.limit_satisfied}`
        + `, termination_reason=${record.termination_reason}`
        + (record.failed_topic ? `, ${unit}="${record.failed_topic}"` : '')
        + (record.last_http_status === null ? '' : `, http=${record.last_http_status}`)
        + ' -- required-source authority WITHHELD';
}

/**
 * Terminal status for a blocked-but-not-hard-errored run. NEVER `success`.
 * A rate-limit early finish keeps its own existing vocabulary value
 * (`rate_limited`); every other non-hard incomplete stop is `partial`. The
 * classification of RateLimitExceededError as a NON-hard adapter error is
 * unchanged -- what changes is that a non-hard error no longer buys authority
 * eligibility. NON-HARD CLASSIFICATION != AUTHORITY ELIGIBILITY.
 */
export function incompleteStatus({ rateLimited }) {
    return rateLimited ? STATUS.RATE_LIMITED : STATUS.PARTIAL;
}

export default {
    COMPLETION_STATUS, TERMINATION_REASON, isComplete, buildCompletionRecord,
    evaluateCompletionGate, completionErrorMessage, incompleteStatus,
};
