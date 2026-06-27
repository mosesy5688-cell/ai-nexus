/**
 * D-140 Lane S-C — Canonical sitemap-index endpoint consolidation (§13) +
 * canonical-index failure semantics (§14). Regression + mutation guards (§15).
 *
 * Contract pinned here:
 *   - The SINGLE canonical index is /sitemaps/sitemap-index.xml (served by
 *     src/pages/sitemaps/[filename].ts). robots.txt references ONLY it.
 *   - /sitemap.xml         -> 301 ONCE to the canonical index.
 *   - /sitemap-index.xml   -> 301 ONCE to the canonical index (no proxy
 *     duplication, no hard-coded 1..9 range, no /sitemaps/sitemap-static.xml
 *     child, no empty-<sitemapindex>@HTTP-200 path, no independent cache/failure
 *     behavior).
 *   - Canonical index upstream OK -> authoritative body @200.
 *   - Canonical index upstream miss/throw -> 503 + Retry-After + non-cacheable
 *     failure; never an empty index at 200, never a fabricated child inventory.
 *
 * MUTATION PROOFS (must FAIL if a defect is reintroduced into the orphan route):
 *   restoring the 1..9 fallback / empty-200 path / sitemap-static reference, or
 *   pointing robots at the alias, each fails one of the asserts below.
 *
 * Hermetic: route source is read from disk for static asserts; behavioral asserts
 * stub global fetch. No live network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

import { GET as SITEMAP_INDEX_ALIAS } from '../../src/pages/sitemap-index.xml.ts';
import { GET as SITEMAP_XML } from '../../src/pages/sitemap.xml.ts';
import { GET as SITEMAP_FILES } from '../../src/pages/sitemaps/[filename].ts';

const ROOT = path.resolve(__dirname, '../..');
const CANONICAL = '/sitemaps/sitemap-index.xml';

// Strip block + line comments so mutation proofs assert on EXECUTABLE code only
// (the file's own doc comment legitimately names the removed fallbacks).
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const ALIAS_SRC = stripComments(readFileSync(path.join(ROOT, 'src/pages/sitemap-index.xml.ts'), 'utf8'));
const ROBOTS_SRC = readFileSync(path.join(ROOT, 'src/pages/robots.txt.js'), 'utf8');

function ctx(filename: string) {
    return { params: { filename } } as any;
}

function upstream(opts: { status?: number; ok?: boolean; text?: string }): Response {
    const status = opts.status ?? 200;
    return {
        status,
        ok: opts.ok ?? (status >= 200 && status < 300),
        body: null,
        headers: new Headers(),
        text: vi.fn(async () => opts.text ?? ''),
    } as unknown as Response;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('§13 canonical consolidation — single index, single redirect', () => {
    it('robots.txt references ONLY the canonical index (not the alias)', () => {
        expect(ROBOTS_SRC).toContain(`Sitemap: https://free2aitools.com${CANONICAL}`);
        // MUTATION PROOF: pointing robots at the BARE alias (/sitemap-index.xml,
        // i.e. NOT under /sitemaps/) would fail here. The canonical lives under
        // /sitemaps/ so a host-root "/sitemap-index.xml" directive is forbidden.
        expect(ROBOTS_SRC).not.toMatch(/Sitemap:\s*https?:\/\/[^\s]+\.com\/sitemap-index\.xml\b/);
    });

    it('/sitemap.xml redirects ONCE (301) to the canonical index', async () => {
        const res = await SITEMAP_XML(ctx('') as any);
        expect(res.status).toBe(301);
        expect(res.headers.get('Location')).toBe(CANONICAL);
    });

    it('/sitemap-index.xml redirects ONCE (301) to the canonical index', async () => {
        const fetchMock = vi.fn(async () => upstream({ text: '<x/>' }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await SITEMAP_INDEX_ALIAS(ctx('') as any);
        expect(res.status).toBe(301);
        expect(res.headers.get('Location')).toBe(CANONICAL);
        // It is a pure redirect — it must NOT proxy R2 / read a body.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no redirect loop — the alias target is the canonical path, not itself', async () => {
        const res = await SITEMAP_INDEX_ALIAS(ctx('') as any);
        expect(res.headers.get('Location')).toBe(CANONICAL);
        expect(res.headers.get('Location')).not.toBe('/sitemap-index.xml');
    });

    it('MUTATION PROOF: no hard-coded 1..9 shard fallback remains in the alias', () => {
        expect(ALIAS_SRC).not.toMatch(/sitemap-[1-9]\.xml/);
        expect(ALIAS_SRC).not.toContain('sitemaps.map');
    });

    it('MUTATION PROOF: no /sitemaps/sitemap-static.xml false child reference remains', () => {
        expect(ALIAS_SRC).not.toContain('sitemap-static');
    });

    it('MUTATION PROOF: no empty-<sitemapindex>@HTTP-200 fallback remains in the alias', () => {
        expect(ALIAS_SRC).not.toContain('<sitemapindex');
        // The alias must not synthesize XML at all — only a 301 Location.
        expect(ALIAS_SRC).not.toContain('fallbackXml');
        expect(ALIAS_SRC).toMatch(/status:\s*301/);
        expect(ALIAS_SRC).toContain(`'Location': '${CANONICAL}'`);
    });

    it('/sitemaps/sitemap-static.xml carries no contract role (honest 404)', async () => {
        const fetchMock = vi.fn(async () => upstream({ status: 404, ok: false }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await SITEMAP_FILES(ctx('sitemap-static.xml'));
        expect(res.status).toBe(404);
        // Unrecognized name -> never reached upstream.
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('§14 canonical-index failure semantics', () => {
    it('upstream OK -> authoritative body @200 (application/xml)', async () => {
        const xml = '<?xml version="1.0"?><sitemapindex><sitemap><loc>x</loc></sitemap></sitemapindex>';
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ text: xml })));
        const res = await SITEMAP_FILES(ctx('sitemap-index.xml'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/xml');
        expect(await res.text()).toBe(xml);
    });

    it('upstream miss -> 503 + Retry-After, NOT a 200 empty index', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ status: 404, ok: false })));
        const res = await SITEMAP_FILES(ctx('sitemap-index.xml'));
        expect(res.status).toBe(503);
        expect(res.status).not.toBe(200);
        expect(res.headers.get('Retry-After')).toBeTruthy();
        const body = await res.text();
        expect(body).not.toContain('<sitemapindex');
    });

    it('upstream 5xx -> 503 + Retry-After', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ status: 503, ok: false })));
        const res = await SITEMAP_FILES(ctx('sitemap-index.xml'));
        expect(res.status).toBe(503);
        expect(res.headers.get('Retry-After')).toBeTruthy();
    });

    it('fetch throws (origin unreachable) -> 503, never a fake 200', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ETIMEDOUT'); }));
        const res = await SITEMAP_FILES(ctx('sitemap-index.xml'));
        expect(res.status).toBe(503);
        expect(res.headers.get('Retry-After')).toBeTruthy();
    });

    it('the failure is NOT long-lived cacheable (no-store / very short max-age)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ status: 500, ok: false })));
        const res = await SITEMAP_FILES(ctx('sitemap-index.xml'));
        const cc = res.headers.get('Cache-Control') ?? '';
        expect(cc).toMatch(/no-store|max-age=[0-5]?\d\b/);
        expect(cc).not.toMatch(/max-age=(360\d|3600|86400|\d{5,})/);
    });
});

describe('§15 UA equivalence — routing semantics are UA-independent', () => {
    const UAS: Record<string, string> = {
        browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
        generic: 'curl/8.0',
        googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    };

    for (const [label, ua] of Object.entries(UAS)) {
        it(`${label} UA: /sitemap-index.xml -> 301 canonical`, async () => {
            const res = await SITEMAP_INDEX_ALIAS({ params: {}, request: new Request('https://free2aitools.com/sitemap-index.xml', { headers: { 'user-agent': ua } }) } as any);
            expect(res.status).toBe(301);
            expect(res.headers.get('Location')).toBe(CANONICAL);
        });

        it(`${label} UA: canonical index upstream miss -> 503`, async () => {
            vi.stubGlobal('fetch', vi.fn(async () => upstream({ status: 404, ok: false })));
            const res = await SITEMAP_FILES({ params: { filename: 'sitemap-index.xml' }, request: new Request('https://free2aitools.com/sitemaps/sitemap-index.xml', { headers: { 'user-agent': ua } }) } as any);
            expect(res.status).toBe(503);
        });
    }
});
