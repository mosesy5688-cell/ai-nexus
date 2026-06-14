/**
 * SRS-2A — SEVERE browser-error CLASSIFIER (Founder-exact; SRS2-HARNESS-2).
 *
 * A blanket ignore of 429 / requestfailed / console.error / net::ERR_FAILED is
 * FORBIDDEN. Every captured browser event is classified into exactly one bucket
 * and PRESERVED in the run artifact (reclassify, never erase). A test FAILS as a
 * product signal on any SEVERE event; otherwise it records WARNING / transient
 * counts and still surfaces them.
 *
 * SRS2-HARNESS-2 (failed-request PROVENANCE CAPTURE): a bare console
 * `net::ERR_FAILED` carries NO url. We capture requestfailed/response events with
 * full provenance and CORRELATE the generic console event to the nearest
 * requestfailed event on the SAME PAGE within a time window to recover the real
 * URL. Downgrade rests on that EVIDENCE + an explicit allowlist — never a guess.
 * A net::ERR_FAILED that STILL cannot be correlated is a HARNESS_OBSERVABILITY
 * failure (UNKNOWN_UNCORRELATED_NETWORK_FAILURE, SEVERE): NOT a clean run.
 *
 * SRS2-HARNESS-3 (optional-telemetry classification ORDER): an EXACT telemetry
 * SIGNATURE (host+path+method tuple — CF Insights POST /cdn-cgi/rum, GA
 * POST|GET /collect) is checked BEFORE the generic xhr/fetch page-required rule,
 * so a cross-origin RUM beacon (resourceType=xhr) is a WARNING, not SEVERE by
 * resourceType. EXACT-MATCH ONLY — never a broad "third-party xhr" downgrade; a
 * match co-occurring with a pageerror stays SEVERE; the CORS-blocked event is
 * PRESERVED + counted, never erased.
 *
 * Taxonomy (see classifiers below):
 *   SEVERE_PRODUCT_SIGNAL                  -> test fails (genuine product defect)
 *   TRANSIENT_RATE_LIMIT                   -> warning (confirmed 429/503 on dep)
 *   NONCRITICAL_NETWORK_WARNING            -> warning (provably optional resource)
 *   EXPECTED_NAVIGATION_ABORT              -> warning (request aborted by nav)
 *   UNKNOWN_UNCORRELATED_NETWORK_FAILURE   -> SEVERE  (harness observability gap)
 *   UNKNOWN_ERROR                          -> SEVERE  (uncorrelated/unexplained)
 */
import { type FailureContext, isExactTelemetrySignature, isKnownOptional } from './srs2a-optional-policy';

export type Severity = 'SEVERE' | 'WARNING';
export type Classification =
    | 'SEVERE_PRODUCT_SIGNAL'
    | 'TRANSIENT_RATE_LIMIT'
    | 'NONCRITICAL_NETWORK_WARNING'
    | 'EXPECTED_NAVIGATION_ABORT'
    | 'UNKNOWN_UNCORRELATED_NETWORK_FAILURE'
    | 'UNKNOWN_ERROR';

export interface BrowserEvent {
    kind: 'console' | 'pageerror' | 'requestfailed' | 'badresponse';
    url: string;
    origin: string;
    resourceType: string;
    method: string;
    status: number | null; // HTTP status where available
    errorText: string; // request.failure()?.errorText where available
    frameUrl: string;
    sameOrigin: boolean;
    /** ms epoch when captured — used for console<->requestfailed correlation. */
    timestamp: number;
    /** True when a generic console event was matched to a requestfailed event. */
    correlated: boolean;
    message: string;
    classification: Classification;
    severity: Severity;
    reason: string;
}

/** Same-origin resource types whose failure breaks required rendering. */
const CRITICAL_TYPES = new Set(['document', 'script', 'stylesheet', 'font']);
/** Navigation-superseded abort messages (provably cancelled, not a defect). */
const ABORT_MESSAGE = /ERR_ABORTED|net::ERR_ABORTED|interrupted by another navigation|frame was detached/i;
/** Generic browser console resource-load failure that carries NO url of its own. */
const BARE_RESOURCE_FAIL = /Failed to load resource|net::ERR_FAILED|net::ERR_/i;
/** Correlation window: a console resource-fail is matched to a requestfailed
 *  event on the same page within this many ms (nearest in time). */
const CORRELATION_WINDOW_MS = 2000;

export function originOf(url: string): string {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}

export function isSameOrigin(url: string, baseUrl: string): boolean {
    const b = originOf(baseUrl);
    return !!b && originOf(url) === b;
}

/**
 * Classify a network response (HTTP status present). 429/503 on a data/API dep
 * is transient; same-origin critical asset 4xx/5xx is SEVERE; known-optional
 * third-party is a WARNING; otherwise non-critical third-party WARNING.
 */
export function classifyResponse(
    url: string,
    resourceType: string,
    status: number,
    sameOrigin: boolean,
    method = '',
    ctx: FailureContext = {},
): { classification: Classification; severity: Severity; reason: string } {
    // EXACT telemetry signature wins over the generic xhr/fetch rule on a
    // non-transient bad status (4xx/5xx != 429/503); 429/503 keep TRANSIENT below.
    if (status !== 429 && status !== 503) {
        const v = telemetryVerdict(url, resourceType, method, sameOrigin, ctx, `${status}`);
        if (v) return v;
    }
    if (status === 429) {
        if (/\/api\//.test(url) || resourceType === 'fetch' || resourceType === 'xhr') {
            return { classification: 'TRANSIENT_RATE_LIMIT', severity: 'WARNING', reason: '429 on expected data/API dependency' };
        }
        if (sameOrigin && CRITICAL_TYPES.has(resourceType)) {
            return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: '429 on same-origin critical asset' };
        }
        return { classification: 'TRANSIENT_RATE_LIMIT', severity: 'WARNING', reason: '429 (non-critical resource)' };
    }
    if (status === 503) {
        return { classification: 'TRANSIENT_RATE_LIMIT', severity: 'WARNING', reason: '503 transient upstream' };
    }
    if (status === 404 || status >= 500) {
        if (sameOrigin && CRITICAL_TYPES.has(resourceType)) {
            return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: `same-origin ${resourceType} ${status}` };
        }
        if (sameOrigin && /\.(js|css|png|jpe?g|svg|webp|woff2?)(\?|$)/i.test(url)) {
            return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: `same-origin asset ${status}` };
        }
        const opt = isKnownOptional(url, resourceType);
        if (opt.optional) {
            return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: `optional resource ${status}: ${opt.reason}` };
        }
        return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: `non-critical third-party ${status}` };
    }
    return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: `status ${status}` };
}

/**
 * Shared EXACT-telemetry verdict for response + request-failure paths: WARNING on
 * an exact host+path+method signature with no co-occurring pageerror/hydration;
 * SEVERE when such a match co-occurs with a pageerror/hydration (telemetry +
 * pageerror -> SEVERE); null when no signature matches (caller falls through).
 */
function telemetryVerdict(
    url: string, resourceType: string, method: string, sameOrigin: boolean,
    ctx: FailureContext, statusOrFail: string,
): { classification: Classification; severity: Severity; reason: string } | null {
    const sig = isExactTelemetrySignature(url, resourceType, method, sameOrigin);
    if (!sig.match) return null;
    if (ctx.pageErrored || ctx.hydrationFailed) {
        const co = ctx.pageErrored ? 'pageerror' : 'hydration failure';
        return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: `${sig.reason} ${statusOrFail} BUT co-occurs with ${co} -> SEVERE` };
    }
    return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: `${sig.reason} ${statusOrFail}; CORS-blocked beacon preserved` };
}

/**
 * Classify a failed request (no HTTP status). Founder-exact ORDER (HARNESS-3):
 * (1) provenance captured; (2) EXACT optional-telemetry SIGNATURE (host+path+
 * method) checked BEFORE the generic xhr/fetch page-required rule — EXACT-MATCH
 * ONLY, never a broad "third-party xhr" downgrade, vetoed by a co-occurring
 * pageerror/hydration; (3) otherwise the unchanged same-origin/critical/
 * page-required classification; (4) anything captured-but-unexplained stays
 * SEVERE. net::ERR_FAILED is never downgraded by IDENTITY; nav aborts are WARNING.
 */
export function classifyRequestFailure(
    url: string,
    resourceType: string,
    errorText: string,
    sameOrigin: boolean,
    method = '',
    ctx: FailureContext = {},
): { classification: Classification; severity: Severity; reason: string } {
    if (ABORT_MESSAGE.test(errorText)) {
        return { classification: 'EXPECTED_NAVIGATION_ABORT', severity: 'WARNING', reason: `aborted by navigation: ${errorText}` };
    }
    // (2) EXACT optional-telemetry signature runs BEFORE the page-required rule.
    // A beacon-class xhr/fetch to a known telemetry host+path+method is the ONLY
    // sanctioned xhr/fetch downgrade. Telemetry + pageerror/hydration -> SEVERE.
    const v = telemetryVerdict(url, resourceType, method, sameOrigin, ctx, `failed=${errorText}`);
    if (v) return v;
    // (3) No signature match -> conservative same-origin/critical/page-required.
    if (sameOrigin && CRITICAL_TYPES.has(resourceType)) {
        return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: `same-origin ${resourceType} request failure: ${errorText}` };
    }
    if (resourceType === 'document') {
        return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: `navigation/document request failure: ${errorText}` };
    }
    const opt = isKnownOptional(url, resourceType);
    if (opt.optional) {
        return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: `${opt.reason}; failure=${errorText}` };
    }
    // (4) Captured URL, no signature, not optional, not an abort. Same-origin ->
    // uncorrelated product signal; third-party-but-critical -> SEVERE (in doubt).
    if (sameOrigin) {
        return { classification: 'UNKNOWN_ERROR', severity: 'SEVERE', reason: `uncorrelated same-origin failure: ${errorText}` };
    }
    return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: `non-optional third-party failure (${opt.reason}): ${errorText}` };
}

/**
 * Classify a console.error. A bare net::ERR_FAILED (NO url) is FIRST correlated
 * to the nearest requestfailed event on the same page within the time window and
 * reuses that event's classification; a correlated 429/503 is a WARNING. An
 * UNcorrelatable net::ERR_FAILED is UNKNOWN_UNCORRELATED_NETWORK_FAILURE (HARNESS
 * gap, SEVERE) — NOT a product PASS. Any other uncorrelated console.error: SEVERE.
 */
export function classifyConsole(
    text: string,
    now: number,
    failures: BrowserEvent[],
    transientUrls: Set<string>,
): { classification: Classification; severity: Severity; reason: string; correlated: boolean } {
    if (/ResizeObserver loop/i.test(text)) {
        return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: 'benign ResizeObserver loop warning', correlated: false };
    }
    // Console text that already names a classified transient response.
    if (/\b(429|503)\b/.test(text) && transientUrls.size > 0) {
        for (const u of transientUrls) {
            if (text.includes(u) || text.includes(originOf(u))) {
                return { classification: 'TRANSIENT_RATE_LIMIT', severity: 'WARNING', reason: 'console correlated with classified transient response', correlated: true };
            }
        }
    }
    if (BARE_RESOURCE_FAIL.test(text)) {
        const match = correlateToFailure(now, failures);
        if (match) {
            return {
                classification: match.classification, severity: match.severity, correlated: true,
                reason: `console net::ERR_FAILED correlated (dt=${Math.abs(now - match.timestamp)}ms) -> ${match.url} :: ${match.reason}`,
            };
        }
        return {
            classification: 'UNKNOWN_UNCORRELATED_NETWORK_FAILURE', severity: 'SEVERE', correlated: false,
            reason: 'net::ERR_FAILED could not be correlated to any requestfailed event (HARNESS_OBSERVABILITY_FAILURE: NOT clean, NOT a product PASS)',
        };
    }
    return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: 'uncorrelated console.error', correlated: false };
}

/** Find the requestfailed event nearest in time within the correlation window. */
function correlateToFailure(now: number, failures: BrowserEvent[]): BrowserEvent | null {
    let best: BrowserEvent | null = null;
    let bestDt = CORRELATION_WINDOW_MS;
    for (const f of failures) {
        const dt = Math.abs(now - f.timestamp);
        if (dt <= bestDt) {
            bestDt = dt;
            best = f;
        }
    }
    return best;
}
