import { describe, it, expect } from 'vitest';
// @ts-ignore — JS factory module, no types.
import {
    escapeXml, normalizeLastmod, lastmodIsLater, childMaxLastmod, SitemapUrlSet,
} from '../../scripts/factory/lib/sitemap-url-set.js';

// D-140 Lane S-B §8/§9 — pure URL-set primitives: deterministic dedup (C3),
// honest per-child max lastmod (C6), XML escaping (C7). Mutation proofs at the end
// MUST fail if a defect is reintroduced.

const u = (loc: string, lastmod?: string, priority = '0.4', changefreq = 'daily') =>
    ({ loc, lastmod, priority, changefreq });

describe('C7 escapeXml', () => {
    it('escapes &, <, >, " and \'', () => {
        expect(escapeXml('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    });
    it('is null/undefined safe', () => {
        expect(escapeXml(null)).toBe('');
        expect(escapeXml(undefined)).toBe('');
    });
    it('leaves clean text untouched', () => {
        expect(escapeXml('/model/owner/name-1.2')).toBe('/model/owner/name-1.2');
    });
});

describe('C3 normalizeLastmod / lastmodIsLater', () => {
    it('invalid timestamps normalize to empty sentinel', () => {
        expect(normalizeLastmod('not-a-date')).toBe('');
        expect(normalizeLastmod('')).toBe('');
        expect(normalizeLastmod(undefined)).toBe('');
    });
    it('valid timestamp normalizes to canonical Z form', () => {
        expect(normalizeLastmod('2026-06-01T00:00:00.000Z')).toBe('2026-06-01T00:00:00Z');
    });
    it('later valid beats earlier valid', () => {
        expect(lastmodIsLater('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z')).toBe(true);
        expect(lastmodIsLater('2026-06-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(false);
    });
    it('an INVALID candidate never overrides a valid retained one', () => {
        expect(lastmodIsLater('2026-01-01T00:00:00Z', 'INVALID')).toBe(false);
    });
    it('a valid candidate beats an invalid/absent retained one', () => {
        expect(lastmodIsLater('', '2026-01-01T00:00:00Z')).toBe(true);
        expect(lastmodIsLater('INVALID', '2026-01-01T00:00:00Z')).toBe(true);
    });
});

describe('C3 SitemapUrlSet deterministic dedup', () => {
    it('collapses duplicate absolute URLs to ONE entry', () => {
        const s = new SitemapUrlSet();
        s.add(u('/model/a'));
        s.add(u('/model/a'));
        s.add(u('/model/b'));
        expect(s.size).toBe(2);
    });

    it('retains the LATEST valid lastmod on collision', () => {
        const s = new SitemapUrlSet();
        s.add(u('/model/a', '2026-01-01T00:00:00Z'));
        s.add(u('/model/a', '2026-06-01T00:00:00Z'));
        s.add(u('/model/a', 'INVALID'));
        const arr = s.toSortedArray();
        expect(arr.length).toBe(1);
        expect(normalizeLastmod(arr[0].lastmod)).toBe('2026-06-01T00:00:00Z');
    });

    it('an invalid lastmod does NOT override an existing valid one', () => {
        const s = new SitemapUrlSet();
        s.add(u('/model/a', '2026-03-03T00:00:00Z'));
        s.add(u('/model/a', 'garbage'));
        expect(normalizeLastmod(s.toSortedArray()[0].lastmod)).toBe('2026-03-03T00:00:00Z');
    });

    it('a first-seen invalid lastmod is upgraded by a later valid one', () => {
        const s = new SitemapUrlSet();
        s.add(u('/model/a', 'garbage'));
        s.add(u('/model/a', '2026-03-03T00:00:00Z'));
        expect(normalizeLastmod(s.toSortedArray()[0].lastmod)).toBe('2026-03-03T00:00:00Z');
    });

    it('output order is deterministic (lexicographic) regardless of insert order', () => {
        const order = (locs: string[]) => {
            const s = new SitemapUrlSet();
            for (const l of locs) s.add(u(l));
            return s.toSortedArray().map((r: any) => r.loc);
        };
        const a = order(['/model/c', '/model/a', '/model/b']);
        const b = order(['/model/b', '/model/c', '/model/a']);
        expect(a).toEqual(b);
        expect(a).toEqual(['/model/a', '/model/b', '/model/c']);
    });

    it('STABLE hash for identical input (same input -> same serialized order)', () => {
        const build = () => {
            const s = new SitemapUrlSet();
            for (let i = 0; i < 50; i++) s.add(u(`/model/x${(i * 7) % 50}`, i % 2 ? '2026-01-0' + ((i % 9) + 1) + 'T00:00:00Z' : ''));
            return JSON.stringify(s.toSortedArray());
        };
        expect(build()).toBe(build());
    });

    it('absolute() prefixes the canonical host', () => {
        const s = new SitemapUrlSet();
        expect(s.absolute('/model/a')).toBe('https://free2aitools.com/model/a');
    });
});

describe('C6 childMaxLastmod', () => {
    it('returns the MAX valid lastmod across a child batch', () => {
        const recs = [u('/a', '2026-01-01T00:00:00Z'), u('/b', '2026-09-09T00:00:00Z'), u('/c', 'INVALID')];
        expect(childMaxLastmod(recs)).toBe('2026-09-09T00:00:00Z');
    });
    it('returns empty when no record carries a valid lastmod', () => {
        expect(childMaxLastmod([u('/a'), u('/b', 'bad')])).toBe('');
    });
});

describe('§8/§9 MUTATION PROOFS — reintroducing a defect MUST fail', () => {
    it('M1 (dedup removed): without the Map a dup would survive — set proves it does NOT', () => {
        const s = new SitemapUrlSet();
        s.add(u('/dup')); s.add(u('/dup'));
        // If dedup were removed (e.g. an array push), size would be 2. It is 1.
        expect(s.size).toBe(1);
    });
    it('M2 (first-wins timestamp regression): later valid MUST replace earlier', () => {
        const s = new SitemapUrlSet();
        s.add(u('/a', '2026-01-01T00:00:00Z'));
        s.add(u('/a', '2026-12-31T00:00:00Z'));
        // A first-wins regression would keep 2026-01-01; the C3 rule keeps the later.
        expect(normalizeLastmod(s.toSortedArray()[0].lastmod)).toBe('2026-12-31T00:00:00Z');
    });
    it('M3 (unescaped ampersand): escapeXml MUST convert & in a loc', () => {
        const raw = 'https://free2aitools.com/model/a&b';
        expect(escapeXml(raw)).toContain('&amp;');
        expect(escapeXml(raw)).not.toMatch(/&(?!amp;)/);
    });
});
