// tests/unit/srs2a-classifier.test.ts
//
// SRS2-HARNESS-3/4 — hermetic unit tests of the SEVERE browser-error classifier.
// Pure + offline (no Playwright runtime, no network). HARNESS-3 asserts the
// optional-telemetry CLASSIFICATION ORDER: an EXACT signature (host+path+method)
// is recognised BEFORE the generic xhr/fetch page-required rule -> NONCRITICAL,
// EXACT-MATCH ONLY, conservatism UNCHANGED (same-origin/data/script/unknown +
// telemetry+pageerror all stay SEVERE), downgrades PRESERVED + counted. HARNESS-4
// (block below) asserts the CORS-policy console.error correlation + requestfailed/
// console dedup. Cells correspond 1:1 to each spec's required case list.
import { describe, it, expect } from 'vitest';
import {
    classifyConsole,
    classifyRequestFailure,
    classifyResponse,
} from '../e2e/srs2a-classifier';
import {
    classifyCorsConsole,
    extractCorsUrl,
    isCorsConsoleText,
    isExactTelemetrySignature,
} from '../e2e/srs2a-optional-policy';
import { summarize, type ProvenanceRecord } from '../e2e/srs2a-helpers';
import type { BrowserEvent } from '../e2e/srs2a-classifier';

const CF_RUM = 'https://static.cloudflareinsights.com/cdn-cgi/rum';
const CF_RUM_BARE = 'https://cloudflareinsights.com/cdn-cgi/rum';
const GA_COLLECT = 'https://www.google-analytics.com/g/collect?v=2&tid=G-XXXX';
const SAME_ORIGIN = 'https://free2aitools.com';
const ERR = 'net::ERR_FAILED';

describe('SRS2-HARNESS-3: optional-telemetry classification ORDER', () => {
    // Case 1 — CF Insights /cdn-cgi/rum POST xhr, page asserts pass -> NONCRITICAL.
    it('1. CF Insights RUM beacon (POST xhr, cross-origin) -> NONCRITICAL_NETWORK_WARNING', () => {
        const r = classifyRequestFailure(CF_RUM, 'xhr', ERR, false, 'POST', {});
        expect(r.severity).toBe('WARNING');
        expect(r.classification).toBe('NONCRITICAL_NETWORK_WARNING');
        expect(r.reason).toMatch(/cloudflare-insights-rum/);
    });

    // Case 2 — CF Insights host but NON-/cdn-cgi/rum path -> NOT auto-downgraded.
    it('2. CF Insights host, non-RUM path -> NOT downgraded (stays SEVERE)', () => {
        const r = classifyRequestFailure('https://cloudflareinsights.com/api/data', 'xhr', ERR, false, 'POST', {});
        expect(r.severity).toBe('SEVERE');
        expect(r.classification).not.toBe('NONCRITICAL_NETWORK_WARNING');
    });

    // Case 3 — same-origin xhr failure -> SEVERE (never a telemetry beacon).
    it('3. same-origin xhr failure -> SEVERE', () => {
        const r = classifyRequestFailure(`${SAME_ORIGIN}/api/v1/search`, 'xhr', ERR, true, 'GET', {});
        expect(r.severity).toBe('SEVERE');
    });

    // Case 4 — HuggingFace / GitHub DATA xhr -> NOT auto-downgraded.
    it('4. HuggingFace/GitHub data xhr failure -> NOT downgraded (SEVERE)', () => {
        for (const u of ['https://huggingface.co/api/models', 'https://api.github.com/repos/x/y']) {
            const r = classifyRequestFailure(u, 'xhr', ERR, false, 'GET', {});
            expect(r.severity, u).toBe('SEVERE');
            expect(r.classification, u).toBe('SEVERE_PRODUCT_SIGNAL');
        }
    });

    // Case 5 — jsDelivr SCRIPT failure -> SEVERE (critical runtime lib).
    it('5. jsDelivr script failure -> SEVERE', () => {
        const r = classifyRequestFailure('https://cdn.jsdelivr.net/npm/chart.js', 'script', ERR, false, 'GET', {});
        expect(r.severity).toBe('SEVERE');
        expect(r.classification).toBe('SEVERE_PRODUCT_SIGNAL');
    });

    // Case 6 — googletagmanager SCRIPT failure is NOT a beacon -> SEVERE.
    it('6. googletagmanager SCRIPT failure -> SEVERE (not a telemetry beacon)', () => {
        const r = classifyRequestFailure('https://www.googletagmanager.com/gtag/js?id=G-X', 'script', ERR, false, 'GET', {});
        expect(r.severity).toBe('SEVERE');
        expect(r.classification).toBe('SEVERE_PRODUCT_SIGNAL');
        // A script never matches a beacon signature even on a telemetry host.
        expect(isExactTelemetrySignature('https://www.googletagmanager.com/gtag/js?id=G-X', 'script', 'GET', false).match).toBe(false);
    });

    // Case 7 — GA /collect beacon + page OK -> NONCRITICAL.
    it('7. GA /collect beacon (POST xhr) + page OK -> NONCRITICAL', () => {
        const r = classifyRequestFailure(GA_COLLECT, 'xhr', ERR, false, 'POST', {});
        expect(r.severity).toBe('WARNING');
        expect(r.classification).toBe('NONCRITICAL_NETWORK_WARNING');
        expect(r.reason).toMatch(/google-analytics-collect/);
        // GA also legitimately uses GET beacons.
        const g = classifyRequestFailure(GA_COLLECT, 'fetch', ERR, false, 'GET', {});
        expect(g.severity).toBe('WARNING');
    });

    // Case 8 — exact telemetry failure + co-occurring pageerror -> SEVERE.
    it('8. exact telemetry failure + co-occurring pageerror -> SEVERE', () => {
        const r = classifyRequestFailure(CF_RUM, 'xhr', ERR, false, 'POST', { pageErrored: true });
        expect(r.severity).toBe('SEVERE');
        expect(r.classification).toBe('SEVERE_PRODUCT_SIGNAL');
        expect(r.reason).toMatch(/pageerror/);
        // hydration failure vetoes the downgrade too.
        const h = classifyRequestFailure(CF_RUM, 'xhr', ERR, false, 'POST', { hydrationFailed: true });
        expect(h.severity).toBe('SEVERE');
    });

    // Case 9 — unknown URL net::ERR_FAILED -> SEVERE (uncorrelated/unknown).
    it('9. unknown third-party URL net::ERR_FAILED -> SEVERE', () => {
        const r = classifyRequestFailure('https://random-unknown-host.example/x', 'xhr', ERR, false, 'GET', {});
        expect(r.severity).toBe('SEVERE');
    });

    // Case 10 — a downgraded warning is still a fully-formed, preservable event.
    it('10. a downgraded telemetry warning is fully preserved (reason + classification carried)', () => {
        const r = classifyRequestFailure(CF_RUM, 'xhr', ERR, false, 'POST', {});
        // The event the collector pushes carries url/method/reason verbatim -> it
        // can be written to the artifact + counted; nothing is erased.
        expect(r.reason).toContain('beacon preserved');
        expect(r.reason).toContain('net::ERR_FAILED');
    });

    // --- ORDER + EXACT-MATCH edge proofs (signature predicate) ---
    it('signature requires cross-origin: same-origin /cdn-cgi/rum is NOT a beacon', () => {
        const r = isExactTelemetrySignature(`${SAME_ORIGIN}/cdn-cgi/rum`, 'xhr', 'POST', true);
        expect(r.match).toBe(false);
    });

    it('signature requires the exact method: CF RUM via GET does NOT match', () => {
        expect(isExactTelemetrySignature(CF_RUM, 'xhr', 'GET', false).match).toBe(false);
    });

    it('signature requires beacon-class type: CF RUM as document does NOT match', () => {
        expect(isExactTelemetrySignature(CF_RUM_BARE, 'document', 'POST', false).match).toBe(false);
    });

    it('CF RUM bare host (cloudflareinsights.com) POST xhr matches the signature', () => {
        expect(isExactTelemetrySignature(CF_RUM_BARE, 'xhr', 'POST', false).match).toBe(true);
    });

    // --- conservatism on the response path (4xx/5xx) is preserved too ---
    it('response path: same-origin document 500 -> SEVERE (telemetry order does not weaken it)', () => {
        const r = classifyResponse(`${SAME_ORIGIN}/`, 'document', 500, true, 'GET', {});
        expect(r.severity).toBe('SEVERE');
    });

    it('response path: GA /collect 405 + page OK -> NONCRITICAL; with pageerror -> SEVERE', () => {
        expect(classifyResponse(GA_COLLECT, 'xhr', 405, false, 'POST', {}).severity).toBe('WARNING');
        expect(classifyResponse(GA_COLLECT, 'xhr', 405, false, 'POST', { pageErrored: true }).severity).toBe('SEVERE');
    });

    it('response path: 429/503 stay TRANSIENT even on a telemetry host (no signature override of transient)', () => {
        expect(classifyResponse(CF_RUM, 'xhr', 503, false, 'POST', {}).classification).toBe('TRANSIENT_RATE_LIMIT');
    });
});

// SRS2-HARNESS-4 — the SAME CF Insights RUM request emits a `requestfailed`
// (net::ERR_FAILED) AND a CORS `console.error` whose URL is embedded in the TEXT.
// The CORS console URL is extracted + re-run through the EXACT telemetry signature
// and downgraded ONLY on a real match; the two raw events dedup to ONE root.
const CORS_RUM = `Access to XMLHttpRequest at '${CF_RUM_BARE}' from origin 'https://free2aitools.com' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`;
const corsText = (u: string) => `Access to XMLHttpRequest at '${u}' from origin 'https://free2aitools.com' has been blocked by CORS policy.`;
const consoleCors = (text: string, ctx = {}) => classifyConsole(text, Date.now(), [], new Set<string>(), ctx);

function netEvent(kind: BrowserEvent['kind'], url: string, sev: 'SEVERE' | 'WARNING', extra: Partial<BrowserEvent> = {}): BrowserEvent {
    return { kind, url, origin: '', resourceType: kind === 'console' ? 'cors-console' : 'xhr', method: 'POST', status: null, errorText: '', frameUrl: '', sameOrigin: false, timestamp: 1, correlated: false, message: url, classification: sev === 'WARNING' ? 'NONCRITICAL_NETWORK_WARNING' : 'SEVERE_PRODUCT_SIGNAL', severity: sev, reason: 'r', ...extra };
}
function rec(events: BrowserEvent[]): ProvenanceRecord {
    return { assertion: 'a', expected: 'e', actual: 'x', state: 'PASS', events, pass: true };
}

describe('SRS2-HARNESS-4: CORS-policy console correlation + dedup', () => {
    it('1. CF RUM CORS console text -> NONCRITICAL_NETWORK_WARNING', () => {
        const c = consoleCors(CORS_RUM);
        expect(c.severity).toBe('WARNING');
        expect(c.classification).toBe('NONCRITICAL_NETWORK_WARNING');
        expect(c.corsUrl).toBe(CF_RUM_BARE);
        expect(c.correlated).toBe(true);
    });

    it('2. requestfailed + CORS console for SAME RUM -> ONE root_network_failure (dedup)', () => {
        const s = summarize([rec([netEvent('requestfailed', CF_RUM_BARE, 'WARNING'), netEvent('console', CF_RUM_BARE, 'WARNING')])]);
        expect(s.raw_events).toBe(2); // BOTH raw events preserved
        expect(s.root_network_failures).toBe(1); // counted once by URL
    });

    it('3. unknown third-party CORS URL -> SEVERE', () => {
        const c = consoleCors(corsText('https://evil-tracker.example/beacon'));
        expect(c.severity).toBe('SEVERE');
        expect(c.classification).toBe('SEVERE_PRODUCT_SIGNAL');
    });

    it('4. same-origin API CORS -> SEVERE', () => {
        expect(consoleCors(corsText(`${SAME_ORIGIN}/api/v1/search`)).severity).toBe('SEVERE');
    });

    it('5. HuggingFace/GitHub data CORS -> SEVERE', () => {
        for (const u of ['https://huggingface.co/api/models', 'https://api.github.com/repos/x/y']) {
            expect(consoleCors(corsText(u)).severity, u).toBe('SEVERE');
        }
    });

    it('6. CF Insights NON-/cdn-cgi/rum path CORS -> SEVERE', () => {
        const c = consoleCors(corsText('https://cloudflareinsights.com/api/data'));
        expect(c.severity).toBe('SEVERE');
        expect(c.classification).not.toBe('NONCRITICAL_NETWORK_WARNING');
    });

    it('7. exact telemetry CORS + co-occurring pageerror/hydration -> SEVERE', () => {
        expect(consoleCors(CORS_RUM, { pageErrored: true }).severity).toBe('SEVERE');
        expect(consoleCors(CORS_RUM, { hydrationFailed: true }).severity).toBe('SEVERE');
    });

    it('8. CORS text with NO extractable URL -> SEVERE', () => {
        const noUrl = 'Access blocked by CORS policy: No Access-Control-Allow-Origin header.';
        expect(extractCorsUrl(noUrl)).toBeNull();
        expect(consoleCors(noUrl).severity).toBe('SEVERE');
        expect(classifyCorsConsole(noUrl).downgrade).toBe(false);
    });

    it('9. downgraded CORS warning preserved in summary + artifact (raw text + URL + match)', () => {
        const c = consoleCors(CORS_RUM);
        expect(c.reason).toContain('preserved');
        expect(c.cors).toBe(true);
        // collector pushes a WARNING carrying raw text (message) + recovered URL.
        const s = summarize([rec([netEvent('console', CF_RUM_BARE, 'WARNING', { message: CORS_RUM })])]);
        expect(s.transient_warnings).toBe(1);
        expect(s.raw_events).toBe(1);
    });

    it('10. dedup counting rule: raw_events counts BOTH, root_network_failures counts the request ONCE', () => {
        // Two DIFFERENT RUM requests x (requestfailed + CORS console) = 4 raw, 2 root.
        const u2 = 'https://static.cloudflareinsights.com/cdn-cgi/rum';
        const s = summarize([rec([
            netEvent('requestfailed', CF_RUM_BARE, 'WARNING'), netEvent('console', CF_RUM_BARE, 'WARNING'),
            netEvent('requestfailed', u2, 'WARNING'), netEvent('console', u2, 'WARNING'),
        ])]);
        expect(s.raw_events).toBe(4);
        expect(s.root_network_failures).toBe(2);
    });

    it('extractCorsUrl parses XMLHttpRequest / fetch / resource shapes', () => {
        expect(extractCorsUrl(corsText(CF_RUM_BARE))).toBe(CF_RUM_BARE);
        expect(extractCorsUrl(`Access to fetch at '${CF_RUM_BARE}' blocked`)).toBe(CF_RUM_BARE);
        expect(extractCorsUrl(`Access to resource at '${CF_RUM_BARE}' blocked`)).toBe(CF_RUM_BARE);
        expect(isCorsConsoleText(CORS_RUM)).toBe(true);
    });

    it('extracted CF RUM URL re-passes the EXACT telemetry signature (cross-origin POST xhr)', () => {
        const url = extractCorsUrl(CORS_RUM)!;
        expect(isExactTelemetrySignature(url, 'xhr', 'POST', false).match).toBe(true);
    });
});
