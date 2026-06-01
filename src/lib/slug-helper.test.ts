import { describe, it, expect } from 'vitest';
import { generatePaperCandidates } from './slug-helper.js';

// V27.100: category-tail arxiv recovery. getRouteFromId's paper branch is lossy
// (`arxiv--cs--<id>` -> URL `/paper/cs.<id>` -> bare `cs.<id>`), so the plain
// `arxiv--cs.<id>` candidate never matches the stored `arxiv--cs--<id>`. We add
// a category-boundary-dot reversal candidate `arxiv--<cat>--<id>` so the ~2,972
// previously-unroutable category-tail papers resolve, WITHOUT mis-detecting a
// normal numeric-lead arxiv id as a category-tail.

describe('generatePaperCandidates category-tail recovery', () => {
    it('recovers a simple category tail (cs.<new-id>)', () => {
        const c = generatePaperCandidates('cs.9999.99999');
        expect(c).toContain('arxiv--cs--9999.99999');
        // existing candidates preserved
        expect(c).toContain('arxiv--cs.9999.99999');
        expect(c).toContain('cs.9999.99999');
        expect(c).toContain('unknown--cs.9999.99999');
    });

    it('recovers a hyphenated category tail (cmp-lg.<new-id>)', () => {
        const c = generatePaperCandidates('cmp-lg.9999.99999');
        expect(c).toContain('arxiv--cmp-lg--9999.99999');
    });

    it('recovers multi-hyphen categories (cond-mat, q-bio, quant-ph)', () => {
        expect(generatePaperCandidates('cond-mat.9999.99999'))
            .toContain('arxiv--cond-mat--9999.99999');
        expect(generatePaperCandidates('q-bio.9999.99999'))
            .toContain('arxiv--q-bio--9999.99999');
        expect(generatePaperCandidates('quant-ph.9999.99999'))
            .toContain('arxiv--quant-ph--9999.99999');
    });

    it('recovers an old-style 7-digit category tail (cs.0501001)', () => {
        const c = generatePaperCandidates('cs.0501001');
        expect(c).toContain('arxiv--cs--0501001');
    });
});

describe('generatePaperCandidates no mis-detection', () => {
    it('does NOT emit a category form for a normal numeric-lead arxiv id', () => {
        const c = generatePaperCandidates('2604.22294');
        // exactly the three legacy candidates, no bogus arxiv--2604--... form
        expect(c.sort()).toEqual(
            ['2604.22294', 'arxiv--2604.22294', 'unknown--2604.22294'].sort()
        );
        expect(c.some(x => x.startsWith('arxiv--2604--'))).toBe(false);
    });

    it('does NOT emit a category form for another normal new-style id', () => {
        const c = generatePaperCandidates('2307.01952');
        expect(c.sort()).toEqual(
            ['2307.01952', 'arxiv--2307.01952', 'unknown--2307.01952'].sort()
        );
    });

    it('leaves a bare content-hash sha unchanged (no false category match)', () => {
        const sha = '00e527000000000000000000000000000000abcd';
        const c = generatePaperCandidates(sha);
        expect(c.sort()).toEqual(
            [sha, `arxiv--${sha}`, `unknown--${sha}`].sort()
        );
    });

    it('passes through an already-prefixed canonical form unchanged', () => {
        const c = generatePaperCandidates('unknown--00e527abcd');
        expect(c).toEqual(['unknown--00e527abcd']);
    });

    it('returns empty for empty input', () => {
        expect(generatePaperCandidates('')).toEqual([]);
    });
});
