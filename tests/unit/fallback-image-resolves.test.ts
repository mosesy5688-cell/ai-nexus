/**
 * Detail-page fallback image guard (P-01, A11Y/UX).
 *
 * RUNTIME_OBSERVED: /images/models/default-model.jpg was referenced as the
 * fallback (placeholderImage / og:image) by the 5 detail routes and by
 * validateImageUrl(), but that asset was MISSING (404) -> broken <img> and
 * broken og:image whenever an entity had no image_url.
 *
 * The fix repoints every fallback reference at an EXISTING tracked asset
 * (public/placeholder-model.png). This guard locks two invariants:
 *   1. No code path may reference the dead /images/models/default-model.jpg.
 *   2. Every fallback path the code references must resolve to a real tracked
 *      file under public/ (i.e. served as a 200, not a 404 fallback).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const DEAD_PATH = '/images/models/default-model.jpg';

const FALLBACK_REFERENCING_FILES = [
    'src/utils/formatters.js',
    'src/pages/model/[...slug].astro',
    'src/pages/paper/[...slug].astro',
    'src/pages/dataset/[...slug].astro',
    'src/pages/tool/[...slug].astro',
    'src/pages/benchmark/[...slug].astro',
];

// Matches a public-rooted image literal like '/placeholder-model.png'.
const PUBLIC_IMG_LITERAL = /['"](\/[\w./-]+\.(?:png|jpe?g|gif|webp|svg))['"]/gi;

describe('P-01: detail-page fallback image resolves to a tracked asset', () => {
    it('no source references the dead /images/models/default-model.jpg', () => {
        for (const file of FALLBACK_REFERENCING_FILES) {
            const src = read(file);
            expect(src, `${file} must not reference the missing fallback`).not.toContain(DEAD_PATH);
        }
    });

    it('every fallback image literal resolves to an existing file under public/', () => {
        for (const file of FALLBACK_REFERENCING_FILES) {
            const src = read(file);
            const matches = [...src.matchAll(PUBLIC_IMG_LITERAL)].map((m) => m[1]);
            // Each file that referenced the old fallback must now name a real asset.
            for (const literal of matches) {
                const onDisk = resolve(root, 'public', '.' + literal);
                expect(
                    existsSync(onDisk),
                    `${file} references ${literal} which must exist as a tracked public asset`,
                ).toBe(true);
            }
        }
    });

    it('the canonical fallback asset exists and is a real (non-empty) image', () => {
        const asset = resolve(root, 'public', 'placeholder-model.png');
        expect(existsSync(asset), 'public/placeholder-model.png must exist').toBe(true);
        const bytes = readFileSync(asset);
        expect(bytes.length, 'fallback asset must be a non-empty image').toBeGreaterThan(1024);
    });
});
