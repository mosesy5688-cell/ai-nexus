/**
 * SRS-1 — retired-surface invariant (tier-1, hermetic).
 *
 * INVARIANT: surfaces that were RETIRED stay retired in an SEO-honest way.
 *  (a) The static sitemap (src/pages/sitemap-static.xml.ts) must NOT advertise
 *      any retired/410 route — it lists only live, indexable pages. (Reinforces
 *      G-07 /reports and P-02 /leaderboard at the sitemap tier.)
 *  (b) The retired ENTITY TYPES — `agent`, `space`, `prompt` — keep their detail
 *      routes returning HTTP 410 Gone (permanent removal), the honest signal for
 *      a cancelled/merged type. They must not silently 200 or 404.
 *
 * Distinct from retired-route-cleanup.test.ts (which guards the dead onward LINKS
 * out of the /reports 410 pages + the onboarding CTA): this guard pins the
 * sitemap exclusion as a positive allow-list and the entity-type 410 status.
 *
 * HERMETIC: reads SOURCE only. No live fetch. Deterministic across runs.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (rel: string) => resolve(root, rel);
const read = (rel: string) => readFileSync(abs(rel), 'utf8');

// Routes that are retired (410 Gone) or redirect-only and must never be
// advertised as indexable in the static sitemap.
const RETIRED_OR_REDIRECT_PATHS = [
    '/reports',     // 410 Gone (V27.42)
    '/leaderboard', // 301 -> /benchmarks (P-02)
    '/agents',      // 301 -> /tools  (agent type cancelled)
    '/spaces',      // 301 -> /models (space type merged)
    '/prompts',     // 301 -> /tools  (prompt type cancelled)
    '/agent',       // 410 detail type
    '/space',       // 410 detail type
    '/prompt',      // 410 detail type
];

describe('SRS-1: static sitemap advertises NO retired/redirect route', () => {
    const sitemap = read('src/pages/sitemap-static.xml.ts');
    // Pull the declared path literals from the STATIC_PAGES array.
    const declared = [...sitemap.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);

    it('sitemap STATIC_PAGES is a non-empty allow-list', () => {
        expect(declared.length).toBeGreaterThan(0);
    });

    for (const retired of RETIRED_OR_REDIRECT_PATHS) {
        it(`sitemap does not list the retired path ${retired}`, () => {
            expect(declared).not.toContain(retired);
        });
    }
});

describe('SRS-1: retired entity-type detail routes return 410 Gone', () => {
    const RETIRED_TYPE_ROUTES = [
        'src/pages/agent/[...slug].astro',
        'src/pages/space/[...slug].astro',
        'src/pages/prompt/[...slug].astro',
    ];

    for (const route of RETIRED_TYPE_ROUTES) {
        it(`${route} exists and sets status 410 (not 200/404)`, () => {
            expect(existsSync(abs(route)), `${route} must exist as a 410 page`).toBe(true);
            const src = read(route);
            // Permanent-removal signal: status = 410.
            expect(src).toMatch(/Astro\.response\.status\s*=\s*410/);
            // It must NOT silently 200 or collapse to 404.
            expect(src).not.toMatch(/status\s*=\s*200/);
            expect(src).not.toMatch(/status\s*=\s*404/);
        });
    }
});
