/**
 * Retired-route cleanup guard (G-06 / G-07 / G-08).
 *
 * Three retired surfaces had dead onward links to nonexistent routes:
 *  - G-06: the `/reports/*` 410 pages auto meta-refreshed to `/trending`, which
 *          does not exist (only `/trends` = src/pages/trends.astro is live). The
 *          fix drops the auto-refresh and points the explicit link at `/trends`.
 *  - G-07: sitemap-static.xml.ts advertised `/reports`, a 410 Gone surface.
 *  - G-08: OnboardingTour CTA linked to `/agent` (410); successor is `/tools`.
 *
 * This guard locks the cleanup: no `/trending` reference may return to the
 * reports 410 pages, no auto meta-refresh may return there, the static sitemap
 * must not re-advertise `/reports`, and the onboarding CTA must not point at the
 * retired `/agent`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const REPORTS_PAGES = [
    'src/pages/reports/index.astro',
    'src/pages/reports/archive.astro',
    'src/pages/reports/annual.astro',
    'src/pages/reports/[...slug].astro',
];

describe('retired-route cleanup', () => {
    it('G-06: reports 410 pages no longer reference the nonexistent /trending', () => {
        for (const page of REPORTS_PAGES) {
            const src = read(page);
            expect(src, `${page} must not link to /trending`).not.toContain('/trending');
            expect(src, `${page} must not auto meta-refresh`).not.toContain('http-equiv="refresh"');
            // Keeps the 410 honest signal.
            expect(src, `${page} must keep 410 status`).toContain('status = 410');
        }
    });

    it('G-07: static sitemap does not advertise the retired /reports surface', () => {
        const sitemap = read('src/pages/sitemap-static.xml.ts');
        expect(sitemap).not.toMatch(/path:\s*['"]\/reports['"]/);
    });

    it('G-08: onboarding CTA points at /tools, not the retired /agent', () => {
        const tour = read('src/components/common/OnboardingTour.astro');
        expect(tour).not.toContain('href="/agent"');
        expect(tour).toContain('href="/tools"');
    });
});
