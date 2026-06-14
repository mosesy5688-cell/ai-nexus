// tests/unit/srs2a-classifier.test.ts — SRS2-HARNESS-3/4/5 hermetic unit tests of
// the SEVERE browser-error classifier. Pure + offline (no Playwright, no network).
// H3: optional-telemetry CLASSIFICATION ORDER (EXACT signature BEFORE the generic
// xhr/fetch rule; conservatism UNCHANGED). H4: CORS console.error correlation +
// dedup. H5: same-origin CRITICAL asset on a CONFIRMED 429/503 -> CRITICAL_
// TRANSIENT_UNAVAILABILITY (transient precedence, page INCONCLUSIVE, never PASS,
// never a product_failure); deterministic critical failure stays SEVERE; 429 NEVER
// becomes PASS. Cells map 1:1 to each spec's required case list.
import { describe, it, expect } from 'vitest';
import { classifyConsole, classifyRequestFailure, classifyResponse } from '../e2e/srs2a-classifier';
import { classifyCorsConsole, extractCorsUrl, isCorsConsoleText, isExactTelemetrySignature } from '../e2e/srs2a-optional-policy';
import { summarize, type ProvenanceRecord } from '../e2e/srs2a-helpers';
import { buildConditions, evaluateCriticalTransient } from '../e2e/srs2a-critical-transient';
import type { BrowserEvent } from '../e2e/srs2a-classifier';

const CF_RUM = 'https://static.cloudflareinsights.com/cdn-cgi/rum';
const CF_RUM_BARE = 'https://cloudflareinsights.com/cdn-cgi/rum';
const GA_COLLECT = 'https://www.google-analytics.com/g/collect?v=2&tid=G-XXXX';
const SAME_ORIGIN = 'https://free2aitools.com';
const ERR = 'net::ERR_FAILED';

describe('SRS2-HARNESS-3: optional-telemetry classification ORDER', () => {
    it('1. CF Insights RUM beacon (POST xhr, cross-origin) -> NONCRITICAL_NETWORK_WARNING', () => {
        const r = classifyRequestFailure(CF_RUM, 'xhr', ERR, false, 'POST', {});
        expect(r.severity).toBe('WARNING');
        expect(r.classification).toBe('NONCRITICAL_NETWORK_WARNING');
        expect(r.reason).toMatch(/cloudflare-insights-rum/);
    });
    it('2. CF Insights host, non-RUM path -> NOT downgraded (stays SEVERE)', () => {
        const r = classifyRequestFailure('https://cloudflareinsights.com/api/data', 'xhr', ERR, false, 'POST', {});
        expect(r.severity).toBe('SEVERE');
        expect(r.classification).not.toBe('NONCRITICAL_NETWORK_WARNING');
    });
    it('3. same-origin xhr failure -> SEVERE', () => expect(classifyRequestFailure(`${SAME_ORIGIN}/api/v1/search`, 'xhr', ERR, true, 'GET', {}).severity).toBe('SEVERE'));
    it('4. HuggingFace/GitHub data xhr failure -> NOT downgraded (SEVERE)', () => {
        for (const u of ['https://huggingface.co/api/models', 'https://api.github.com/repos/x/y']) {
            const r = classifyRequestFailure(u, 'xhr', ERR, false, 'GET', {});
            expect(r.severity, u).toBe('SEVERE');
            expect(r.classification, u).toBe('SEVERE_PRODUCT_SIGNAL');
        }
    });
    it('5. jsDelivr script failure -> SEVERE', () => {
        const r = classifyRequestFailure('https://cdn.jsdelivr.net/npm/chart.js', 'script', ERR, false, 'GET', {});
        expect(r.severity).toBe('SEVERE');
        expect(r.classification).toBe('SEVERE_PRODUCT_SIGNAL');
    });
    it('6. googletagmanager SCRIPT failure -> SEVERE (not a telemetry beacon)', () => {
        const gtm = 'https://www.googletagmanager.com/gtag/js?id=G-X';
        const r = classifyRequestFailure(gtm, 'script', ERR, false, 'GET', {});
        expect(r.severity).toBe('SEVERE');
        expect(r.classification).toBe('SEVERE_PRODUCT_SIGNAL');
        expect(isExactTelemetrySignature(gtm, 'script', 'GET', false).match).toBe(false);
    });
    it('7. GA /collect beacon (POST xhr) + page OK -> NONCRITICAL', () => {
        const r = classifyRequestFailure(GA_COLLECT, 'xhr', ERR, false, 'POST', {});
        expect(r.severity).toBe('WARNING');
        expect(r.classification).toBe('NONCRITICAL_NETWORK_WARNING');
        expect(r.reason).toMatch(/google-analytics-collect/);
        expect(classifyRequestFailure(GA_COLLECT, 'fetch', ERR, false, 'GET', {}).severity).toBe('WARNING'); // GA GET beacon
    });
    it('8. exact telemetry failure + co-occurring pageerror/hydration -> SEVERE', () => {
        const r = classifyRequestFailure(CF_RUM, 'xhr', ERR, false, 'POST', { pageErrored: true });
        expect(r.severity).toBe('SEVERE');
        expect(r.classification).toBe('SEVERE_PRODUCT_SIGNAL');
        expect(r.reason).toMatch(/pageerror/);
        expect(classifyRequestFailure(CF_RUM, 'xhr', ERR, false, 'POST', { hydrationFailed: true }).severity).toBe('SEVERE');
    });
    it('9. unknown third-party URL net::ERR_FAILED -> SEVERE', () => expect(classifyRequestFailure('https://random-unknown-host.example/x', 'xhr', ERR, false, 'GET', {}).severity).toBe('SEVERE'));
    it('10. a downgraded telemetry warning is fully preserved (reason + classification carried)', () => {
        const r = classifyRequestFailure(CF_RUM, 'xhr', ERR, false, 'POST', {});
        expect(r.reason).toContain('beacon preserved');
        expect(r.reason).toContain('net::ERR_FAILED');
    });
    // --- ORDER + EXACT-MATCH edge proofs (signature predicate) ---
    it('signature requires cross-origin: same-origin /cdn-cgi/rum is NOT a beacon', () => expect(isExactTelemetrySignature(`${SAME_ORIGIN}/cdn-cgi/rum`, 'xhr', 'POST', true).match).toBe(false));
    it('signature requires the exact method: CF RUM via GET does NOT match', () => expect(isExactTelemetrySignature(CF_RUM, 'xhr', 'GET', false).match).toBe(false));
    it('signature requires beacon-class type: CF RUM as document does NOT match', () => expect(isExactTelemetrySignature(CF_RUM_BARE, 'document', 'POST', false).match).toBe(false));
    it('CF RUM bare host (cloudflareinsights.com) POST xhr matches the signature', () => expect(isExactTelemetrySignature(CF_RUM_BARE, 'xhr', 'POST', false).match).toBe(true));
    // --- conservatism on the response path (4xx/5xx) is preserved ---
    it('response path: same-origin document 500 -> SEVERE (telemetry order does not weaken it)', () => expect(classifyResponse(`${SAME_ORIGIN}/`, 'document', 500, true, 'GET', {}).severity).toBe('SEVERE'));
    it('response path: GA /collect 405 + page OK -> NONCRITICAL; with pageerror -> SEVERE', () => {
        expect(classifyResponse(GA_COLLECT, 'xhr', 405, false, 'POST', {}).severity).toBe('WARNING');
        expect(classifyResponse(GA_COLLECT, 'xhr', 405, false, 'POST', { pageErrored: true }).severity).toBe('SEVERE');
    });
    it('response path: 429/503 on a telemetry XHR stays TRANSIENT (no signature override)', () => expect(classifyResponse(CF_RUM, 'xhr', 503, false, 'POST', {}).classification).toBe('TRANSIENT_RATE_LIMIT'));
});

// SRS2-HARNESS-4 — the SAME CF RUM request emits a requestfailed (net::ERR_FAILED)
// AND a CORS console.error with the URL in its TEXT; extracted + re-run through the
// EXACT signature, downgraded ONLY on a real match; the two raw events dedup to ONE.
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
    it('4. same-origin API CORS -> SEVERE', () => expect(consoleCors(corsText(`${SAME_ORIGIN}/api/v1/search`)).severity).toBe('SEVERE'));
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
        const s = summarize([rec([netEvent('console', CF_RUM_BARE, 'WARNING', { message: CORS_RUM })])]);
        expect(s.transient_warnings).toBe(1);
        expect(s.raw_events).toBe(1);
    });
    it('10. dedup counting: raw_events counts BOTH, root_network_failures counts the request ONCE', () => {
        const u2 = 'https://static.cloudflareinsights.com/cdn-cgi/rum'; // 2 different RUM reqs
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
    it('extracted CF RUM URL re-passes the EXACT telemetry signature (cross-origin POST xhr)', () => expect(isExactTelemetrySignature(extractCorsUrl(CORS_RUM)!, 'xhr', 'POST', false).match).toBe(true));
});

// SRS2-HARNESS-5 cases (described above): JS_BUNDLE is the real failing same-origin
// critical bundle from run 27497914334 (free2aitools.com/assets/index.*.js).
const JS_BUNDLE = `${SAME_ORIGIN}/assets/index.Bt0wJLDL.js`;
const H429 = { 'retry-after': '3' };
function ctRecord(): ProvenanceRecord {
    const ev = netEvent('badresponse', JS_BUNDLE, 'WARNING', { resourceType: 'script', status: 429, classification: 'CRITICAL_TRANSIENT_UNAVAILABILITY' });
    return { assertion: 'detail', expected: '200', actual: '429 criticalTransient', state: 'INCONCLUSIVE_TRANSIENT', events: [ev], pass: false };
}

describe('SRS2-HARNESS-5: same-origin critical 429/503 -> CRITICAL_TRANSIENT_UNAVAILABILITY', () => {
    it('1. same-origin critical JS 429 -> CRITICAL_TRANSIENT_UNAVAILABILITY (not SEVERE, not PASS)', () => {
        const r = classifyResponse(JS_BUNDLE, 'script', 429, true, 'GET', {}, H429);
        expect(r.classification).toBe('CRITICAL_TRANSIENT_UNAVAILABILITY');
        expect(r.severity).toBe('WARNING'); // asset fine; NOT a product defect
        expect(r.criticalTransient).toBe(true);
        expect(r.reason).toMatch(/Retry-After=3/);
        expect(r.reason).toMatch(/NOT a product defect/);
    });
    it('2. same-origin critical JS 503 (+ stylesheet/font/document) -> CRITICAL_TRANSIENT_UNAVAILABILITY', () => {
        const r = classifyResponse(JS_BUNDLE, 'script', 503, true, 'GET', {}, {});
        expect(r.classification).toBe('CRITICAL_TRANSIENT_UNAVAILABILITY');
        expect(r.severity).toBe('WARNING');
        expect(r.reason).toMatch(/Retry-After=absent/);
        for (const t of ['stylesheet', 'font', 'document']) {
            expect(classifyResponse(`${SAME_ORIGIN}/a.${t}`, t, 503, true, 'GET', {}, {}).classification, t).toBe('CRITICAL_TRANSIENT_UNAVAILABILITY');
        }
    });
    it('3. same-origin critical JS 404 -> SEVERE_PRODUCT_SIGNAL (deterministic)', () => {
        const r = classifyResponse(JS_BUNDLE, 'script', 404, true, 'GET', {}, {});
        expect(r.classification).toBe('SEVERE_PRODUCT_SIGNAL');
        expect(r.severity).toBe('SEVERE');
        expect(r.criticalTransient).toBeUndefined();
    });
    it('4. same-origin critical JS deterministic 5xx (wrong-content/integrity proxy) -> SEVERE', () => {
        const r = classifyResponse(JS_BUNDLE, 'script', 500, true, 'GET', {}, {});
        expect(r.classification).toBe('SEVERE_PRODUCT_SIGNAL');
        expect(r.severity).toBe('SEVERE');
    });
    it('5. optional-telemetry 429 -> NOT critical-transient (unchanged WARNING)', () => {
        const r = classifyResponse(CF_RUM, 'xhr', 429, false, 'POST', {}, {});
        expect(r.classification).not.toBe('CRITICAL_TRANSIENT_UNAVAILABILITY');
        expect(r.severity).toBe('WARNING');
        expect(r.criticalTransient).toBeUndefined();
    });
    it('6. same-origin critical 429 WITHOUT a captured URL -> conditions NOT all met; requestfailed -> SEVERE', () => {
        const noUrl = evaluateCriticalTransient(buildConditions('', 'script', 429, true, {}));
        expect(noUrl.eligible).toBe(false);
        expect(noUrl.reason).toMatch(/exact URL not captured/);
        const rf = classifyRequestFailure('', 'script', ERR, true, 'GET', {});
        expect(rf.classification).not.toBe('CRITICAL_TRANSIENT_UNAVAILABILITY');
        expect(rf.severity).toBe('SEVERE');
    });
    it('7. CRITICAL_TRANSIENT -> clean=false + cell INCONCLUSIVE; does NOT increment product_failures', () => {
        const s = summarize([ctRecord()]);
        expect(s.critical_transients).toBe(1);
        expect(s.product_failures).toBe(0); // NEVER a product defect
        expect(s.inconclusive_transient).toBe(1);
        expect(s.inconclusive_assertions).toBe(1);
        const clean = s.inconclusive_transient === 0 && s.severe_events === 0 && s.uncorrelated_network_failures === 0 && s.critical_transients === 0;
        expect(clean).toBe(false);
    });
    it('8. conditions gate: ALL mandatory true -> eligible; deterministic artifact / cross-origin -> NOT eligible', () => {
        const ok = evaluateCriticalTransient(buildConditions(JS_BUNDLE, 'script', 429, true, H429));
        expect(ok.eligible).toBe(true);
        expect(ok.conditions.headersRecorded).toBe(true);
        const det = buildConditions(JS_BUNDLE, 'script', 429, true, {});
        det.noDeterministicArtifact = false; // a deterministic missing/broken artifact present
        expect(evaluateCriticalTransient(det).eligible).toBe(false);
        expect(evaluateCriticalTransient(buildConditions(JS_BUNDLE, 'script', 429, false, {})).eligible).toBe(false); // cross-origin
    });
    it('precedence: transient takes PRECEDENCE over "permanently broken" but 429 is NEVER PASS', () => {
        expect(classifyResponse(JS_BUNDLE, 'script', 429, true, 'GET', {}, {}).classification).toBe('CRITICAL_TRANSIENT_UNAVAILABILITY');
        expect(classifyResponse(JS_BUNDLE, 'script', 404, true, 'GET', {}, {}).severity).toBe('SEVERE');
        expect(classifyResponse(JS_BUNDLE, 'script', 429, true, 'GET', {}, {}).severity).not.toBe('SEVERE');
    });
});
