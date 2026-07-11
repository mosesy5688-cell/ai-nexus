/**
 * SRS-1 -- SDK/developer-docs publication-honesty invariant (tier-1, hermetic).
 *
 * DOC-PUB-HONESTY-S1 (Founder D-2026-0711-317, Stage-3 S1). A durable
 * DOCUMENTATION-CONTRACT guard, NOT a behavior test. Pins two public developer
 * surfaces to the currently-implemented publication truth:
 *   - packages/sdk/README.md
 *   - src/pages/developers.astro
 *
 * FACT: `@free2aitools/sdk@0.1.0` is genuinely published on npm. The README
 * therefore MUST state "available on npm" and MUST NOT carry the retired
 * pre-publication wording ("not yet published" / "not on npm" / "npm publish has
 * not been performed" / "available once published"). Neither surface may inflate
 * the honest present-tense truth into a PUBLIC over-claim (GA / generally
 * available / production-proven / provenance-attested / CI-provenance / used-by-
 * Agents / trusted-by-Agents / widely-adopted / default-integration / an
 * autonomous router-that-selects-decides / any external-integration or adoption
 * count).
 *
 * MATCHING: exact phrases or word-boundary regexes only -- never an
 * indiscriminate case-insensitive substring (a bare "ga" false-positives on
 * "package"/"engage", so the GA acronym is matched case-sensitively at a word
 * boundary). Honest NEGATIVE contracts ("does not route, select, or decide") are
 * intentionally NOT matched -- only positive marketing slugs are.
 *
 * NON-CIRCULAR: every assertion reads the real product SOURCE files; the phrase
 * patterns are test literals, never values re-derived from those same files.
 *
 * HERMETIC: reads SOURCE only. No live fetch. Deterministic across runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const README_REL = 'packages/sdk/README.md';
const DEVELOPERS_REL = 'src/pages/developers.astro';

const readme = read(README_REL);
const developers = read(DEVELOPERS_REL);

// --- Stale pre-publication wording (README) -----------------------------
// These are the exact retired claims. After publication each MUST be gone.
const STALE_README_PHRASES: ReadonlyArray<readonly [string, RegExp]> = [
    ['not yet published', /\bnot\s+yet\s+published\b/i],
    ['not on npm', /\bnot\s+(?:yet\s+)?on\s+npm\b/i],
    ['npm publish has not been performed', /npm\s+publish\b[\s\S]{0,60}?\bnot\s+been\s+performed\b/i],
    ['has not been performed', /\bhas\s+not\s+been\s+performed\b/i],
    ['available once published', /\b(?:available\s+)?once\s+published\b/i],
];

// --- Forbidden PUBLIC over-claims (README + developers.astro) ------------
// Positive marketing/adoption claims only. Word-boundary matched. The GA
// acronym is CASE-SENSITIVE (bare lowercase "ga" would false-positive on
// "package"/"engage"); everything else is case-insensitive but bounded.
const FORBIDDEN_CLAIMS: ReadonlyArray<readonly [string, RegExp]> = [
    ['generally available', /\bgenerally\s+available\b/i],
    ['GA (acronym)', /\bGA\b/], // case-sensitive on purpose
    ['production-proven', /\bproduction[-\s]proven\b/i],
    ['provenance-attested', /\bprovenance[-\s]attested\b/i],
    ['CI-provenance', /\bCI[-\s]provenance\b/i],
    ['used by Agents', /\bused\s+by\s+agents?\b/i],
    ['trusted by Agents', /\btrusted\s+by\s+agents?\b/i],
    ['widely adopted', /\bwidely\s+adopted\b/i],
    ['default integration', /\bdefault\s+integration\b/i],
    ['Route-Real', /\bRoute-Real\b/i],
    ['routes-selects-decides slug', /routes-selects-decides/i],
    // adoption / external-integration COUNT claims (two shapes)
    ['adoption count "X by N"', /\b(?:trusted|used|relied|adopted|deployed)\s+by\s+(?:over\s+|more\s+than\s+|nearly\s+|about\s+)?[\d,]+/i],
    ['adoption count "N nouns verb"', /\b[\d,]+\+?\s+(?:agents?|integrations?|customers?|companies|organizations?)\s+(?:use|trust|rely|adopted|integrated|depend)\b/i],
];

describe('SRS-1 DOC-PUB-HONESTY-S1: SDK README publication wording', () => {
    it('README exists and is non-empty', () => {
        expect(readme.length).toBeGreaterThan(0);
    });

    it('states the SDK is available on npm', () => {
        expect(readme).toMatch(/\bavailable on npm\b/i);
    });

    it('provides the npm install command', () => {
        expect(readme).toMatch(/npm\s+install\s+@free2aitools\/sdk/);
    });

    for (const [label, re] of STALE_README_PHRASES) {
        it(`does NOT carry stale pre-publication wording: "${label}"`, () => {
            expect(readme).not.toMatch(re);
        });
    }
});

describe('SRS-1 DOC-PUB-HONESTY-S1: developers.astro truthful npm wording', () => {
    it('preserves the truthful "available on npm" claim', () => {
        expect(developers).toMatch(/\bavailable on npm\b/i);
    });

    it('references the published package name @free2aitools/sdk', () => {
        expect(developers).toMatch(/@free2aitools\/sdk/);
    });
});

describe('SRS-1 DOC-PUB-HONESTY-S1: no PUBLIC over-claims on either surface', () => {
    const surfaces: ReadonlyArray<readonly [string, string]> = [
        [README_REL, readme],
        [DEVELOPERS_REL, developers],
    ];

    for (const [name, src] of surfaces) {
        for (const [label, re] of FORBIDDEN_CLAIMS) {
            it(`${name}: no forbidden claim "${label}"`, () => {
                expect(src).not.toMatch(re);
            });
        }
    }
});

// --- Anti-vacuity: the forbidden-claim matcher actually bites -----------
// Proves the guard is not a no-op: a synthetic over-claim string trips at
// least one forbidden pattern, while honest present-tense wording does not.
describe('SRS-1 DOC-PUB-HONESTY-S1: forbidden-claim matcher is non-vacuous', () => {
    const hits = (text: string) => FORBIDDEN_CLAIMS.filter(([, re]) => re.test(text)).length;

    it('a synthetic over-claim trips the matcher', () => {
        const synthetic =
            'The SDK is now GA and generally available: production-proven, ' +
            'provenance-attested, widely adopted, and trusted by Agents as the ' +
            'default integration, used by 4,200 companies.';
        expect(hits(synthetic)).toBeGreaterThan(0);
    });

    it('honest present-tense wording trips NOTHING', () => {
        const honest =
            '@free2aitools/sdk is available on npm (version 0.1.0). Install it ' +
            'with npm install @free2aitools/sdk. It retrieves candidates and ' +
            'evidence; the caller does not route, select, or decide via a router.';
        expect(hits(honest)).toBe(0);
    });

    it('the GA acronym guard ignores the substring "ga" inside words', () => {
        // Guards the word-boundary requirement: "package"/"engage" must NOT match.
        expect(hits('This npm package lets agents engage the catalog.')).toBe(0);
    });
});
