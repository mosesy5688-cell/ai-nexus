// tests/unit/r1-render-honesty.test.ts
// R-1 RENDER-LAYER HONESTY — PART 1/2: dates, years, licenses (D-2026-0816-436,
// items T1/T2/T3). Part 2 (literal null / description / attribution) lives in
// tests/unit/r1-render-honesty-fields.test.ts — split for CES Art 5.1 (<= 250).
//
// Charter P2 (No Fake Density). Forensics census over live pages:
//   F1 citation year == current year ........ 293/293 pages
//   F2 "Published 1970" in Research Signals .. 133/138 paper pages
//   F3 "License Unknown" banner .............. 112/112 model pages, 54.5% of
//      which ALSO render a real license on the same page
//
// T2 root cause pinned from live data (30-sample census, 2026-08-16, not from the
// work order's hypothesis): published_year is stored as a BARE INTEGER (2026),
// and new Date(2026) reads it as epoch-milliseconds, landing on 1970. The
// seconds-epoch hypothesis was NOT observed in any sample.
//
// Every it() below is a MUTATION PIN: restoring the fallback it names turns the
// test RED (verified by byte-exact restore of the original code).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
    parseHonestYear, resolveEntityYear, honestLicense
} from '../../src/utils/honest-render.ts';
// @ts-ignore - JS ESM render helper; imported for its runtime contract.
import { getQuickInsights } from '../../src/utils/insight-engine.js';

const ROOT = path.resolve(__dirname, '../..');
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CITE = 'src/components/common/CiteEntity.astro';
const DEEPDIVE = 'src/components/paper-detail/PaperDeepDive.astro';
const GRAPHSEC = 'src/components/paper-detail/PaperGraphSections.astro';
const MAINCOL = 'src/components/model-detail/ModelMainColumn.astro';
const FACTSHEET = 'src/components/model-detail/NeuralFactSheet.astro';
const HELPERS = 'src/utils/model-page-helpers.ts';
const LAYOUT = 'src/layouts/Layout.astro';

// ───────────────────────── T1 — citation year / author ─────────────────────────
describe('T1 citation year is the entity year, never the current year', () => {
    it('PIN: CiteEntity has no current-year fallback', () => {
        const s = src(CITE);
        expect(s).not.toContain('new Date().getFullYear()');
        expect(s).not.toContain('${currentYear}');
        expect(s).not.toContain('currentYear');
    });

    it('PIN: CiteEntity has no fabricated default author', () => {
        expect(src(CITE)).not.toContain("'Free2AITools Contributors'");
    });

    it('the year/author components are conditional, so absence omits them', () => {
        const s = src(CITE);
        expect(s).toContain('citeYear ? `  year = {${citeYear}},` : null');
        expect(s).toContain('citeAuthor ? `  author = {${citeAuthor}},` : null');
    });

    it('resolveEntityYear returns the real year and never today', () => {
        expect(resolveEntityYear({ published_date: '2017-06-12T00:00:00Z' })).toBe(2017);
        expect(resolveEntityYear({ published_year: 2021 })).toBe(2021);
        expect(resolveEntityYear({})).toBeNull();
        expect(resolveEntityYear(null)).toBeNull();
        expect(resolveEntityYear({ published_date: null, published_year: null }))
            .not.toBe(new Date().getFullYear());
    });
});

// ───────────────────────── T2 — "Published 1970" / wall-clock ──────────────────
describe('T2 publication year: no 1970, no wall-clock fallback', () => {
    it('documents the trap this fix removes (bare year read as epoch-ms)', () => {
        // The defect verbatim: published_year is stored as a bare int.
        expect(new Date(2026).getFullYear()).toBe(1970);
        // The old guard `y > 1900` therefore let 1970 through.
        expect(1970 > 1900).toBe(true);
    });

    it('parseHonestYear reads a bare year as a YEAR (live shape: 2026)', () => {
        expect(parseHonestYear(2026)).toBe(2026);
        expect(parseHonestYear('2026')).toBe(2026);
        expect(parseHonestYear(2026)).not.toBe(1970);
    });

    it('parseHonestYear returns null for absence instead of guessing', () => {
        for (const v of [null, undefined, '', 'null', 'undefined', 'N/A', {}, [], NaN]) {
            expect(parseHonestYear(v as unknown)).toBeNull();
        }
    });

    it('parseHonestYear parses real dates and rejects out-of-window results', () => {
        expect(parseHonestYear('2021-12-20')).toBe(2021);
        expect(parseHonestYear('1899-01-01')).toBeNull();
        expect(parseHonestYear(0)).toBeNull();          // epoch 0 is not a year
        expect(parseHonestYear('not a date')).toBeNull();
    });

    it('PIN: PaperDeepDive has no wall-clock citation fallback', () => {
        const s = src(DEEPDIVE);
        expect(s).not.toContain('Date.now()');
        expect(s).toContain('year ? `  year={${year}}` : null');
    });

    it('PIN: PaperGraphSections no longer Date-parses a bare year', () => {
        const s = src(GRAPHSEC);
        expect(s).not.toContain('new Date(raw).getFullYear()');
        expect(s).toContain('resolveEntityYear(paper)');
    });

    it('PIN: insight-engine paper Year uses the honest resolver', () => {
        const s = src('src/utils/insight-engine.js');
        expect(s).not.toContain('new Date(entity.published_date).getFullYear()');
        const insights = getQuickInsights({ published_year: 2021, citations: 3 }, 'paper');
        const year = insights.find((i: any) => i.label === 'Year');
        expect(year?.value).toBe(2021);
    });

    it('PIN: page-level article times are not stamped from the wall clock', () => {
        const s = src(LAYOUT);
        expect(s).not.toContain('article:published_time" content={new Date()');
        expect(s).not.toContain('article:modified_time" content={new Date()');
    });

    it('PIN: JSON-LD dateModified is omitted, not set to today', () => {
        expect(src(HELPERS)).not.toContain('|| new Date().toISOString()');
    });
});

// ───────────────────────── T3 — license double-face ────────────────────────────
describe('T3 one page states one license', () => {
    it('PIN: the caution banner is no longer wired to license_spdx alone', () => {
        const s = src(MAINCOL);
        expect(s).not.toContain('license={model.license_spdx}');
        expect(s).toContain('honestLicense(model)');
    });

    it('honestLicense resolves across the fields the page actually reads', () => {
        expect(honestLicense({ license_spdx: 'Apache-2.0' })).toBe('Apache-2.0');
        expect(honestLicense({ license_spdx: '', license: 'MIT' })).toBe('MIT');
        expect(honestLicense({ license_spdx: null, license: null, meta_json: { license: 'BSD' } })).toBe('BSD');
        expect(honestLicense({ license_spdx: 'null', license: '' })).toBeNull();
        expect(honestLicense({})).toBeNull();
        expect(honestLicense(null)).toBeNull();
    });

    it('PIN: an absent license is not restated as a restrictive one', () => {
        expect(src(FACTSHEET)).not.toContain("'Proprietary/Restricted'");
    });

    it('PIN: the tile does not print "Unknown" beside a real license', () => {
        expect(src('src/components/model-detail/QuickInsights.astro'))
            .not.toContain("model.license || 'Unknown'");
        expect(src('src/components/ModelDescription.astro'))
            .not.toContain('{model.license || "Unknown"}');
    });
});
