import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
// @ts-ignore — JS factory module, no types.
import { generateSitemap, gzipSitemapXml } from '../../scripts/factory/lib/sitemap-generator.js';

// D-140 Lane S-A §4 — TRUE GZIP ARTIFACT. Each generated `sitemap-N.xml.gz` must
// be a REAL single-member gzip of the sitemap XML, deterministic across runs, and
// the index must list ONLY the `.gz` representation (no competing plain `.xml`).

let outDir: string;
let gz: Buffer;
let indexXml: string;

const SAMPLE = [
    { id: 'gpt-x', slug: 'gpt-x', type: 'model', fni_score: 90 },
    { id: 'paper-1', slug: 'paper-1', type: 'paper', fni_score: 12 },
    { id: 'tool-z', slug: 'tool-z', type: 'tool', fni_score: 40 },
];

beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gzip-'));
    await generateSitemap(SAMPLE, outDir);
    gz = fs.readFileSync(path.join(outDir, 'sitemaps', 'sitemap-1.xml.gz'));
    indexXml = fs.readFileSync(path.join(outDir, 'sitemaps', 'sitemap-index.xml'), 'utf8');
});

afterAll(() => { fs.rmSync(outDir, { recursive: true, force: true }); });

describe('§4.1 true gzip artifact', () => {
    it('1. raw first bytes are the gzip magic 1f 8b', () => {
        expect(gz[0]).toBe(0x1f);
        expect(gz[1]).toBe(0x8b);
    });

    it('2. gzip integrity passes (gunzipSync does not throw == `gzip -t` OK)', () => {
        expect(() => zlib.gunzipSync(gz)).not.toThrow();
    });

    it('3. ONE decompression yields valid <urlset> XML', () => {
        const xml = zlib.gunzipSync(gz).toString('utf8');
        expect(xml).toContain('<urlset');
        expect(xml).toContain('</urlset>');
        expect(xml).toContain('<loc>https://free2aitools.com');
    });

    it('4. no double compression — a SECOND decompression fails', () => {
        const once = zlib.gunzipSync(gz);
        expect(() => zlib.gunzipSync(once)).toThrow();
    });

    it('5. uncompressed XML is < 50MB and URL count < 50000', () => {
        const xml = zlib.gunzipSync(gz).toString('utf8');
        expect(Buffer.byteLength(xml, 'utf8')).toBeLessThan(50 * 1024 * 1024);
        expect((xml.match(/<url>/g) || []).length).toBeLessThan(50000);
    });

    it('6. DETERMINISTIC — same XML gzipped twice is byte-identical', () => {
        const xml = zlib.gunzipSync(gz).toString('utf8');
        const a = gzipSitemapXml(xml);
        const b = gzipSitemapXml(xml);
        expect(Buffer.compare(a, b)).toBe(0);
        // And it reproduces the emitted artifact exactly.
        expect(Buffer.compare(a, gz)).toBe(0);
    });
});

describe('§4.2 single canonical representation', () => {
    it('7. index lists ONLY the .gz child (correct representation)', () => {
        const locs = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
        expect(locs.length).toBeGreaterThan(0);
        for (const loc of locs) {
            expect(loc).toMatch(/\/sitemaps\/sitemap-\d+\.xml\.gz$/);
            expect(loc).not.toMatch(/sitemap-\d+\.xml$/); // never the bare .xml child
        }
    });

    it('8. public plain `sitemap-N.xml` child is NOT emitted', () => {
        expect(fs.existsSync(path.join(outDir, 'sitemaps', 'sitemap-1.xml'))).toBe(false);
    });

    it('9. child path stays /sitemaps/sitemap-N.xml.gz', () => {
        expect(fs.existsSync(path.join(outDir, 'sitemaps', 'sitemap-1.xml.gz'))).toBe(true);
        expect(indexXml).toContain('/sitemaps/sitemap-1.xml.gz');
    });
});

describe('§4 mutation proofs — defect reintroduction MUST fail these asserts', () => {
    it('M1. replacing gzip bytes with plain XML -> magic/integrity FAIL', () => {
        const plain = Buffer.from('<?xml version="1.0"?><urlset></urlset>', 'utf8');
        // plain XML starts with 0x3c ('<'), not gzip magic; gunzip throws.
        expect(plain[0]).not.toBe(0x1f);
        expect(() => zlib.gunzipSync(plain)).toThrow();
    });

    it('M2. removing the gzip header (stripping 1f 8b) -> integrity FAIL', () => {
        const headerless = gz.subarray(2); // drop the magic bytes
        expect(() => zlib.gunzipSync(headerless)).toThrow();
    });

    it('M3. adding double gzip -> single decompress no longer yields XML', () => {
        const doubled = zlib.gzipSync(gz); // gzip-of-gzip
        const once = zlib.gunzipSync(doubled);
        // After ONE decompress we still have gzip bytes, not <urlset> XML.
        expect(once[0]).toBe(0x1f);
        expect(once.toString('utf8', 0, 64)).not.toContain('<urlset');
    });
});
