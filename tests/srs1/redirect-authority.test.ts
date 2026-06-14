/**
 * SRS-1 — P-09 redirect-authority invariant (tier-1, hermetic).
 *
 * INVARIANT: in this Astro `output: 'server'` + Cloudflare deployment, every
 * redirect is served by a LIVE authority — either the adapter-compiled
 * `redirects:` map in astro.config.mjs OR an SSR page's `Astro.redirect(...)`
 * — and NEVER by the dead `public/_redirects` FILE (the SSR worker bypasses it,
 * so a rule placed there silently does nothing). The P-09 cleanup migrated the
 * two live wildcard compat rules into astro.config, retired the orphan
 * `/model/deprecated-test` alias, and DELETED the dead `public/_redirects` file.
 *
 * This is the SRS-1 cross-tier invariant lock for the P-09 END-STATE (now on
 * main). It complements the per-fix regression guard
 * `tests/unit/redirect-authority-cleanup.test.ts` (logic not duplicated): this
 * file pins the *authority shape* — config/SSR live, `_redirects` dead-and-gone
 * — and the full set of SSR redirect pages and their destinations.
 *
 * HERMETIC: reads SOURCE/CONFIG only @ post-P-09 main. No live fetch.
 * Deterministic across runs.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (rel: string) => resolve(root, rel);
const read = (rel: string) => readFileSync(abs(rel), 'utf8');

describe('SRS-1 P-09: adapter-compiled redirects: map is the wildcard authority', () => {
    const config = read('astro.config.mjs');

    it('declares /model/hf/[...slug] -> /model/[...slug] (lossless splat)', () => {
        expect(config).toMatch(
            /['"]\/model\/hf\/\[\.\.\.slug\]['"]\s*:\s*['"]\/model\/\[\.\.\.slug\]['"]/
        );
    });

    it('declares /arxiv/[...slug] -> /paper/[...slug] (lossless splat)', () => {
        expect(config).toMatch(
            /['"]\/arxiv\/\[\.\.\.slug\]['"]\s*:\s*['"]\/paper\/\[\.\.\.slug\]['"]/
        );
    });

    it('the migrated wildcard redirects target real catch-all detail routes', () => {
        expect(existsSync(abs('src/pages/model/[...slug].astro'))).toBe(true);
        expect(existsSync(abs('src/pages/paper/[...slug].astro'))).toBe(true);
    });

    it('no redirect loop — source prefixes differ from destination prefixes', () => {
        expect(config).not.toMatch(/['"]\/model\/\[\.\.\.slug\]['"]\s*:\s*['"]\/model\/hf/);
        expect(config).not.toMatch(/['"]\/paper\/\[\.\.\.slug\]['"]\s*:\s*['"]\/arxiv/);
    });
});

describe('SRS-1 P-09: the dead public/_redirects FILE authority is gone', () => {
    it('public/_redirects FILE is ABSENT (dead source authority deleted)', () => {
        expect(existsSync(abs('public/_redirects'))).toBe(false);
    });
});

describe('SRS-1 P-09: retired /model/deprecated-test alias has no redirect anywhere', () => {
    it('no /model/deprecated-test rule in astro.config (honest 404)', () => {
        expect(read('astro.config.mjs')).not.toContain('deprecated-test');
    });

    it('no /model/deprecated-test rule in a (non-existent) _redirects file', () => {
        // Defensive: if a _redirects file is ever resurrected it must not carry it.
        const p = abs('public/_redirects');
        if (existsSync(p)) {
            expect(readFileSync(p, 'utf8')).not.toContain('deprecated-test');
        } else {
            expect(existsSync(p)).toBe(false);
        }
    });
});

describe('SRS-1 P-09: SSR redirect pages are the live authority for retired catalogs', () => {
    // [page file, destination] — each must redirect via Astro.redirect(dest, 301).
    const SSR_REDIRECTS: Array<[string, string]> = [
        ['src/pages/explore.astro', '/models'],
        ['src/pages/leaderboard.astro', '/benchmarks'],
        ['src/pages/agents.astro', '/tools'],
        ['src/pages/spaces.astro', '/models'],
        ['src/pages/prompts.astro', '/tools'],
    ];

    for (const [page, dest] of SSR_REDIRECTS) {
        it(`${page} exists and 301-redirects to ${dest}`, () => {
            expect(existsSync(abs(page)), `${page} must exist as an SSR redirect page`).toBe(true);
            const src = read(page);
            const re = new RegExp(
                `Astro\\.redirect\\(\\s*['"]${dest.replace(/\//g, '\\/')}['"]\\s*,\\s*301\\s*\\)`
            );
            expect(src).toMatch(re);
        });
    }
});
