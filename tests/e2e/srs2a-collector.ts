/**
 * SRS-2A — browser-event COLLECTOR (SRS2-HARNESS-2 provenance capture).
 *
 * Attaches ALL FOUR Playwright hooks — response, requestfailed, console,
 * pageerror — and routes each event through the pure classifiers in
 * ./srs2a-classifier. Every event is PRESERVED in `events` (never erased);
 * SEVERE events are mirrored into `severe` (test failures); requestfailed events
 * are also kept in `failures` so a later bare console net::ERR_FAILED can be
 * CORRELATED by time-window + page context to recover its real URL/origin/type.
 *
 * Held in a separate file from the pure classifiers to honor the 250-line CES
 * floor. No product code, no error suppression.
 */
import type { Page, Request, Response } from '@playwright/test';
import {
    type BrowserEvent, classifyConsole, classifyRequestFailure, classifyResponse,
    isSameOrigin, originOf,
} from './srs2a-classifier';

export interface EventSink {
    events: BrowserEvent[];
    severe: BrowserEvent[];
    failures: BrowserEvent[]; // requestfailed events (correlation source)
    transientUrls: Set<string>;
    /** HARNESS-5: URLs of same-origin CRITICAL assets that hit a confirmed
     *  429/503 this run. Non-empty => the page assertion is INCONCLUSIVE_TRANSIENT
     *  (never PASS) — a transient unavailability, NOT a product defect. */
    criticalTransients: string[];
    /** SRS2-HARNESS-3: a pageerror (or hydration failure) was seen on this page.
     * Vetoes any optional-telemetry downgrade (telemetry + pageerror -> SEVERE),
     * reconciled across event order at the end of the page interaction. */
    pageErrored: boolean;
}

/**
 * Attach listeners that capture + classify EVERY browser event with full
 * provenance. `severe` holds only SEVERE events (test failures). requestfailed
 * events are kept in `failures` so a later bare console net::ERR_FAILED can be
 * correlated. pageerror is ALWAYS SEVERE (uncaught JS exception).
 */
export function attachClassifiedCollector(page: Page, baseUrl: string): EventSink {
    const sink: EventSink = { events: [], severe: [], failures: [], transientUrls: new Set(), criticalTransients: [], pageErrored: false };
    const push = (e: BrowserEvent) => {
        sink.events.push(e);
        if (e.severity === 'SEVERE') sink.severe.push(e);
    };
    const ctx = () => ({ pageErrored: sink.pageErrored });
    page.on('response', (resp: Response) => {
        const status = resp.status();
        if (status < 400) return;
        const url = resp.url();
        const req = resp.request();
        const rtype = req.resourceType();
        const so = isSameOrigin(url, baseUrl);
        // Pass the response headers so a same-origin critical 429/503 records the
        // Retry-After presence/value in its CRITICAL_TRANSIENT conditions snapshot.
        const c = classifyResponse(url, rtype, status, so, req.method(), ctx(), resp.headers());
        if (c.classification === 'TRANSIENT_RATE_LIMIT') sink.transientUrls.add(url);
        // HARNESS-5: a same-origin critical 429/503 makes the AFFECTED PAGE cell
        // INCONCLUSIVE_TRANSIENT (the spec consults sink.criticalTransients); the
        // URL is also tracked so the spec can attribute it. Both raw facts kept.
        if (c.criticalTransient) sink.criticalTransients.push(url);
        push({ kind: 'badresponse', url, origin: originOf(url), resourceType: rtype, method: req.method(), status, errorText: '', frameUrl: req.frame()?.url() ?? '', sameOrigin: so, timestamp: Date.now(), correlated: false, message: `HTTP ${status}`, ...c });
    });
    page.on('requestfailed', (req: Request) => {
        const url = req.url();
        const rtype = req.resourceType();
        const so = isSameOrigin(url, baseUrl);
        const errorText = req.failure()?.errorText ?? 'failed';
        const c = classifyRequestFailure(url, rtype, errorText, so, req.method(), ctx());
        const e: BrowserEvent = { kind: 'requestfailed', url, origin: originOf(url), resourceType: rtype, method: req.method(), status: null, errorText, frameUrl: req.frame()?.url() ?? '', sameOrigin: so, timestamp: Date.now(), correlated: false, message: errorText, ...c };
        sink.failures.push(e);
        push(e);
    });
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        const c = classifyConsole(text, Date.now(), sink.failures, sink.transientUrls, ctx());
        // SRS2-HARNESS-4 DEDUP: a CORS console.error that correlates to the SAME
        // RUM requestfailed is recorded with the recovered URL (raw text + URL
        // preserved), so the summary can merge the two raw events into ONE root
        // network failure (raw_events vs root_network_failures). Both raw events
        // stay in `events` — NO suppression.
        const url = c.cors && c.corsUrl ? c.corsUrl : '';
        push({ kind: 'console', url, origin: url ? originOf(url) : '', resourceType: c.cors ? 'cors-console' : 'console', method: '', status: null, errorText: '', frameUrl: '', sameOrigin: true, timestamp: Date.now(), message: text, classification: c.classification, severity: c.severity, reason: c.reason, correlated: c.correlated });
    });
    page.on('pageerror', (err) => {
        sink.pageErrored = true;
        reconcilePageError(sink);
        push({
            kind: 'pageerror', url: '', origin: '', resourceType: 'pageerror', method: '', status: null,
            errorText: err.message, frameUrl: '', sameOrigin: true, timestamp: Date.now(), correlated: false,
            message: err.message, classification: 'SEVERE_PRODUCT_SIGNAL', severity: 'SEVERE',
            reason: 'uncaught JS exception (pageerror)',
        });
    });
    return sink;
}

/**
 * SRS2-HARNESS-3 order-independence: a telemetry beacon failure may be captured
 * BEFORE the pageerror that vetoes its downgrade. When a pageerror arrives,
 * promote any already-downgraded optional-telemetry warning to SEVERE (telemetry
 * + pageerror -> SEVERE). The event is RE-CLASSIFIED in place, never erased, and
 * mirrored into `severe`. Idempotent: only touches NONCRITICAL telemetry beacons.
 */
function reconcilePageError(sink: EventSink): void {
    for (const e of sink.events) {
        const isTelemetryWarn = e.severity === 'WARNING'
            && e.classification === 'NONCRITICAL_NETWORK_WARNING'
            && /telemetry signature|beacon/i.test(e.reason);
        if (!isTelemetryWarn) continue;
        e.severity = 'SEVERE';
        e.classification = 'SEVERE_PRODUCT_SIGNAL';
        e.reason = `${e.reason} :: PROMOTED to SEVERE (co-occurring pageerror)`;
        if (!sink.severe.includes(e)) sink.severe.push(e);
    }
}

/** Human-readable one-line summary of the SEVERE events for assertion messages. */
export function severeSummary(sink: EventSink): string {
    return sink.severe.map((e) => `[${e.classification}] ${e.reason} :: ${e.url || e.message}`).join(' | ');
}
