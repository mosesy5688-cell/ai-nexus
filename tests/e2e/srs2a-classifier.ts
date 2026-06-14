/**
 * SRS-2A — SEVERE browser-error CLASSIFIER (Founder-exact; SRS2-HARNESS-2..5).
 *
 * A blanket ignore of 429 / requestfailed / console.error / net::ERR_FAILED is
 * FORBIDDEN. Every captured event is classified into one bucket and PRESERVED
 * (never erase). A test FAILS on SEVERE; else WARNING/transient counts surfaced.
 *
 * H2 PROVENANCE: a bare console net::ERR_FAILED carries NO url; we CORRELATE it
 *   to the nearest same-page requestfailed to recover the URL (evidence, never a
 *   guess); an uncorrelatable one is UNKNOWN_UNCORRELATED_NETWORK_FAILURE (SEVERE).
 * H3 OPTIONAL-TELEMETRY ORDER: an EXACT telemetry SIGNATURE (host+path+method) is
 *   checked BEFORE the generic xhr/fetch rule -> cross-origin beacon = WARNING;
 *   co-occurring pageerror keeps it SEVERE.
 * H4 CORS-policy console correlation: the same RUM request also emits a CORS
 *   console.error with the URL in its TEXT; extracted + re-run through the signature.
 * H5 CRITICAL_TRANSIENT_UNAVAILABILITY: same-origin CRITICAL asset on a CONFIRMED
 *   429/503 -> transient (NOT a defect) BUT the page cell is INCONCLUSIVE_TRANSIENT
 *   (never PASS); deterministic same-origin critical failure stays SEVERE. See
 *   ./srs2a-critical-transient for the precedence table + condition gate.
 *
 * Taxonomy: SEVERE_PRODUCT_SIGNAL -> fail; CRITICAL_TRANSIENT_UNAVAILABILITY ->
 * warning + page INCONCLUSIVE (never PASS); TRANSIENT_RATE_LIMIT /
 * NONCRITICAL_NETWORK_WARNING / EXPECTED_NAVIGATION_ABORT -> warning;
 * UNKNOWN_UNCORRELATED_NETWORK_FAILURE + UNKNOWN_ERROR -> SEVERE.
 */
import { classifyCorsConsole, type FailureContext, isCorsConsoleText, isExactTelemetrySignature, isKnownOptional } from './srs2a-optional-policy';
import { criticalTransientVerdict, type Verdict } from './srs2a-critical-transient';

export type Severity = 'SEVERE' | 'WARNING';
export type Classification =
    | 'SEVERE_PRODUCT_SIGNAL'
    | 'CRITICAL_TRANSIENT_UNAVAILABILITY'
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

/** Classify a network response. PRECEDENCE (HARNESS-5): deterministic same-origin
 *  critical failure (404/5xx) -> SEVERE; confirmed 429/503 on a same-origin
 *  critical asset -> CRITICAL_TRANSIENT_UNAVAILABILITY (transient precedence; page
 *  cell INCONCLUSIVE; never SEVERE, never PASS); 429/503 on a data/API dep ->
 *  TRANSIENT_RATE_LIMIT; optional/third-party -> NONCRITICAL_NETWORK_WARNING. */
export function classifyResponse(
    url: string,
    resourceType: string,
    status: number,
    sameOrigin: boolean,
    method = '',
    ctx: FailureContext = {},
    headers?: Record<string, string> | null,
): Verdict {
    // EXACT telemetry signature wins over the generic xhr/fetch rule on a
    // non-transient bad status; 429/503 keep TRANSIENT/critical-transient below.
    if (status !== 429 && status !== 503) {
        const v = telemetryVerdict(url, resourceType, method, sameOrigin, ctx, `${status}`);
        if (v) return v;
    }
    if (status === 429 || status === 503) {
        // PRECEDENCE B: same-origin CRITICAL asset + confirmed 429/503 ->
        // CRITICAL_TRANSIENT_UNAVAILABILITY (checked BEFORE the data/API downgrade
        // so a same-origin critical xhr/fetch is NOT swallowed as a plain rate-limit).
        if (sameOrigin && CRITICAL_TYPES.has(resourceType)) {
            return criticalTransientVerdict(url, resourceType, status, sameOrigin, headers);
        }
        if (status === 429 && (/\/api\//.test(url) || resourceType === 'fetch' || resourceType === 'xhr')) {
            return { classification: 'TRANSIENT_RATE_LIMIT', severity: 'WARNING', reason: '429 on expected data/API dependency' };
        }
        if (status === 503) {
            return { classification: 'TRANSIENT_RATE_LIMIT', severity: 'WARNING', reason: '503 transient upstream' };
        }
        return { classification: 'TRANSIENT_RATE_LIMIT', severity: 'WARNING', reason: '429 (non-critical resource)' };
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
 * Shared EXACT-telemetry verdict (response + request-failure paths): WARNING on
 * an exact signature with no co-occurring pageerror/hydration; SEVERE when it
 * co-occurs with pageerror/hydration; null when no signature (caller falls thru).
 */
function telemetryVerdict(
    url: string, resourceType: string, method: string, sameOrigin: boolean,
    ctx: FailureContext, statusOrFail: string,
): Verdict | null {
    const sig = isExactTelemetrySignature(url, resourceType, method, sameOrigin);
    if (!sig.match) return null;
    if (ctx.pageErrored || ctx.hydrationFailed) {
        const co = ctx.pageErrored ? 'pageerror' : 'hydration failure';
        return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: `${sig.reason} ${statusOrFail} BUT co-occurs with ${co} -> SEVERE` };
    }
    return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: `${sig.reason} ${statusOrFail}; CORS-blocked beacon preserved` };
}

/** Classify a failed request (no HTTP status). ORDER (H3): (1) nav abort ->
 *  WARNING; (2) EXACT telemetry SIGNATURE BEFORE the page-required rule (the ONLY
 *  sanctioned xhr/fetch downgrade), vetoed by co-occurring pageerror/hydration;
 *  (3) else conservative same-origin/critical/page-required; (4) captured-but-
 *  unexplained stays SEVERE. net::ERR_FAILED never downgraded by IDENTITY. NOTE:
 *  a requestfailed has NO confirmed 429/503 status, so it can never be a H5
 *  CRITICAL_TRANSIENT (that gate requires a confirmed transient response status). */
export function classifyRequestFailure(
    url: string,
    resourceType: string,
    errorText: string,
    sameOrigin: boolean,
    method = '',
    ctx: FailureContext = {},
): Verdict {
    if (ABORT_MESSAGE.test(errorText)) {
        return { classification: 'EXPECTED_NAVIGATION_ABORT', severity: 'WARNING', reason: `aborted by navigation: ${errorText}` };
    }
    // (2) EXACT telemetry signature BEFORE the page-required rule — the ONLY
    // sanctioned xhr/fetch downgrade. Telemetry + pageerror/hydration -> SEVERE.
    const v = telemetryVerdict(url, resourceType, method, sameOrigin, ctx, `failed=${errorText}`);
    if (v) return v;
    // (3) No signature -> conservative same-origin/critical/page-required.
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
    // (4) Captured URL, no signature, not optional, not an abort -> SEVERE.
    if (sameOrigin) {
        return { classification: 'UNKNOWN_ERROR', severity: 'SEVERE', reason: `uncorrelated same-origin failure: ${errorText}` };
    }
    return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: `non-optional third-party failure (${opt.reason}): ${errorText}` };
}

/** Classify a console.error. A bare net::ERR_FAILED (NO url) is correlated to the
 *  nearest requestfailed (correlated transient/critical-transient inherits that
 *  verdict); an uncorrelatable one is UNKNOWN_UNCORRELATED_NETWORK_FAILURE (SEVERE).
 *  H4: a CORS console.error carries its URL in the TEXT; extracted + re-run through
 *  the EXACT signature, downgraded ONLY on a real match with no pageerror/hydration
 *  (flagged `cors` for dedup against the SAME requestfailed). Else SEVERE. */
export function classifyConsole(
    text: string,
    now: number,
    failures: BrowserEvent[],
    transientUrls: Set<string>,
    ctx: FailureContext = {},
): { classification: Classification; severity: Severity; reason: string; correlated: boolean; cors?: boolean; corsUrl?: string | null } {
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
    // SRS2-HARNESS-4: CORS-policy blocked-request console.error (URL in the text).
    if (isCorsConsoleText(text)) {
        const v = classifyCorsConsole(text, ctx);
        if (v.downgrade) {
            return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: v.reason, correlated: true, cors: true, corsUrl: v.url };
        }
        return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: v.reason, correlated: false, cors: true, corsUrl: v.url };
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
        if (dt <= bestDt) { bestDt = dt; best = f; }
    }
    return best;
}
