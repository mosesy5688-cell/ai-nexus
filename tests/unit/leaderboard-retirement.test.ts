/**
 * P-02/P-03 Leaderboard Retirement Regression Guard
 *
 * The legacy non-authoritative /leaderboard SSR page rendered LIVE 200, read
 * the RETIRED static /cache/benchmarks.json(.gz) path, masked fetch failure as
 * a loading placeholder, and fabricated freshness from the current timestamp
 * (split-truth + non-authoritative cache + fake freshness).
 *
 * It is retired in favor of a permanent redirect to /benchmarks (the VFS-backed
 * authoritative catalog). In this output:'server' + Cloudflare deployment the
 * SSR worker intercepts all routes, so public/_redirects FILE rules do NOT fire
 * — only an SSR redirect PAGE actually redirects. So src/pages/leaderboard.astro
 * must EXIST as a redirect-only page (mirroring agents.astro / explore.astro),
 * with no data fetch / cache read / freshness fabrication / leaderboard UI.
 *
 * This guard pins the retirement so a future change cannot silently resurrect
 * the split-truth surface:
 *   1. src/pages/leaderboard.astro EXISTS and is redirect-only -> /benchmarks 301.
 *   2. It reads NO /cache/benchmarks path, fabricates NO timestamp, imports NO
 *      leaderboard components.
 *   3. public/_redirects maps /leaderboard -> /benchmarks (harmless secondary).
 *   4. sitemap-static.xml.ts MUST NOT emit /leaderboard.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const LEADERBOARD_PAGE = path.join(ROOT, 'src/pages/leaderboard.astro');

describe('P-02/P-03 leaderboard retirement', () => {
    it('src/pages/leaderboard.astro exists and is a redirect-only page -> /benchmarks 301', () => {
        expect(existsSync(LEADERBOARD_PAGE)).toBe(true);
        const src = readFileSync(LEADERBOARD_PAGE, 'utf8');
        expect(src).toMatch(/Astro\.redirect\(\s*['"]\/benchmarks['"]\s*,\s*301\s*\)/);
    });

    it('leaderboard.astro does NO data fetch / cache read and fabricates NO freshness', () => {
        const src = readFileSync(LEADERBOARD_PAGE, 'utf8');
        // Strip the leading frontmatter comment block so doc text describing the
        // retired behavior does not produce false positives.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(code).not.toContain('/cache/benchmarks');
        expect(code).not.toMatch(/\bfetch\s*\(/);
        expect(code).not.toContain('new Date(');
        expect(code).not.toMatch(/Date\.now\s*\(/);
    });

    it('leaderboard.astro imports NO leaderboard components/assets/client', () => {
        const src = readFileSync(LEADERBOARD_PAGE, 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(code).not.toMatch(/import\s/);
        expect(code).not.toContain('components/leaderboard');
        expect(code).not.toContain('leaderboard.css');
        expect(code).not.toContain('leaderboard-client');
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
