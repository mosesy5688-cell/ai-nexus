/**
 * SRS-1 — doc-surface verdict-vocabulary invariant (tier-1, hermetic). [D-121 / G-3]
 *
 * Extends the verdict-vocabulary lock (verdict-vocabulary.test.ts, which pins the
 * select / MCP / OpenAPI MACHINE contract) to the public DOC copy: README.md and
 * the llms.txt template. These are surfaces a caller / agent reads as capability
 * claims, so the Page Messaging Contract Section-5 FORBIDDEN verdict vocabulary
 * applies to them too. They must not (re)introduce an AFFIRMATIVE verdict
 * vocabulary for the select / rank capability.
 *
 * PERMITTED (NOT matched): the NEGATIVE disclaimer forms — "not a fit verdict",
 * "the caller decides", "does NOT … recommend", "Neither surface routes,
 * recommends, or selects on your behalf".
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
