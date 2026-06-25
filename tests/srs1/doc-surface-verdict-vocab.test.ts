/**
 * SRS-1 — doc-surface honesty invariants (tier-1, hermetic). [D-121 / D-122]
 *
 * G-3 (verdict vocabulary): extends the verdict-vocabulary lock
 * (verdict-vocabulary.test.ts, which pins the select / MCP / OpenAPI MACHINE
 * contract) to the public DOC copy: README.md and the llms.txt template. These
 * are surfaces a caller / agent reads as capability claims, so the Page Messaging
 * Contract Section-5 FORBIDDEN verdict vocabulary applies to them too. They must
 * not (re)introduce an AFFIRMATIVE verdict vocabulary for the select / rank
 * capability.
 *   PERMITTED (NOT matched): the NEGATIVE disclaimer forms — "not a fit verdict",
 *   "the caller decides", "does NOT … recommend", "Neither surface routes,
 *   recommends, or selects on your behalf".
 *
 * A-1 (adoption / directory presence): the README Smithery reference may be a
 * PLAIN directory link only (lowest evidence tier — listing presence). A
 * graphical badge or any derived metric is FORBIDDEN (a badge reads as an
 * adoption signal; the Core Authority Register records adoption as NOT PROVEN).
 *
 * HERMETIC: reads repo SOURCE only. No live fetch. Deterministic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const README = read('README.md');
const LLMS = read('src/data/llms-template.txt');

// Forbidden AFFIRMATIVE verdict vocabulary (Page Messaging Contract Sec 5).
const RANKED_RECS = /ranked\s+recommendations?/i; // "ranked recommendations" (stale README copy)
const BEST_AI_MODEL = /\bbest\s+ai\s+model\b/i;
const CONFIDENCE_TOKEN = /confidence/i;
const RATIONALE = /\brationale\b/i; // rationale-as-capability

describe('SRS-1 G-3 (D-121): README + llms-template carry NO affirmative verdict vocabulary', () => {
    for (const [name, src] of [
        ['README.md', README],
        ['llms-template.txt', LLMS],
    ] as const) {
        it(`${name}: no "ranked recommendations" verdict phrasing`, () => {
            expect(src).not.toMatch(RANKED_RECS);
        });
        it(`${name}: no "best AI model" verdict claim`, () => {
            expect(src).not.toMatch(BEST_AI_MODEL);
        });
        it(`${name}: no synthetic "confidence" verdict scalar`, () => {
            expect(src).not.toMatch(CONFIDENCE_TOKEN);
        });
        it(`${name}: no "rationale"-as-capability token`, () => {
            expect(src).not.toMatch(RATIONALE);
        });
        it(`${name}: any "recommend" occurrence is negated (disclaimer only)`, () => {
            let idx = src.toLowerCase().indexOf('recommend');
            while (idx > -1) {
                const ctx = src.slice(Math.max(0, idx - 40), idx + 12).toLowerCase();
                expect(ctx, `"recommend" in ${name} must be negated`).toMatch(/\b(not|no|never|neither)\b/);
                idx = src.toLowerCase().indexOf('recommend', idx + 1);
            }
        });
    }

    it('README select example uses the honest "FNI-ranked catalog entries … fni_summary" form', () => {
        // Positive presence: the migrated wording is in place (catches a silent
        // revert to the stale copy that the absence checks alone would miss).
        expect(README).toMatch(/FNI-ranked catalog entries/);
        expect(README).toMatch(/not a fit verdict/i);
    });
});

describe('SRS-1 A-1 (D-122): README Smithery = plain directory link only, no badge/metric', () => {
    it('contains NO Smithery IMAGE badge (no markdown image whose URL has smithery + badge)', () => {
        // Markdown image form: ![alt](url). Fail if any image URL references a
        // smithery badge endpoint.
        const imageBadge = /!\[[^\]]*\]\([^)]*smithery[^)]*badge[^)]*\)/i;
        expect(README).not.toMatch(imageBadge);
        // Also fail on the bare smithery/badge endpoint host (defensive).
        expect(README).not.toMatch(/smithery\.ai\/badge\//i);
    });

    it('DOES allow a plain Smithery directory TEXT link (listing presence only)', () => {
        // Plain link form: [text](https://smithery.ai/servers/...). Present + not an image.
        const plainLink = /\[[^\]]*\]\(https:\/\/smithery\.ai\/servers\/[^)]+\)/i;
        expect(README).toMatch(plainLink);
        // The plain link must not be preceded by '!' (which would make it an image).
        const m = README.match(/(.)\[[^\]]*\]\(https:\/\/smithery\.ai\/servers\//);
        if (m) expect(m[1]).not.toBe('!');
    });

    it('carries NO adoption / endorsement framing anywhere in the README', () => {
        expect(README).not.toMatch(/\bused by\b/i);
        expect(README).not.toMatch(/\btrusted by\b/i);
        expect(README).not.toMatch(/\bverified integration\b/i);
        // No uptime / health percentage claim near the listing or elsewhere.
        expect(README).not.toMatch(/\d+(?:\.\d+)?\s*%\s*(uptime|health)/i);
        expect(README).not.toMatch(/\b(uptime|health)\b[^.\n]{0,20}\d+(?:\.\d+)?\s*%/i);
    });
});
