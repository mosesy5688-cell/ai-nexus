/**
 * ArXiv OAI TERMINAL METADATA + terminal taxonomy.
 *
 * Pure assembly of the machine-readable evidence a non-COMPLETE terminal carries.
 * It holds NO state and makes NO retry decision: the single arbiter
 * (arxiv-recovery-state.js) is the only caller and passes itself in. Extracted so
 * the arbiter stays under the CES 250-line ceiling, matching the split this
 * adapter family already uses (parser / oai-client / recovery-state / envelope).
 *
 * HONESTY CONTRACT: every field describes a FAILURE. Nothing here asserts, or can
 * be read as asserting, that a failed or partial run established Academic
 * authority, and the raw continuation token never appears -- only its
 * non-reversible fingerprint.
 *
 * @module ingestion/adapters/arxiv-terminal-meta
 */
import { FetchError } from './base-adapter.js';
import { envelopeMetadata, ADMISSION_DEADLINE_MS } from './arxiv-recovery-envelope.js';
import { tokenFingerprint } from './arxiv-run-admission.js';

// Non-COMPLETE terminal -> FetchError kind (H1 fetch/abort/parse taxonomy; all
// non-COMPLETE fail loud, never a green healthy-partial).
export const TERMINAL_KIND = {
    PAGE_TIMEOUT_EXHAUSTED: 'abort', TOTAL_BUDGET_EXHAUSTED: 'abort',
    FETCH_ERROR: 'fetch', OAI_ERROR: 'fetch', BAD_RESUMPTION_TOKEN: 'fetch',
    NO_PROGRESS: 'fetch', TOKEN_CYCLE: 'fetch', RATE_LIMIT_EXHAUSTED: 'fetch',
    MALFORMED_XML: 'parse',
    // Founder-ruled runtime stops. Deliberately NOT 'abort': harvest-single treats
    // kind==='abort' as a REQUEST timeout and stamps timeout_kind=request_timeout.
    // Neither of these is a request timeout -- one is a run-policy quota stop, the
    // other a run wall-clock stop -- so they map to 'fetch' and the sidecar records
    // status=failed with no false timeout_kind. Both still fail loud, non-zero.
    THIRD_ATTEMPT_QUOTA_EXHAUSTED: 'fetch', RUN_WALL_CLOCK_BUDGET_EXHAUSTED: 'fetch',
};

/**
 * Truthful partial-yield metadata for a terminal (never healthy-partial), plus the
 * CONFIGURED slow-tail envelope and the OBSERVED slow-tail evidence.
 */
export function buildSnapshot(state, terminal) {
    return {
        terminal, accepted_pages: state.acceptedPages,
        accepted_unique_ids: state.acceptedUniqueIds, total_retries: state.totalRetries,
        token_attempts: state.tokenAttempts, current_token_fp: tokenFingerprint(state.currentToken),
        elapsed_transport_ms: state.transportActiveMs, elapsed_ms: state.now() - state.startedAt,
        slow_tail_recovery_count: state.slowTailRecoveries, last_error_kind: state.lastErrorKind,
        last_http_status: state.lastHttpStatus, ...admissionMetadata(state), ...envelopeMetadata(),
    };
}

/**
 * Admission evidence. For a wall-clock stop these numbers ARE the justification, so
 * they are emitted on every terminal (null when no admission decision was ever
 * taken, never a fabricated zero). `last_retry_after_raw_ms` surfaces the raw
 * server header the cap overrode -- retained for diagnostics and actually readable.
 */
export function admissionMetadata(state) {
    return {
        run_elapsed_ms: state.runElapsedMs ?? null,
        projected_completion_ms: state.projectedCompletionMs ?? null,
        admission_deadline_ms: ADMISSION_DEADLINE_MS,
        third_attempt_tokens_used: state.runScope?.thirdAttemptTokens?.size ?? null,
        last_retry_after_raw_ms: state.lastRetryAfterRawMs ?? null,
    };
}

/**
 * BLOCKER E: build the fail-loud FetchError for a non-COMPLETE terminal, carrying
 * structured terminal metadata (`err.meta`). The adapter throws it; harvest-single
 * propagates meta into the terminal_meta sidecar.
 *
 * The camelCase keys are the FROZEN sidecar contract and are left untouched; the
 * 2026-07-25 slow-tail fields keep their Founder-specified snake_case names.
 */
export function buildTerminalError(state, terminal, uniqueIds) {
    const snap = buildSnapshot(state, terminal);
    const meta = {
        terminal, acceptedPages: snap.accepted_pages, totalRetries: snap.total_retries,
        uniqueIds, elapsedTransportMs: snap.elapsed_transport_ms,
        tokenFingerprint: snap.current_token_fp,
        slow_tail_recovery_count: snap.slow_tail_recovery_count, last_error_kind: snap.last_error_kind,
        last_http_status: snap.last_http_status, ...admissionMetadata(state), ...envelopeMetadata(),
    };
    return new FetchError('arxiv', TERMINAL_KIND[terminal] || 'fetch',
        `${terminal}: ${uniqueIds} accepted before failure`, meta);
}

export default { TERMINAL_KIND, buildSnapshot, buildTerminalError };
