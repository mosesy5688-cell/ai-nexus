import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
// @ts-ignore — JS factory module, no types.
import { generateSitemap } from '../../scripts/factory/lib/sitemap-generator.js';

// C3 REGISTRY — which sitemap URLs legitimately carry NO <lastmod>, and why.
//
// Measured on the live sitemap set (14 children, 2026-09-13): 617,574 <loc> and
// 617,557 <lastmod>, i.e. 17 URLs with no <lastmod>. Enumerated, those 17 were
// the 16 hand-authored static hub/landing routes below plus the single bogus
// /knowledge/stats-json-zst row that C1 removes. Zero entity pages were missing
// one. After C1 the registered count is 16, and it is HONEST: STATIC_PAGES in
// sitemap-generator.js carries no timestamp field at all, because a hand-authored
// Astro route has no content-modification time in the generator's inputs. The
// only value available would be the run's own clock — a fabricated re-stamp.
//
// So the assertion is deliberately two-sided: the omission set must be EXACTLY
// these 16, and no <lastmod> value may appear that was not supplied by an input
// row. Adding a static page, or filling omissions with a generated timestamp,
// both fail here.

const STATIC_PAGES_WITHOUT_LASTMOD = [
    '/', '/about', '/automation-workflow', '/datasets', '/explore',
    '/infrastructure-ops', '/knowledge', '/knowledge-retrieval', '/methodology',
    '/models', '/papers', '/ranking', '/search', '/text-generation', '/tools',
    '/vision-multimedia',
];
const REGISTERED_OMISSION_COUNT = 16;
const BASE = 'https://free2aitools.com';

const SUPPLIED = ['2026-01-15T00:00:00Z', '2026-02-15T00:00:00Z', '2026-03-15T00:00:00Z'];

let outDir: string;
let xml = '';

/** Every <url> block, split into its loc and whether it has a <lastmod>. */
function blocks(x: string) {
    return [...x.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
        loc: /<loc>([^<]*)<\/loc>/.exec(m[1])![1],
        lastmod: (/<lastmod>([^<]*)<\/lastmod>/.exec(m[1]) || [, null])[1] as string | null,
    }));
}

async function build(entities: any[], dir: string) {
    await generateSitemap(entities, dir);
    return zlib.gunzipSync(fs.readFileSync(path.join(dir, 'sitemaps', 'sitemap-1.xml.gz'))).toString('utf8');
}

beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lm-'));
    xml = await build(SUPPLIED.map((lm, i) => ({
        id: `m${i}`, slug: `owner/model-${i}`, type: 'model', fni_score: 50, last_modified: lm,
    })), outDir);
});

afterAll(() => { fs.rmSync(outDir, { recursive: true, force: true }); });

describe('C3 — the registered <lastmod> omission set', () => {
    it('is exactly the 16 static hub pages', () => {
        const missing = blocks(xml).filter((b) => b.lastmod === null).map((b) => b.loc).sort();
        const expected = STATIC_PAGES_WITHOUT_LASTMOD.map((p) => (p === '/' ? BASE + '/' : BASE + p)).sort();
        expect(missing).toEqual(expected);
    });

    it('has the registered count', () => {
        expect(blocks(xml).filter((b) => b.lastmod === null)).toHaveLength(REGISTERED_OMISSION_COUNT);
    });

    it('contains no entity page', () => {
        const missing = blocks(xml).filter((b) => b.lastmod === null).map((b) => b.loc);
        expect(missing.filter((l) => /\/(model|tool|dataset|paper)\//.test(l))).toEqual([]);
    });

    it('every entity URL that supplied a time carries it', () => {
        const present = blocks(xml).filter((b) => b.lastmod !== null);
        expect(present).toHaveLength(SUPPLIED.length);
        expect(present.map((b) => b.lastmod).sort()).toEqual([...SUPPLIED].sort());
    });
});

describe('C3 — omission is never backfilled with a derived value', () => {
    it('no emitted <lastmod> value came from anywhere but an input row', () => {
        const emitted = new Set(blocks(xml).map((b) => b.lastmod).filter(Boolean) as string[]);
        for (const v of emitted) expect(SUPPLIED).toContain(v);
    });

    it('no <lastmod> is dated near the run clock', () => {
        // A generation re-stamp would land within a day of now; supplied values do not.
        const dayMs = 24 * 60 * 60 * 1000;
        for (const b of blocks(xml)) {
            if (!b.lastmod) continue;
            expect(Math.abs(Date.now() - Date.parse(b.lastmod))).toBeGreaterThan(dayMs);
        }
    });

    it('an entity with no usable time is OMITTED, not stamped', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lm2-'));
        try {
            const x = await build([
                { id: 'a', slug: 'owner/empty', type: 'model', fni_score: 50, last_modified: '' },
                { id: 'b', slug: 'owner/garbage', type: 'model', fni_score: 50, last_modified: 'not-a-date' },
            ], dir);
            const bs = blocks(x).filter((b) => /owner--(empty|garbage)/.test(b.loc));
            expect(bs).toHaveLength(2);
            for (const b of bs) expect(b.lastmod).toBeNull();
            // and the tag is absent entirely, not present-but-empty
            expect(x).not.toContain('<lastmod></lastmod>');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
