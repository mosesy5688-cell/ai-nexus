/**
 * D-142 Lane-A — optional browser analytics removal guard.
 *
 * Founder D-142 removed the optional frontend analytics (Google Tag Manager +
 * Cloudflare Web Analytics beacon) from the shared layout. This guard locks
 * that removal at the source level so a regression that re-adds GTM, the GTM
 * noscript iframe, the GTM container id, the Cloudflare Web Analytics beacon, or
 * its data-cf-beacon token fails loudly.
 *
 * Scope note: the 6 analytics tokens may legitimately appear elsewhere in the
 * repo as classifier ALLOWLIST constants (tests/e2e/srs2a-*), unit-test FIXTURES
 * (tests/unit/srs2a-classifier.test.ts), a captured Lighthouse audit ARTIFACT
 * (tests/lighthouse/model-desktop.json), or absence-assertion tests like this
 * one. Those are not analytics loaded by our pages. This guard therefore scopes
 * the hard "must be absent" assertion to the shared layout + page sources that
 * actually emit page HTML.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const LAYOUT = read('src/layouts/Layout.astro');

// The six analytics tokens D-142 §1 requires eliminated from page output.
const ANALYTICS_TOKENS: Array<{ name: string; re: RegExp }> = [
    { name: 'GTM container id', re: /GTM-[A-Z0-9]+/ },
    { name: 'googletagmanager.com', re: /googletagmanager\.com/ },
    { name: 'google-analytics.com', re: /google-analytics\.com/ },
    { name: 'static.cloudflareinsights.com', re: /static\.cloudflareinsights\.com/ },
    { name: 'cloudflareinsights RUM', re: /cloudflareinsights\.com\/cdn-cgi\/rum/ },
    { name: 'data-cf-beacon', re: /data-cf-beacon/ },
];

describe('D-142 §1: optional analytics removed from shared layout', () => {
    for (const { name, re } of ANALYTICS_TOKENS) {
        it(`Layout.astro contains no ${name}`, () => {
            expect(LAYOUT).not.toMatch(re);
        });
    }

    it('Layout.astro has no GTM script loader / delayed loader', () => {
        expect(LAYOUT).not.toMatch(/gtm\.start|dataLayer/);
        expect(LAYOUT).not.toMatch(/gtm\.js\?id=/);
    });

    it('Layout.astro has no GTM noscript iframe', () => {
        expect(LAYOUT).not.toMatch(/<noscript>[\s\S]*googletagmanager[\s\S]*<\/noscript>/);
        expect(LAYOUT).not.toMatch(/ns\.html\?id=GTM-/);
    });

    it('Layout.astro has no Cloudflare Web Analytics beacon script', () => {
        expect(LAYOUT).not.toMatch(/beacon\.min\.js/);
    });

    it('Layout.astro makes no unsupported Do-Not-Track claim', () => {
        // No DNT detection/claim logic was ever in the layout; lock that it
        // stays absent (the only DNT *claim* lived in privacy copy, removed).
        expect(LAYOUT).not.toMatch(/doNotTrack|do[- ]not[- ]track/i);
    });
});
