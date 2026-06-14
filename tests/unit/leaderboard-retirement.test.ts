/**
 * P-02/P-03 Leaderboard Retirement Regression Guard
 *
 * The non-authoritative /leaderboard SSR page (src/pages/leaderboard.astro)
 * shadowed the public/_redirects rule, rendered LIVE 200, read the RETIRED
 * static /cache/benchmarks.json(.gz) path, and fabricated freshness from the
 * current timestamp. It was retired in favor of a single authoritative
 * permanent redirect to /benchmarks (the VFS-backed authoritative catalog).
 *
 * This guard pins the retirement so a future change cannot silently
 * resurrect the split-truth surface:
 *   1. src/pages/leaderboard.astro MUST NOT exist (nothing shadows the redirect).
 *   2. public/_redirects MUST map /leaderboard -> /benchmarks (one authority).
 *   3. sitemap-static.xml.ts MUST NOT emit /leaderboard.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

describe('P-02/P-03 leaderboard retirement', () => {
    it('src/pages/leaderboard.astro is absent (no route shadows the redirect)', () => {
        expect(existsSync(path.join(ROOT, 'src/pages/leaderboard.astro'))).toBe(false);
    });

    it('public/_redirects has exactly one /leaderboard authority -> /benchmarks', () => {
        const redirects = readFileSync(path.join(ROOT, 'public/_redirects'), 'utf8');
        const rules = redirects
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))
            .filter((l) => l.split(/\s+/)[0] === '/leaderboard');

        expect(rules).toHaveLength(1);
        const [source, target, code] = rules[0].split(/\s+/);
        expect(source).toBe('/leaderboard');
        expect(target).toBe('/benchmarks');
        expect(code).toBe('301');
    });

    it('sitemap-static.xml.ts does not list /leaderboard', () => {
        const sitemap = readFileSync(
            path.join(ROOT, 'src/pages/sitemap-static.xml.ts'),
            'utf8'
        );
        expect(sitemap).not.toContain("'/leaderboard'");
    });
});
