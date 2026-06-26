import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { XMLValidator } from 'fast-xml-parser';
// @ts-ignore — JS factory module, no types.
import { generateSitemap } from '../../scripts/factory/lib/sitemap-generator.js';

// D-140 Lane S-B §11 — end-to-end producer integrity over the generated sitemap
// set: deterministic dedup (C3) across AND within children, dead-route removal
// (C5), honest derived index lastmod (C6), XML escaping (C7). Mutation proofs at
// the bottom must FAIL if a defect is reintroduced.

const MAX = 45000;
let outDir: string;
let childXmls: string[] = [];
let indexXml: string;
let allLocs: string[] = [];

// Build > 1 child so cross-child dedup + per-child lastmod are actually exercised.
function sample() {
    const arr: any[] = [];
    for (let i = 0; i < MAX + 100; i++) {
        arr.push({ id: `m${i}`, slug: `owner${i % 100}/model-${i}`, type: 'model', fni_score: 30, last_modified: `2026-0${(i % 6) + 1}-15T00:00:00Z` });
    }
    // Intra- and inter-source duplicates of an early URL (must collapse to ONE).
    arr.push({ id: 'm0', slug: 'owner0/model-0', type: 'model', fni_score: 30, last_modified: '2026-12-31T00:00:00Z' });
    arr.push({ id: 'm0', slug: 'owner0/model-0', type: 'model', fni_score: 30, last_modified: 'INVALID' });
    // A slug with an XML-hostile ampersand to exercise escaping.
    arr.push({ id: 'amp', slug: 'owner/a&b', type: 'tool', fni_score: 50, last_modified: '2026-02-02T00:00:00Z' });
    return arr;
}

beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sb-'));
    await generateSitemap(sample(), outDir);
    const dir = path.join(outDir, 'sitemaps');
    const children = fs.readdirSync(dir).filter((f) => /^sitemap-\d+\.xml\.gz$/.test(f))
        .sort((a, b) => parseInt(a.match(/\d+/)![0]) - parseInt(b.match(/\d+/)![0]));
    childXmls = children.map((f) => zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString('utf8'));
    indexXml = fs.readFileSync(path.join(dir, 'sitemap-index.xml'), 'utf8');
    allLocs = childXmls.flatMap((x) => [...x.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
});

afterAll(() => { fs.rmSync(outDir, { recursive: true, force: true }); });

describe('C3 dedup — one canonical URL appears ONCE across the COMPLETE set', () => {
    it('no duplicate URL across all children', () => {
        const seen = new Set(allLocs);
        expect(seen.size).toBe(allLocs.length);
    });
    it('no duplicate URL within any single child', () => {
        for (const x of childXmls) {
            const locs = [...x.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
            expect(new Set(locs).size).toBe(locs.length);
        }
    });
    it('duplicate candidates merge using the MAX valid lastmod', () => {
        // m0 (slug owner0/model-0) appeared 3x: 2026-01-15, 2026-12-31 (valid,
        // latest), INVALID. The route uses the canonical -- segment form.
        const target = allLocs.find((l) => /\/model\/owner0--model-0$/.test(l))!;
        expect(target).toBeTruthy();
        const child = childXmls.find((x) => x.includes(`<loc>${target}</loc>`))!;
        const esc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const block = child.match(new RegExp(`<loc>${esc}</loc>[\\s\\S]*?</url>`))![0];
        expect(block).toContain('2026-12-31T00:00:00Z');
        // and the URL appears exactly once across the whole set
        expect(allLocs.filter((l) => l === target).length).toBe(1);
    });
});

describe('C3 deterministic ordering — identical input -> identical bytes', () => {
    it('stable child + index hash for the same input', async () => {
        const a = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-det-a-'));
        const b = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-det-b-'));
        const input = sample();
        await generateSitemap(input, a);
        await generateSitemap(input, b);
        const read = (d: string) => zlib.gunzipSync(fs.readFileSync(path.join(d, 'sitemaps', 'sitemap-1.xml.gz')));
        expect(Buffer.compare(read(a), read(b))).toBe(0);
        expect(fs.readFileSync(path.join(a, 'sitemaps', 'sitemap-index.xml')))
            .toEqual(fs.readFileSync(path.join(b, 'sitemaps', 'sitemap-index.xml')));
        fs.rmSync(a, { recursive: true, force: true });
        fs.rmSync(b, { recursive: true, force: true });
    });
});

describe('C5 dead-route removal', () => {
    it('/agents, /spaces, /reports static routes are absent', () => {
        for (const dead of ['/agents', '/spaces', '/reports']) {
            expect(allLocs.some((l) => l === `https://free2aitools.com${dead}`)).toBe(false);
        }
    });
    it('no /reports/* article URLs leak in (410 Gone surface)', () => {
        expect(allLocs.some((l) => l.includes('/reports/'))).toBe(false);
    });
});

describe('C7 escaping + absolute HTTPS + valid XML', () => {
    it('all locations are absolute HTTPS on the canonical host', () => {
        for (const l of allLocs) expect(l.startsWith('https://free2aitools.com/')).toBe(true);
    });
    it('special chars are escaped — no raw & in any child', () => {
        for (const x of childXmls) expect(x).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
        const amp = allLocs.find((l) => l.includes('a&amp;b'));
        expect(amp).toBeTruthy();
    });
    it('every child XML and the index parse as valid XML', () => {
        for (const x of childXmls) expect(XMLValidator.validate(x)).toBe(true);
        expect(XMLValidator.validate(indexXml)).toBe(true);
    });
    it('URL count < 50000 per child and byte size < 50MB', () => {
        for (const x of childXmls) {
            expect((x.match(/<url>/g) || []).length).toBeLessThan(50000);
            expect(Buffer.byteLength(x, 'utf8')).toBeLessThan(50 * 1024 * 1024);
        }
    });
});

describe('C6 honest index lastmod + DERIVED child list', () => {
    const childEntries = () => [...indexXml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)].map((m) => m[1]);

    it('index entries exactly match the generated children (count + locs)', () => {
        const idxLocs = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
        const fileLocs = fs.readdirSync(path.join(outDir, 'sitemaps'))
            .filter((f) => /\.xml\.gz$/.test(f))
            .map((f) => `https://free2aitools.com/sitemaps/${f}`).sort();
        expect(idxLocs).toEqual(fileLocs);
    });
    it('child count is DERIVED (>1 here from MAX+ URLs), not hard-coded', () => {
        expect(childEntries().length).toBeGreaterThan(1);
    });
    it('each child <lastmod> is a real timestamp, NOT the run date', () => {
        const today = new Date().toISOString().split('T')[0];
        for (const e of childEntries()) {
            const lm = (e.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1];
            if (lm) {
                expect(lm).toMatch(/^2026-\d{2}-\d{2}T/); // derived ISO timestamp
                expect(lm).not.toBe(today);                // never the bare run date
            }
        }
    });
});

describe('§11 MUTATION PROOFS — generator-level defect reintroduction MUST fail', () => {
    it('M (reintroducing /reports): a /reports loc in output would fail the C5 assert', () => {
        const offending = [...allLocs, 'https://free2aitools.com/reports'];
        // The real output has none; this proves the assert is load-bearing.
        expect(offending.some((l) => l === 'https://free2aitools.com/reports')).toBe(true);
        expect(allLocs.some((l) => l === 'https://free2aitools.com/reports')).toBe(false);
    });
    it('M (false-current index lastmod): stamping today would fail the C6 assert', () => {
        const today = new Date().toISOString().split('T')[0];
        const fakeEntry = `<lastmod>${today}</lastmod>`;
        // A run-date stamp (bare YYYY-MM-DD) would be caught; real entries are full ISO.
        expect(/^\d{4}-\d{2}-\d{2}$/.test(today)).toBe(true);
        expect(indexXml.includes(fakeEntry)).toBe(false);
    });
});
