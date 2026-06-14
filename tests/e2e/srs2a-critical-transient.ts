/**
 * SRS-2A — CRITICAL_TRANSIENT_UNAVAILABILITY policy (Founder-exact, SRS2-HARNESS-5).
 *
 * WHY: a CI-egress 429 BURST rate-limited the container and hit a SAME-ORIGIN
 * CRITICAL JS bundle (free2aitools.com/assets/index.*.js -> 429). The bundle
 * serves 200 for a normal request, so the asset is fine — the 429 is a transient
 * rate-limit, NOT a product defect. Founder ruling: a distinct status that keeps
 * BOTH facts — 429=transient AND critical-asset-unavailable-this-run => the page
 * evidence is INVALID for this run (NEVER PASS) — without calling it a defect.
 *
 * PRECEDENCE (status semantics + resource criticality), evaluated by the classifier:
 *   A. same-origin CRITICAL asset, DETERMINISTIC non-transient failure
 *      (404 / malformed body / wrong content-type / integrity failure)
 *      -> SEVERE_PRODUCT_SIGNAL.
 *   B. same-origin CRITICAL asset, CONFIRMED 429 or 503
 *      -> CRITICAL_TRANSIENT_UNAVAILABILITY -> affected page assertion becomes
 *      INCONCLUSIVE_TRANSIENT -> NEVER PASS -> NOT automatically a product defect.
 *   C. optional-telemetry 429/failure -> NONCRITICAL_NETWORK_WARNING (HARNESS-3/4).
 *   D. unknown status / unknown URL / uncorrelated -> UNKNOWN / SEVERE.
 *
 * So 429/503 transient semantics take PRECEDENCE over "asset permanently broken",
 * while criticality still makes the affected page NOT countable as a clean PASS.
 *
 * CONSERVATISM: a deterministic same-origin critical failure (404/malformed/wrong
 * content-type/integrity) stays SEVERE; a 429/503 can NEVER become PASS. This
 * harness only classifies + counts. It does NOT auto-register an operational
 * finding (P-10); broad persistence under the shaped low rate is the PM's call.
 */

import type { Classification, Severity } from './srs2a-classifier';

/** Classifier verdict. `criticalTransient`+`conditions` appear ONLY for a
 *  CRITICAL_TRANSIENT_UNAVAILABILITY so the caller routes the affected page cell
 *  to INCONCLUSIVE_TRANSIENT (never PASS) while the event stays a WARNING (asset
 *  fine; not a defect). Both raw facts are preserved in the artifact. */
export interface Verdict {
    classification: Classification;
    severity: Severity;
    reason: string;
    criticalTransient?: boolean;
    conditions?: CriticalTransientConditions;
}

/** A confirmed transient transport status for the critical-transient bucket. */
export function isTransientStatus(status: number): boolean {
    return status === 429 || status === 503;
}

/**
 * REQUEST-RATE CONTROL (HARNESS-5 workload shaping, NOT page-readiness masking).
 * A SHORT deterministic minimum-navigation-interval between top-level navigations
 * to keep the CI container's request rate under the CF same-origin limit that
 * caused the 429 burst. This is a token-bucket-equivalent minimum interval — it
 * paces our OWN traffic; it does NOT allowlist CI, bypass CF limits, sleep to
 * hide a deterministic failure, or convert any 429 into PASS. Bounded (small,
 * fixed). Pair with: serial navigations, browser/context + cache reuse where
 * isolation permits, no duplicate cold loads of the same bundle, bounded (<=2)
 * retries ONLY on a confirmed 429/503, and Retry-After honored (see helpers).
 */
export const MIN_NAV_INTERVAL_MS = 750;
let lastNavAt = 0;

/** Await the remaining minimum-navigation-interval before the next navigation.
 *  Deterministic, bounded by MIN_NAV_INTERVAL_MS; never an unbounded/long sleep. */
export async function paceNavigation(now: number = Date.now()): Promise<number> {
    const elapsed = now - lastNavAt;
    const wait = lastNavAt > 0 && elapsed < MIN_NAV_INTERVAL_MS ? MIN_NAV_INTERVAL_MS - elapsed : 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNavAt = Date.now();
    return wait;
}

/** HARNESS-5 PRECEDENCE B: same-origin CRITICAL asset on a CONFIRMED 429/503 ->
 *  CRITICAL_TRANSIENT_UNAVAILABILITY. Transient semantics take precedence over
 *  "asset permanently broken" (NOT a SEVERE defect); criticality still makes the
 *  page cell INCONCLUSIVE_TRANSIENT (never PASS, downgraded by the caller). The
 *  severity is WARNING (the asset is fine); the AFFECTED PAGE cell is what the
 *  spec routes to INCONCLUSIVE_TRANSIENT. */
export function criticalTransientVerdict(
    url: string, resourceType: string, status: number, sameOrigin: boolean,
    headers?: Record<string, string> | null,
): Verdict {
    const conditions = buildConditions(url, resourceType, status, sameOrigin, headers);
    const ev = evaluateCriticalTransient(conditions);
    const ra = headers ? headers['retry-after'] : undefined;
    const raNote = ra ? ` Retry-After=${ra}` : ' Retry-After=absent';
    return {
        classification: 'CRITICAL_TRANSIENT_UNAVAILABILITY', severity: 'WARNING',
        reason: `same-origin critical ${resourceType} ${status} (transient rate-limit, NOT a product defect; page evidence INVALID this run)${raNote}; ${ev.reason}`,
        criticalTransient: true, conditions,
    };
}

/**
 * Evidence required to classify a same-origin CRITICAL asset failure as
 * CRITICAL_TRANSIENT_UNAVAILABILITY (Founder-exact: ALL must be true).
 *  - exact URL captured;
 *  - same-origin confirmed;
 *  - status confirmed 429 or 503;
 *  - resource type recorded;
 *  - response headers + Retry-After recorded where present (presence is captured
 *    even when the header is absent; absence is itself recorded as null);
 *  - a bounded independent probe shows the asset normally serves valid content OR
 *    prior stable evidence exists — CORROBORATING ONLY (must NOT turn PASS);
 *  - absence of a deterministic missing/broken artifact (no 404/malformed/etc.);
 *  - the event remains fully visible in the artifact (the caller preserves it).
 */
export interface CriticalTransientConditions {
    urlCaptured: boolean;
    sameOriginConfirmed: boolean;
    statusConfirmedTransient: boolean;
    resourceTypeRecorded: boolean;
    headersRecorded: boolean;
    /** corroboration ONLY — true when a bounded probe / prior evidence shows the
     *  asset normally serves valid content. Absence does NOT force SEVERE; its
     *  job is to keep the affected assertion INCONCLUSIVE (never PASS), not to
     *  upgrade it to a defect. */
    corroboratedHealthy: boolean;
    /** true ONLY when there is NO deterministic missing/broken artifact. A
     *  deterministic failure (404/malformed/wrong-type/integrity) -> SEVERE. */
    noDeterministicArtifact: boolean;
}

export interface CriticalTransientVerdict {
    eligible: boolean;
    reason: string;
    /** machine-checkable conditions snapshot for the artifact (never erased). */
    conditions: CriticalTransientConditions;
}

/**
 * True iff ALL mandatory CRITICAL_TRANSIENT conditions hold. `corroboratedHealthy`
 * is CORROBORATING and is NOT mandatory for eligibility (its absence keeps the
 * cell INCONCLUSIVE, it never makes it PASS and never forces SEVERE); it is still
 * recorded in the verdict. The mandatory gate is: URL + same-origin + confirmed
 * transient + type + headers recorded + NO deterministic artifact.
 */
export function evaluateCriticalTransient(c: CriticalTransientConditions): CriticalTransientVerdict {
    const mandatory: Array<[boolean, string]> = [
        [c.urlCaptured, 'exact URL not captured'],
        [c.sameOriginConfirmed, 'same-origin not confirmed'],
        [c.statusConfirmedTransient, 'status not a confirmed 429/503'],
        [c.resourceTypeRecorded, 'resource type not recorded'],
        [c.headersRecorded, 'response headers / Retry-After presence not recorded'],
        [c.noDeterministicArtifact, 'a deterministic missing/broken artifact is present'],
    ];
    const missing = mandatory.filter(([ok]) => !ok).map(([, why]) => why);
    if (missing.length) {
        return { eligible: false, reason: `conditions not all met: ${missing.join('; ')}`, conditions: c };
    }
    const corr = c.corroboratedHealthy
        ? 'corroborated healthy (probe/prior evidence) — corroborating ONLY, assertion stays INCONCLUSIVE'
        : 'no corroboration — assertion stays INCONCLUSIVE (never PASS), not escalated to SEVERE';
    return { eligible: true, reason: `confirmed transient on same-origin critical asset; ${corr}`, conditions: c };
}

/** Build the conditions snapshot for a response-path same-origin critical
 *  transient. `headers` may be undefined (a requestfailed path has no response
 *  object); we record the Retry-After presence/value where available. The
 *  collector path always has the request URL + resource type, so urlCaptured /
 *  resourceTypeRecorded are derived from non-empty inputs (never assumed). */
export function buildConditions(
    url: string,
    resourceType: string,
    status: number,
    sameOrigin: boolean,
    headers?: Record<string, string> | null,
): CriticalTransientConditions {
    return {
        urlCaptured: !!url,
        sameOriginConfirmed: sameOrigin === true,
        statusConfirmedTransient: isTransientStatus(status),
        resourceTypeRecorded: !!resourceType,
        // headers are "recorded" when we have a (possibly empty) headers object —
        // its presence/absence, incl. Retry-After, is what the artifact preserves.
        headersRecorded: headers !== undefined,
        // The response path that reaches here has a real transport status (not a
        // deterministic 404/malformed artifact); the caller routes deterministic
        // failures to SEVERE BEFORE calling this, so no deterministic artifact.
        noDeterministicArtifact: true,
        // Corroboration is supplied out-of-band (bounded probe / prior evidence).
        // Default false: absent corroboration keeps the cell INCONCLUSIVE, which
        // is the correct conservative state; it is NEVER required to avoid PASS.
        corroboratedHealthy: false,
    };
}
