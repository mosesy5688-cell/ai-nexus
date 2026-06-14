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
}

/**
 * Attach listeners that capture + classify EVERY browser event with full
 * provenance. `severe` holds only SEVERE events (test failures). requestfailed
 * events are kept in `failures` so a later bare console net::ERR_FAILED can be
 * correlated. pageerror is ALWAYS SEVERE (uncaught JS exception).
 */
export function attachClassifiedCollector(page: Page, baseUrl: string): EventSink {
    const sink: EventSink = { events: [], severe: [], failures: [], transientUrls: new Set() };
    const push = (e: BrowserEvent) => {
        sink.events.push(e);
        if (e.severity === 'SEVERE') sink.severe.push(e);
    };
    page.on('response', (resp: Response) => {
        const status = resp.status();
        if (status < 400) return;
        const url = resp.url();
        const req = resp.request();
        const rtype = req.resourceType();
        const so = isSameOrigin(url, baseUrl);
        const c = classifyResponse(url, rtype, status, so);
        if (c.classification === 'TRANSIENT_RATE_LIMIT') sink.transientUrls.add(url);
        push({ kind: 'badresponse', url, origin: originOf(url), resourceType: rtype, method: req.method(), status, errorText: '', frameUrl: req.frame()?.url() ?? '', sameOrigin: so, timestamp: Date.now(), correlated: false, message: `HTTP ${status}`, ...c });
    });
    page.on('requestfailed', (req: Request) => {
        const url = req.url();
        const rtype = req.resourceType();
        const so = isSameOrigin(url, baseUrl);
        const errorText = req.failure()?.errorText ?? 'failed';
        const c = classifyRequestFailure(url, rtype, errorText, so);
        const e: BrowserEvent = { kind: 'requestfailed', url, origin: originOf(url), resourceType: rtype, method: req.method(), status: null, errorText, frameUrl: req.frame()?.url() ?? '', sameOrigin: so, timestamp: Date.now(), correlated: false, message: errorText, ...c };
        sink.failures.push(e);
        push(e);
    });
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        const c = classifyConsole(text, Date.now(), sink.failures, sink.transientUrls);
        push({ kind: 'console', url: '', origin: '', resourceType: 'console', method: '', status: null, errorText: '', frameUrl: '', sameOrigin: true, timestamp: Date.now(), message: text, ...c });
    });
    page.on('pageerror', (err) => {
        push({
            kind: 'pageerror', url: '', origin: '', resourceType: 'pageerror', method: '', status: null,
            errorText: err.message, frameUrl: '', sameOrigin: true, timestamp: Date.now(), correlated: false,
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
