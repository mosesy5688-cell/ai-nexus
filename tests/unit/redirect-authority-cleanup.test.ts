/**
 * P-09 Redirect Authority Cleanup — Regression Guard (hermetic, no live fetch)
 *
 * In this Astro `output: 'server'` + Cloudflare deployment there were three
 * redirect authorities:
 *   (1) astro.config.mjs `redirects:`        — WORKS (adapter-compiled, fires)
 *   (2) SSR pages `Astro.redirect(...)`      — WORKS
 *   (3) public/_redirects FILE               — DEAD (SSR worker bypasses it)
 *
 * P-09 remediation:
 *   A) MIGRATE the two DEAD wildcard compat rules from public/_redirects to the
 *      working astro.config.mjs `redirects:` authority, using Astro's rest/spread
 *      ([...slug]) form which preserves the captured splat losslessly into the
 *      destination's same-named segment (per Astro docs: '/blog/[...slug]' ->
 *      '/articles/[...slug]'). String-form redirects yield 301 under an adapter.
 *        /model/hf/[...slug] -> /model/[...slug]
 *        /arxiv/[...slug]    -> /paper/[...slug]
 *   B) RETIRE /model/deprecated-test — it is a test alias with no compat
 *      obligation; it honestly 404s. No replacement redirect, no synthetic 410.
 *   C) DELETE public/_redirects entirely — after A+B its only remaining entries
 *      (/explore, /leaderboard) are redundant (SSR-covered), so no effective rule
 *      remained; a dead file must not masquerade as a routing authority.
 *
 * This guard pins the cleanup so a future change cannot silently regress it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const ASTRO_CONFIG = path.join(ROOT, 'astro.config.mjs');
const REDIRECTS_FILE = path.join(ROOT, 'public/_redirects');
const EXPLORE_PAGE = path.join(ROOT, 'src/pages/explore.astro');
const LEADERBOARD_PAGE = path.join(ROOT, 'src/pages/leaderboard.astro');

describe('P-09 redirect authority cleanup', () => {
    const config = readFileSync(ASTRO_CONFIG, 'utf8');

    it('A: astro.config.mjs declares /model/hf/[...slug] -> /model/[...slug] (lossless splat)', () => {
        expect(config).toMatch(
            /['"]\/model\/hf\/\[\.\.\.slug\]['"]\s*:\s*['"]\/model\/\[\.\.\.slug\]['"]/
        );
    });

    it('A: astro.config.mjs declares /arxiv/[...slug] -> /paper/[...slug] (lossless splat)', () => {
        expect(config).toMatch(
            /['"]\/arxiv\/\[\.\.\.slug\]['"]\s*:\s*['"]\/paper\/\[\.\.\.slug\]['"]/
        );
    });

    it('A: the migrated redirects target real catch-all detail routes', () => {
        expect(existsSync(path.join(ROOT, 'src/pages/model/[...slug].astro'))).toBe(true);
        expect(existsSync(path.join(ROOT, 'src/pages/paper/[...slug].astro'))).toBe(true);
    });

    it('A: no redirect loop — source prefixes differ from destination prefixes', () => {
        // string form yields 301 under an adapter; source != destination prefix.
        expect(config).not.toMatch(/['"]\/model\/\[\.\.\.slug\]['"]\s*:\s*['"]\/model\/hf/);
        expect(config).not.toMatch(/['"]\/paper\/\[\.\.\.slug\]['"]\s*:\s*['"]\/arxiv/);
    });

    it('B: /model/deprecated-test has NO redirect rule anywhere (honest 404)', () => {
        expect(config).not.toContain('deprecated-test');
        // and the dead file that previously held it is gone (asserted below)
        if (existsSync(REDIRECTS_FILE)) {
            expect(readFileSync(REDIRECTS_FILE, 'utf8')).not.toContain('deprecated-test');
        }
    });

    it('C: public/_redirects is deleted (dead FILE authority removed)', () => {
        expect(existsSync(REDIRECTS_FILE)).toBe(false);
    });

    it('C: /explore SSR redirect page still exists -> /models 301', () => {
        expect(existsSync(EXPLORE_PAGE)).toBe(true);
        expect(readFileSync(EXPLORE_PAGE, 'utf8')).toMatch(
            /Astro\.redirect\(\s*['"]\/models['"]\s*,\s*301\s*\)/
        );
    });

    it('C: /leaderboard SSR redirect page still exists -> /benchmarks 301', () => {
        expect(existsSync(LEADERBOARD_PAGE)).toBe(true);
        expect(readFileSync(LEADERBOARD_PAGE, 'utf8')).toMatch(
            /Astro\.redirect\(\s*['"]\/benchmarks['"]\s*,\s*301\s*\)/
        );
    });
});
