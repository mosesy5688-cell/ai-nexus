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
 * full provenance (url, origin, resourceType, method, errorText, frame, ts) and
 * CORRELATE the generic console event to the nearest requestfailed event on the
 * SAME PAGE within a time window to recover the real URL. Downgrade rests on that
 * EVIDENCE + an explicit optional-resource allowlist — never on a guess. A
 * net::ERR_FAILED that STILL cannot be correlated is a HARNESS_OBSERVABILITY
 * failure (UNKNOWN_UNCORRELATED_NETWORK_FAILURE, SEVERE): NOT a clean run.
 *
 * Taxonomy (see classifiers below):
 *   SEVERE_PRODUCT_SIGNAL                  -> test fails (genuine product defect)
 *   TRANSIENT_RATE_LIMIT                   -> warning (confirmed 429/503 on dep)
 *   NONCRITICAL_NETWORK_WARNING            -> warning (provably optional resource)
 *   EXPECTED_NAVIGATION_ABORT              -> warning (request aborted by nav)
 *   UNKNOWN_UNCORRELATED_NETWORK_FAILURE   -> SEVERE  (harness observability gap)
 *   UNKNOWN_ERROR                          -> SEVERE  (uncorrelated/unexplained)
 */
import { isKnownOptional } from './srs2a-optional-policy';

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
): { classification: Classification; severity: Severity; reason: string } {
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
 * Classify a failed request (no HTTP status). A net::ERR_FAILED may NOT be
 * downgraded by third-party IDENTITY alone. Downgrade to NONCRITICAL only when:
 * the URL is captured (here it always is — this is a real requestfailed event),
 * it is NOT a document/navigation, NOT a page-required script/style/font/data
 * request, and it is a KNOWN-OPTIONAL service per the explicit allowlist. A
 * same-origin document/script/style/font failure stays SEVERE; a non-optional
 * third-party failure stays SEVERE; provable navigation aborts are a WARNING.
 */
export function classifyRequestFailure(
    url: string,
    resourceType: string,
    errorText: string,
    sameOrigin: boolean,
): { classification: Classification; severity: Severity; reason: string } {
    if (ABORT_MESSAGE.test(errorText)) {
        return { classification: 'EXPECTED_NAVIGATION_ABORT', severity: 'WARNING', reason: `aborted by navigation: ${errorText}` };
    }
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
    // Captured URL, not optional, not an abort. Same-origin -> uncorrelated
    // product signal; third-party-but-critical -> SEVERE (when in doubt SEVERE).
    if (sameOrigin) {
        return { classification: 'UNKNOWN_ERROR', severity: 'SEVERE', reason: `uncorrelated same-origin failure: ${errorText}` };
    }
    return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: `non-optional third-party failure (${opt.reason}): ${errorText}` };
}

/**
 * Classify a console.error. A bare resource-load failure (net::ERR_FAILED with
 * NO url) is FIRST correlated to the nearest requestfailed event on the same
 * page within the time window; the recovered event's classification is reused.
 * If it correlates to a recorded transient (429/503) it is a WARNING. If it
 * CANNOT be correlated to any requestfailed event, it is a
 * UNKNOWN_UNCORRELATED_NETWORK_FAILURE (HARNESS observability gap, SEVERE) — NOT
 * a product PASS, NOT a confirmed product gap. Any other uncorrelated
 * console.error is SEVERE.
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
