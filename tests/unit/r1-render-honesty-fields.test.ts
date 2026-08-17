// tests/unit/r1-render-honesty-fields.test.ts
// R-1 RENDER-LAYER HONESTY — PART 2/2: field values, descriptions, attribution
// (D-2026-0816-436, items T4/T5/T6). Part 1 (dates / years / licenses) lives in
// tests/unit/r1-render-honesty.test.ts — split for CES Art 5.1 (<= 250 lines).
//
// Charter P2 (No Fake Density). Forensics census over live pages:
//   F4 literal "null" rendered as a value ......... 264/293 pages
//      (keys: architecture, params billions, context length, stars, forks)
//   F6 templated "Deep dive into X." description .. 155/155 non-paper pages
//   T6 "Community" empty-record shell ............. 17/293 pages
//
// D-436 correction 2 (SYMMETRY): unknown and measured-zero are two DISTINCT
// honest states. Suppressing "null" must NOT reclassify a real 0 (downloads=0,
// stars=0) as "no data" — that would trade one lie for another.
//
// Every it() below is a MUTATION PIN: restoring the fallback it names turns the
// test RED (verified by byte-exact restore of the original code).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
    isKnown, knownText, honestAuthor, registryEntryDescription
} from '../../src/utils/honest-render.ts';
// @ts-ignore - JS ESM render helpers; imported for their runtime contract.
import { extractAuthor } from '../../src/utils/entity-utils.js';
// @ts-ignore
import { getQuickInsights } from '../../src/utils/insight-engine.js';

const ROOT = path.resolve(__dirname, '../..');
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FULLMETA = 'src/components/entity/FullMetadata.astro';
const HELPERS = 'src/utils/model-page-helpers.ts';
const PAGES = ['model', 'dataset', 'tool', 'paper', 'benchmark']
    .map(t => `src/pages/${t}/[...slug].astro`);

// ───────────────────────── T4 — literal "null" + zero symmetry ─────────────────
describe('T4 unknown omits; measured zero still renders', () => {
    it('PIN: FullMetadata never prints the word null as a value', () => {
        const s = src(FULLMETA);
        expect(s).not.toContain('italic">null</span>');
        expect(s).not.toContain('entity[f] !== undefined');
        expect(s).toContain('group.fields.filter(f => isKnown(entity[f]))');
    });

    it('isKnown treats absence as unknown', () => {
        for (const v of [null, undefined, '', '  ', 'null', 'NULL', 'undefined',
                         'None', 'NaN', 'n/a', '-', []]) {
            expect(isKnown(v as unknown), JSON.stringify(v)).toBe(false);
        }
    });

    it('SYMMETRY (D-436 correction 2): measured zero is DATA, not absence', () => {
        expect(isKnown(0)).toBe(true);            // downloads = 0
        expect(isKnown(-0)).toBe(true);
        expect(isKnown('0')).toBe(true);          // stars = "0"
        expect(isKnown(false)).toBe(true);        // vram_is_estimated = false
        expect(isKnown('MIT')).toBe(true);
        expect(isKnown(['a'])).toBe(true);
    });

    it('SYMMETRY: a zero-valued metric field survives the FullMetadata filter', () => {
        // Mirrors the component's own predicate over a real Engagement row.
        const entity: Record<string, unknown> = {
            downloads: 0, stars: 0, forks: null, likes: undefined, citations: 12
        };
        const kept = ['likes', 'downloads', 'stars', 'forks', 'citations']
            .filter(f => isKnown(entity[f]));
        expect(kept).toEqual(['downloads', 'stars', 'citations']);
    });

    it('knownText returns real text only', () => {
        expect(knownText('  MIT  ')).toBe('MIT');
        expect(knownText('null')).toBeNull();
        expect(knownText(null)).toBeNull();
        expect(knownText(0)).toBe('0');           // measured zero survives
    });
});

// ───────────────────────── T5 — templated meta description ─────────────────────
describe('T5 typed honest description replaces the "Deep dive" template', () => {
    it('PIN: no entity page ships the "Deep dive into X." template', () => {
        for (const p of PAGES) {
            expect(src(p), p).not.toContain('Deep dive into ${');
        }
        expect(src('src/pages/benchmark/[...slug].astro'))
            .not.toContain('as measured by Open LLM Leaderboard v2.`');
    });

    it('the replacement states what the page IS, without claiming content', () => {
        const d = registryEntryDescription('model', 'Qwen3 Embedding');
        expect(d).toBe('Registry entry for model Qwen3 Embedding; source metadata pending.');
        expect(d).not.toMatch(/deep dive/i);
        // It must not assert absence of data either — it reports metadata state only.
        expect(d).not.toMatch(/no data|not available|unknown/i);
    });

    it('the honest description degrades without emitting null/undefined text', () => {
        const d = registryEntryDescription('', null as unknown as string);
        expect(d).not.toMatch(/null|undefined/);
    });

    it('a real description/abstract still wins over the honest form', () => {
        for (const p of PAGES) {
            expect(src(p), p).toContain('seo_summary?.description ||');
        }
    });
});

// ───────────────────────── T6 — "Community" pseudo-author ──────────────────────
describe('T6 no fabricated author/organisation', () => {
    it('PIN: the JSON-LD Community organisation is gone', () => {
        const s = src(HELPERS);
        expect(s).not.toContain('"name": "Community"');
        expect(s).toContain('honestAuthor(prompt.author)');
    });

    it('PIN: no render surface substitutes a Community byline', () => {
        const surfaces = [
            'src/components/entity/EntityHeader.astro',
            'src/components/entity/EntityStickyHeader.astro',
            'src/components/common/CatalogCard.astro',
            'src/components/model-detail/SimilarModels.astro',
            'src/components/ModelInfoTable.astro',
            'src/utils/entity-utils.js',
            ...PAGES
        ];
        for (const f of surfaces) {
            const s = src(f);
            expect(s, f).not.toContain("'Independent / Community'");
            expect(s, f).not.toContain("|| 'Community'");
            expect(s, f).not.toContain("'Research Community'");
            expect(s, f).not.toContain("'Community / Independent'");
        }
    });

    it('honestAuthor rejects producer placeholders as attribution', () => {
        for (const v of ['Community', 'community', 'Unknown', 'Independent / Community',
                         'Research Community', 'Free2AITools Contributors', 'anonymous',
                         '', null, undefined]) {
            expect(honestAuthor(v as unknown), String(v)).toBeNull();
        }
    });

    it('honestAuthor keeps real attribution and honours candidate order', () => {
        expect(honestAuthor('Meta AI')).toBe('Meta AI');
        expect(honestAuthor(null, 'Vaswani')).toBe('Vaswani');
        expect(honestAuthor('Unknown', 'Google DeepMind')).toBe('Google DeepMind');
        expect(honestAuthor('  Mistral  ')).toBe('Mistral');
    });
});

// ───── T6 / gate-2 R-1-F1 — extractAuthor must not mint a byline ──────────────
describe('R-1-F1 extractAuthor derives or returns null, never a literal', () => {
    it('PIN: the "Open Source" fallback literal is gone from extractAuthor', () => {
        const s = src('src/utils/entity-utils.js');
        expect(s).not.toContain("return fallbackAuthor || 'Open Source'");
        expect(s).not.toContain("return 'Open Source'");
    });

    it('BEHAVIOUR: an id with no org/name shape yields null, not a byline', () => {
        // Every paper id has this shape, so this was the dominant path.
        expect(extractAuthor('arxiv-paper--unknown--003ca99a387b03dacd154b23a0', '')).toBeNull();
        expect(extractAuthor('civitai-model--12345', '')).toBeNull();
        expect(extractAuthor('', '')).toBeNull();
        expect(extractAuthor(null, null)).toBeNull();
    });

    it('BEHAVIOUR: a derivable org is still derived, and a real author still wins', () => {
        expect(extractAuthor('hf-model--meta-llama/llama-3', '')).toBe('meta-llama');
        expect(extractAuthor('hf-model--x/y', 'Mistral AI')).toBe('Mistral AI');
    });

    it('BELT: honestAuthor also rejects the token if a producer emits it', () => {
        expect(honestAuthor('Open Source')).toBeNull();
        expect(honestAuthor('open source')).toBeNull();
    });

    it('PIN: the client search-results byline is conditional, not defaulted', () => {
        const s = src('src/scripts/search-ui-controller.js');
        expect(s).not.toContain("item.author || 'Open Source'");
        expect(s).toContain('item.author ? ');   // conditional, not a defaulted byline
    });
});

// ───── T6 / gate-2 R-1-F2 — the constant "Capability" verdict ─────────────────
describe('R-1-F2 no verification verdict without verification', () => {
    it('PIN: the Capability insight keyed on `verified` is removed', () => {
        const s = src('src/utils/insight-engine.js');
        expect(s).not.toContain("label: 'Capability'");
        expect(s).not.toContain("entity.verified ? 'Verified' : 'Community'");
    });

    it('BEHAVIOUR: an agent gets no Capability tile at all', () => {
        for (const e of [{ stars: 10 }, { stars: 10, verified: true }, {}]) {
            const labels = getQuickInsights(e, 'agent').map((i: any) => i.label);
            expect(labels).not.toContain('Capability');
        }
    });

    it('BEHAVIOUR: no agent insight carries a fabricated "Community" value', () => {
        const values = getQuickInsights({ stars: 10 }, 'agent').map((i: any) => i.value);
        expect(values).not.toContain('Community');
    });
});
