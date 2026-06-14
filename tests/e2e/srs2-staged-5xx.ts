/**
 * SRS-2 — STAGED 5xx classification for an UNEXPECTED 5xx on an expected-SUCCESS
 * public API endpoint (Founder-exact; evidence-correction, NOT a network/harness
 * infra change). REPLACES the binary "single-500 -> final PRODUCT_FAILURE" verdict
 * with a STAGED model. SCOPE: this applies ONLY to an unexpected 5xx (esp. 500) on
 * an endpoint we expect to SUCCEED. It does NOT broaden to mask deterministic
 * schema / parity / boundary failures (those stay PRODUCT_FAILURE), and it does NOT
 * touch the inherited 429/503 -> INCONCLUSIVE_TRANSIENT path (a transient is still
 * a transient, never a pass, never a defect).
 *
 * STAGES:
 *   initial : any unexpected 5xx -> SERVER_ERROR_OBSERVED (NEVER counted PASS,
 *             NEVER dismissed as a network transient, NEVER immediately final
 *             PRODUCT_FAILURE). The observed 500 is PRESERVED, never erased.
 *   corroborate (live, optional): on SERVER_ERROR_OBSERVED the harness may issue AT
 *             MOST TWO follow-up probes (same endpoint, same valid input class,
 *             serial, bounded pacing reused from the transport, GET-only / NO
 *             production write). TOTAL automatic attempts = MAXIMUM 3 (original + 2).
 *             Every attempt's status + body metadata is retained.
 *   final   : A/B/D/E below.
 *
 * FINAL RULES:
 *   A. initial 500 AND both follow-ups valid 2xx -> INTERMITTENT_SERVER_ERROR_OBSERVED;
 *      cell = INCONCLUSIVE_INTERMITTENT_5XX; product_failure NOT established; clean=false.
 *   B. 5xx in >= TWO of the THREE attempts -> REPRODUCIBLE_SERVER_FAILURE_CANDIDATE;
 *      a reliability candidate (NOT auto product_failure); flagged for PM/Founder.
 *   D. deterministic 500 every attempt, OR a malformed success payload, OR a schema
 *      violation, OR the endpoint cannot complete its public contract -> PRODUCT_FAILURE.
 *   E. a follow-up probe receives 429/503 -> INCONCLUSIVE_MIXED_TRANSIENT; the
 *      original 500 is NOT adjudicated away; the cell stays OPEN.
 * (Cross-run recurrence "C" is PM-tracked across runs, NOT this harness's job.)
 */
import type { CellState } from './srs2a-helpers';

/** Extended SRS-2 cell-state vocabulary for the staged 5xx model. Superset of the
 *  inherited CellState; the new members are added to the summary counters. */
export type StagedCellState =
    | CellState
    | 'INCONCLUSIVE_INTERMITTENT_5XX'
    | 'REPRODUCIBLE_SERVER_FAILURE_CANDIDATE'
    | 'INCONCLUSIVE_MIXED_TRANSIENT';

/** The classification EVENT recorded against the first (initial) 5xx observation. */
export type Staged5xxClassification =
    | 'SERVER_ERROR_OBSERVED'
    | 'INTERMITTENT_SERVER_ERROR_OBSERVED'
    | 'REPRODUCIBLE_SERVER_FAILURE_CANDIDATE'
    | 'INCONCLUSIVE_MIXED_TRANSIENT'
    | 'PRODUCT_FAILURE';

/** Maximum automatic attempts (the original + at most TWO bounded follow-ups). */
export const MAX_STAGED_ATTEMPTS = 3;

/** One retained attempt observation. `shapeOk` is the page/contract verdict for a
 *  2xx body (true = valid success payload; false = malformed/schema violation =>
 *  the endpoint did NOT complete its public contract). `status` is the HTTP status;
 *  `bodyMeta` carries body metadata (e.g. length, content-type) — NEVER suppressed. */
export interface AttemptObservation {
    status: number;
    /** Contract verdict for a 2xx body: undefined when not a 2xx (status decides). */
    shapeOk?: boolean;
    bodyMeta?: Record<string, unknown>;
}

export interface StagedVerdict {
    classification: Staged5xxClassification;
    cellState: StagedCellState;
    /** product_failure ESTABLISHED (a genuine deterministic defect) vs not. */
    productFailure: boolean;
    /** This verdict contributes clean=false to the run (intermittent / open / candidate). */
    cleanFalse: boolean;
    reason: string;
    /** Every attempt, retained for the artifact (provenance, never erased). */
    attempts: AttemptObservation[];
}

const is2xx = (s: number): boolean => s >= 200 && s < 300;
const is5xx = (s: number): boolean => s >= 500 && s < 600;
const isTransientStatus = (s: number): boolean => s === 429 || s === 503;
/** A 2xx whose body violated the contract (malformed / schema violation). */
const isMalformed2xx = (a: AttemptObservation): boolean => is2xx(a.status) && a.shapeOk === false;

/**
 * Pure staged classifier. Input = the ordered attempt observations (attempts[0] is
 * the ORIGINAL; up to two follow-ups). Returns the final verdict per A/B/D/E.
 *
 * Precedence (Founder-exact):
 *   - E (mixed transient) is checked FIRST among follow-ups: a 429/503 in ANY
 *     follow-up means we do NOT adjudicate the original 500 away -> cell OPEN.
 *   - A malformed/schema-violating 2xx success ON THE ORIGINAL is a deterministic
 *     contract failure -> PRODUCT_FAILURE (no corroboration can rescue a contract
 *     that did not hold). (Stage D, the schema/contract branch.)
 *   - D (deterministic 500 every attempt) -> PRODUCT_FAILURE.
 *   - B (>=2 of 3 are 5xx, not deterministic-all) -> REPRODUCIBLE candidate.
 *   - A (original 5xx + both follow-ups valid 2xx) -> INTERMITTENT.
 *   - else single 5xx with <2 follow-ups (initial stage only) -> SERVER_ERROR_OBSERVED.
 */
export function classifyStaged5xx(attempts: AttemptObservation[]): StagedVerdict {
    const all = attempts.slice(0, MAX_STAGED_ATTEMPTS);
    const original = all[0];
    const followups = all.slice(1);
    const base = (v: Omit<StagedVerdict, 'attempts'>): StagedVerdict => ({ ...v, attempts: all });

    // A malformed/schema-violating success on the ORIGINAL is a deterministic
    // contract failure — the endpoint did NOT complete its public contract.
    if (original && isMalformed2xx(original)) {
        return base({
            classification: 'PRODUCT_FAILURE', cellState: 'PRODUCT_FAILURE', productFailure: true,
            cleanFalse: true, reason: 'malformed success payload / schema violation on original (public contract not met)',
        });
    }

    // E: a follow-up received 429/503 -> mixed transient; do NOT adjudicate the
    // original 5xx away; cell stays OPEN (not closed, not product, not clean).
    if (followups.some((a) => isTransientStatus(a.status))) {
        return base({
            classification: 'INCONCLUSIVE_MIXED_TRANSIENT', cellState: 'INCONCLUSIVE_MIXED_TRANSIENT',
            productFailure: false, cleanFalse: true,
            reason: 'follow-up probe returned 429/503; original 5xx not adjudicated away; cell OPEN',
        });
    }

    const fiveCount = all.filter((a) => is5xx(a.status)).length;
    const goodFollowups = followups.filter((a) => is2xx(a.status) && a.shapeOk !== false);

    // D: deterministic 5xx on EVERY attempt (3 of 3, all attempts taken) -> defect.
    if (all.length === MAX_STAGED_ATTEMPTS && fiveCount === MAX_STAGED_ATTEMPTS) {
        return base({
            classification: 'PRODUCT_FAILURE', cellState: 'PRODUCT_FAILURE', productFailure: true,
            cleanFalse: true, reason: 'deterministic 5xx on all 3 attempts (genuine deterministic defect)',
        });
    }

    // B: 5xx in at least TWO of the THREE attempts (but not deterministic-all) ->
    // reliability candidate (NOT auto product_failure; flagged for PM/Founder).
    if (fiveCount >= 2) {
        return base({
            classification: 'REPRODUCIBLE_SERVER_FAILURE_CANDIDATE', cellState: 'REPRODUCIBLE_SERVER_FAILURE_CANDIDATE',
            productFailure: false, cleanFalse: true,
            reason: `5xx in ${fiveCount}/${all.length} attempts; reliability candidate flagged for PM/Founder disposition`,
        });
    }

    // A: original 5xx AND both follow-ups valid 2xx -> intermittent.
    if (original && is5xx(original.status) && followups.length === 2 && goodFollowups.length === 2) {
        return base({
            classification: 'INTERMITTENT_SERVER_ERROR_OBSERVED', cellState: 'INCONCLUSIVE_INTERMITTENT_5XX',
            productFailure: false, cleanFalse: true,
            reason: 'initial 5xx + both follow-ups valid 2xx; intermittent, product_failure NOT established',
        });
    }

    // Initial stage only (no/partial corroboration yet): a 5xx is OBSERVED — never
    // a PASS, never a network transient, never immediately final PRODUCT_FAILURE.
    return base({
        classification: 'SERVER_ERROR_OBSERVED', cellState: 'INCONCLUSIVE_INTERMITTENT_5XX',
        productFailure: false, cleanFalse: true,
        reason: 'unexpected 5xx observed on expected-success endpoint; awaiting bounded corroboration',
    });
}

/** A 2xx success that the caller has additionally verified as a VALID contract. */
export function successAttempt(status: number, shapeOk: boolean, bodyMeta?: Record<string, unknown>): AttemptObservation {
    return { status, shapeOk, bodyMeta };
}

/** Probe driver: a GET-only follow-up that returns the next AttemptObservation.
 *  Reuses the transport's pacing; performs NO production write. */
export type Staged5xxProbe = () => Promise<AttemptObservation>;

/**
 * Bounded LIVE corroboration. Given the ORIGINAL attempt (an unexpected 5xx) and a
 * GET-only `probe`, issue AT MOST TWO serial follow-ups and classify. Stops early
 * on a follow-up 429/503 (rule E) — that already pins the cell OPEN. Enforces the
 * MAX-3-attempts bound. Every attempt is retained in the returned verdict.
 */
export async function corroborate5xx(original: AttemptObservation, probe: Staged5xxProbe): Promise<StagedVerdict> {
    const attempts: AttemptObservation[] = [original];
    while (attempts.length < MAX_STAGED_ATTEMPTS) {
        const next = await probe();
        attempts.push(next);
        if (isTransientStatus(next.status)) break; // rule E: cell OPEN, stop probing
    }
    return classifyStaged5xx(attempts);
}
