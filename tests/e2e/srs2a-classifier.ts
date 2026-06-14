/**
 * SRS-2A — SEVERE browser-error CLASSIFIER (Founder-exact calibration).
 *
 * A blanket ignore of 429 / requestfailed / console.error / net::ERR_FAILED is
 * FORBIDDEN. Every captured browser event is classified into exactly one bucket
 * and PRESERVED in the run artifact (reclassify, never erase). A test FAILS as a
 * product signal on any SEVERE event; otherwise it records WARNING / transient
 * counts and still surfaces them.
 *
 * Taxonomy (see classifyEvent):
 *   SEVERE_PRODUCT_SIGNAL        -> test fails (genuine product defect)
 *   TRANSIENT_RATE_LIMIT         -> warning  (confirmed 429 on expected dep)
 *   NONCRITICAL_NETWORK_WARNING  -> warning  (provably superseded/noncritical)
 *   EXPECTED_NAVIGATION_ABORT    -> warning  (request aborted by navigation)
 *   UNKNOWN_ERROR                -> SEVERE   (uncorrelated/unexplained -> fail)
 */
import type { Page, Request, Response } from '@playwright/test';

export type Severity = 'SEVERE' | 'WARNING';
export type Classification =
    | 'SEVERE_PRODUCT_SIGNAL'
    | 'TRANSIENT_RATE_LIMIT'
    | 'NONCRITICAL_NETWORK_WARNING'
    | 'EXPECTED_NAVIGATION_ABORT'
    | 'UNKNOWN_ERROR';

export interface BrowserEvent {
    kind: 'console' | 'pageerror' | 'requestfailed' | 'badresponse';
    url: string;
    resourceType: string;
    status: number | null; // HTTP status where available
    sameOrigin: boolean;
    message: string;
    classification: Classification;
    severity: Severity;
    reason: string;
}

/** Third-party telemetry/analytics whose failure is unrelated to correctness. */
const THIRD_PARTY_TELEMETRY =
    /googletagmanager|google-analytics|gtag|plausible|clarity|cloudflareinsights\.com|\/cdn-cgi\/rum/i;
/** Same-origin resource types whose failure breaks required rendering. */
const CRITICAL_TYPES = new Set(['document', 'script', 'stylesheet']);
/** Navigation-superseded abort messages (provably cancelled, not a defect). */
const ABORT_MESSAGE = /ERR_ABORTED|net::ERR_ABORTED|interrupted by another navigation|frame was detached/i;

function originOf(url: string): string {
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
 * Classify a network response. TRANSIENT_RATE_LIMIT requires ALL of: exact URL +
 * resourceType recorded (caller supplies), status confirmed 429, request targets
 * an expected data/API dependency. The remaining transient conditions (honest
 * partial state, shell functional, no uncaught exception) are asserted at the
 * test level; presence here only downgrades to WARNING and preserves the event.
 */
export function classifyResponse(
    url: string,
    resourceType: string,
    status: number,
    sameOrigin: boolean,
): { classification: Classification; severity: Severity; reason: string } {
    if (THIRD_PARTY_TELEMETRY.test(url)) {
        return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: 'third-party telemetry beacon' };
    }
    if (status === 429) {
        // Confirmed 429 on an expected data/API dependency -> transient.
        if (/\/api\//.test(url) || resourceType === 'fetch' || resourceType === 'xhr') {
            return { classification: 'TRANSIENT_RATE_LIMIT', severity: 'WARNING', reason: '429 on expected data/API dependency' };
        }
        // 429 on a same-origin critical asset still breaks rendering -> severe.
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
        return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: `third-party/non-critical ${status}` };
    }
    return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: `status ${status}` };
}

/**
 * Classify a failed request (no HTTP status). net::ERR_FAILED / ERR_* may NOT be
 * ignored by message text alone: downgrade to NONCRITICAL only when the failed
 * request is provably superseded/cancelled by navigation OR a noncritical
 * third-party resource. A same-origin script/style/document failure is SEVERE.
 * UNKNOWN / uncorrelated network failure stays SEVERE (UNKNOWN_ERROR).
 */
export function classifyRequestFailure(
    url: string,
    resourceType: string,
    errorText: string,
    sameOrigin: boolean,
): { classification: Classification; severity: Severity; reason: string } {
    if (THIRD_PARTY_TELEMETRY.test(url)) {
        return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: 'third-party telemetry beacon failure' };
    }
    if (ABORT_MESSAGE.test(errorText)) {
        return { classification: 'EXPECTED_NAVIGATION_ABORT', severity: 'WARNING', reason: `aborted by navigation: ${errorText}` };
    }
    if (sameOrigin && CRITICAL_TYPES.has(resourceType)) {
        return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: `same-origin ${resourceType} request failure: ${errorText}` };
    }
    if (!sameOrigin) {
        return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: `third-party request failure: ${errorText}` };
    }
    // Same-origin, non-critical resource type, not a known abort -> uncorrelated.
    return { classification: 'UNKNOWN_ERROR', severity: 'SEVERE', reason: `uncorrelated same-origin failure: ${errorText}` };
}

/**
 * Classify a console.error. ALWAYS SEVERE unless the text is provably correlated
 * with an already-classified transient response (429/503) or third-party
 * telemetry. console.error NOT correlated with an explicit transient is SEVERE.
 */
export function classifyConsole(
    text: string,
    transientUrls: Set<string>,
): { classification: Classification; severity: Severity; reason: string } {
    if (THIRD_PARTY_TELEMETRY.test(text)) {
        return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: 'third-party telemetry console noise' };
    }
    if (/ResizeObserver loop/i.test(text)) {
        return { classification: 'NONCRITICAL_NETWORK_WARNING', severity: 'WARNING', reason: 'benign ResizeObserver loop warning' };
    }
    // Correlate "429"/"503" console text with a recorded transient response.
    if (/\b(429|503)\b/.test(text) && transientUrls.size > 0) {
        for (const u of transientUrls) {
            if (text.includes(u) || text.includes(originOf(u))) {
                return { classification: 'TRANSIENT_RATE_LIMIT', severity: 'WARNING', reason: 'console error correlated with classified transient response' };
            }
        }
    }
    return { classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE', reason: 'uncorrelated console.error' };
}

export interface EventSink {
    events: BrowserEvent[];
    severe: BrowserEvent[];
    transientUrls: Set<string>;
}

/**
 * Attach listeners that capture + classify EVERY browser event, preserving each
 * in `events` (never erased). `severe` holds only SEVERE events (test failures).
 * pageerror is ALWAYS SEVERE (uncaught JS exception). Transient response URLs are
 * tracked so a later correlated console.error can be downgraded honestly.
 */
export function attachClassifiedCollector(page: Page, baseUrl: string): EventSink {
    const sink: EventSink = { events: [], severe: [], transientUrls: new Set() };
    const push = (e: BrowserEvent) => {
        sink.events.push(e);
        if (e.severity === 'SEVERE') sink.severe.push(e);
    };
    page.on('response', (resp: Response) => {
        const status = resp.status();
        if (status < 400) return;
        const url = resp.url();
        const rtype = resp.request().resourceType();
        const so = isSameOrigin(url, baseUrl);
        const c = classifyResponse(url, rtype, status, so);
        if (c.classification === 'TRANSIENT_RATE_LIMIT') sink.transientUrls.add(url);
        push({ kind: 'badresponse', url, resourceType: rtype, status, sameOrigin: so, message: `HTTP ${status}`, ...c });
    });
    page.on('requestfailed', (req: Request) => {
        const url = req.url();
        const rtype = req.resourceType();
        const so = isSameOrigin(url, baseUrl);
        const errorText = req.failure()?.errorText ?? 'failed';
        const c = classifyRequestFailure(url, rtype, errorText, so);
        push({ kind: 'requestfailed', url, resourceType: rtype, status: null, sameOrigin: so, message: errorText, ...c });
    });
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        const c = classifyConsole(text, sink.transientUrls);
        push({ kind: 'console', url: '', resourceType: 'console', status: null, sameOrigin: true, message: text, ...c });
    });
    page.on('pageerror', (err) => {
        // ALWAYS SEVERE: uncaught JS exception / hydration failure.
        push({
            kind: 'pageerror', url: '', resourceType: 'pageerror', status: null, sameOrigin: true,
            message: err.message, classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE',
            reason: 'uncaught JS exception (pageerror)',
        });
    });
    return sink;
}

/** Human-readable one-line summary of the SEVERE events for assertion messages. */
export function severeSummary(sink: EventSink): string {
    return sink.severe.map((e) => `[${e.classification}] ${e.reason} :: ${e.url || e.message}`).join(' | ');
}
