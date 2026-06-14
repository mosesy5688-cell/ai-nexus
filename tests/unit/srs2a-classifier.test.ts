// tests/unit/srs2a-classifier.test.ts
//
// SRS2-HARNESS-3 — hermetic unit test of the SEVERE browser-error classifier's
// optional-telemetry CLASSIFICATION ORDER. Pure + offline: it imports only the
// pure classifier + optional-policy modules (no Playwright runtime, no network)
// and asserts the Founder-exact contract:
//
//   - an EXACT telemetry signature (host+path+method tuple) is recognised BEFORE
//     the generic xhr/fetch page-required severity rule -> NONCRITICAL warning;
//   - the recognition is EXACT-MATCH ONLY (host-only / wrong-path / same-origin /
//     script never auto-downgrade);
//   - conservatism is UNCHANGED: same-origin xhr, data xhr, jsDelivr/GTM scripts,
//     unknown third-party failures, and telemetry+pageerror co-occurrence all
//     stay SEVERE;
//   - a downgraded warning is still PRESERVED + counted (never erased).
//
// These cells correspond 1:1 to the SRS2-HARNESS-3 spec's required case list.
import { describe, it, expect } from 'vitest';
import {
    classifyRequestFailure,
    classifyResponse,
} from '../e2e/srs2a-classifier';
import {
    isExactTelemetrySignature,
} from '../e2e/srs2a-optional-policy';

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
