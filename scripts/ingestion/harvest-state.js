/**
 * Per-Source Terminal State Sidecar (PR-H2c, observation layer).
 *
 * WHY: H2a made a known-large source's zero/near-zero FAIL LOUD via the floor
 * gate, but the harvest's per-source outcome is still invisible to the merge
 * job — there is no machine-readable record of WHY a source ended where it did
 * (success vs valid-zero vs rate-limited vs floor-violation vs hard-failed).
 * The aggregator (harvest-health.js) needs that record to render an honest
 * SOURCE HEALTH table and to detect ANTI-LYING "absence = failure".
 *
 * This is an OBSERVATION layer. It adds NO new publication gate beyond
 * defense-in-depth: writing/printing a sidecar never changes harvest exit code.
 * H2a (floor gate / arXiv spin bound / SS de-mask) stays bit-identical.
 *
 * Contract: emitTerminalState() writes data/state/harvest-state-<source>.json
 * (<1KB) AND prints one fixed machine line `HARVEST_STATE <json>`. Any sidecar
 * write failure is swallowed to a ::warning so the harvest exit code is never
 * altered by a forensics side-effect (REINFORCEMENT 1).
 */

import fs from 'node:fs';
import path from 'node:path';

const STATE_DIR = path.join('data', 'state');

/**
 * Terminal status enum (Founder-ratified). H2b-reserved values are defined
 * here once so producers and the aggregator agree on the vocabulary even
 * though some are only ever assigned by inference (step_killed) or by H2b.
 *
 *   success          completed, yield >= floor (or no floor)
 *   valid_zero       completed cleanly, genuinely zero records (HTTP 200, no new data)
 *   partial          partial-by-design (enrich budget / early finish), usable yield
 *   rate_limited     RateLimitExceededError early-finish (CI-throughput tolerance)
 *   retry_exhausted  retries exhausted (H2b-reserved; producers do not self-assign yet)
 *   timeout          request_timeout (FetchError kind=abort) OR step_killed (aggregator-only)
 *   floor_violation  known-large floor gate fired (H2a)
 *   failed           hard fetch/parse error (FetchError) or outer catch
 *   missing          NO sidecar for an EXPECTED source (aggregator-assigned ONLY)
 */
export const STATUS = Object.freeze({
    SUCCESS: 'success',
    VALID_ZERO: 'valid_zero',
    PARTIAL: 'partial',
    RATE_LIMITED: 'rate_limited',
    RETRY_EXHAUSTED: 'retry_exhausted',
    TIMEOUT: 'timeout',
    FLOOR_VIOLATION: 'floor_violation',
    FAILED: 'failed',
    MISSING: 'missing',
});

/** partial_reason enum. */
export const PARTIAL_REASON = Object.freeze({
    ENRICH_BUDGET: 'enrich_budget',
    RATE_LIMIT_EARLY_FINISH: 'rate_limit_early_finish',
    UNKNOWN: 'unknown',
});

/**
 * timeout sub-classification. request_timeout is self-reportable (FetchError
 * kind=abort). step_killed is aggregator-inferred ONLY — adapters NEVER
 * self-report it; it comes from step outcome + missing sidecar.
 */
export const TIMEOUT_KIND = Object.freeze({
    REQUEST_TIMEOUT: 'request_timeout',
    STEP_KILLED: 'step_killed',
});

/**
 * Derive the terminal SUCCESS-path status + partial_reason for a completed
 * harvest (no hard error, floor gate passed). Precedence:
 *   partial-by-design (adapter terminalMeta.budgetCapped) -> partial/enrich_budget
 *   rate-limit early-finish above floor                   -> partial/rate_limit_early_finish
 *   genuinely-zero clean completion                       -> valid_zero
 *   otherwise                                             -> success
 * @param {Object} p { total, rateLimited, terminalMeta }
 * @returns {{status:string, partial_reason?:string}}
 */
export function deriveSuccessStatus({ total, rateLimited, terminalMeta }) {
    if (terminalMeta && terminalMeta.budgetCapped) {
        return { status: STATUS.PARTIAL, partial_reason: PARTIAL_REASON.ENRICH_BUDGET };
    }
    if (rateLimited) {
        return { status: STATUS.PARTIAL, partial_reason: PARTIAL_REASON.RATE_LIMIT_EARLY_FINISH };
    }
    if (total === 0) return { status: STATUS.VALID_ZERO };
    return { status: STATUS.SUCCESS };
}

/**
 * Build a normalized sidecar object from a loose state input. Defaults keep the
 * record honest (errors[] always an array, booleans default false).
 * @param {Object} state
 * @returns {Object} normalized sidecar
 */
export function buildSidecar(state = {}) {
    const sidecar = {
        schema_version: 1,
        source: String(state.source || 'unknown'),
        status: state.status || STATUS.SUCCESS,
        yield: Number.isFinite(state.yield) ? state.yield : 0,
        duration_ms: Number.isFinite(state.duration_ms) ? state.duration_ms : 0,
        errors: Array.isArray(state.errors) ? state.errors.slice(0, 10) : [],
        had_adapter_error: Boolean(state.had_adapter_error),
        floor_violated: Boolean(state.floor_violated),
    };
    if (state.pages !== undefined) sidecar.pages = state.pages;
    if (state.retry_count !== undefined) sidecar.retry_count = state.retry_count;
    if (state.partial_reason !== undefined) sidecar.partial_reason = state.partial_reason;
    if (state.terminal_meta !== undefined && state.terminal_meta !== null) {
        sidecar.terminal_meta = state.terminal_meta;
    }
    return sidecar;
}

/**
 * Emit a terminal-state sidecar for one harvested source.
 *
 * ALWAYS prints the fixed machine line `HARVEST_STATE <json>` to stdout (this
 * cannot fail the harvest). ATTEMPTS to also write the <1KB sidecar file; a
 * write failure degrades to a ::warning and is swallowed so the harvest exit
 * code is never altered by this forensics side-effect (REINFORCEMENT 1).
 *
 * @param {Object} state - loose terminal-state input (see buildSidecar fields)
 * @returns {Object} the normalized sidecar that was emitted
 */
export function emitTerminalState(state) {
    const sidecar = buildSidecar(state);
    const line = JSON.stringify(sidecar);

    // Fixed machine line — primary, runner-captured signal. Never throws.
    console.log(`HARVEST_STATE ${line}`);

    // Best-effort sidecar file. NEVER alter exit code on failure.
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        const safe = sidecar.source.replace(/[^a-z0-9_-]+/gi, '_');
        const file = path.join(STATE_DIR, `harvest-state-${safe}.json`);
        fs.writeFileSync(file, line);
    } catch (e) {
        // ::warning only — a forensics write failure must not redden a harvest.
        console.warn(`::warning::harvest-state sidecar write failed for ${sidecar.source}: ${e.message}`);
    }

    return sidecar;
}

export { STATE_DIR };
