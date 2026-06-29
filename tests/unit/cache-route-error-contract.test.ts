/**
 * Cache-route error-contract invariant (GR-04, D-184 §C / D-186 §F, SECURITY).
 *
 * src/pages/cache/[...path].js is a RETAIN_JUSTIFIED prod route: ranking
 * infinite-scroll (p2-p5) and monitoring consume cache/ keys that the CDN 403s.
 * The route is prefix-locked to the literal `cache/` prefix (no SSRF).
 *
 * The ONE authorized hardening: on the 500 catch path the route must NOT
 * reflect the raw exception message (or stack / object key / R2 binding detail)
 * to the client. It must return a DETERMINISTIC GENERIC 500. Server-side
 * logging of the real error is allowed.
 *
 * This guard locks that contract and is anti-vacuity hardened: re-introducing
 * `{ error: e.message }` on the 500 path turns the leak assertion RED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted controllable R2 stub injected as the cloudflare:workers `env` binding.
const { mockR2 } = vi.hoisted(() => ({ mockR2: { get: vi.fn() } }));
vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: mockR2 } }));

// @ts-ignore — JS route module, no .d.ts
import { GET } from '../../src/pages/cache/[...path].js';

// A secret-bearing error: every distinctive token here is something that must
// NOT appear in the client-visible response body.
const SECRET = 'R2_ASSETS binding boom at cache/rankings/ai/p2.json :: stack@line42';

beforeEach(() => {
    mockR2.get.mockReset();
});

describe('cache route error-contract invariant (GR-04)', () => {
    it('thrown R2 error => deterministic generic 500, raw message ABSENT', async () => {
        mockR2.get.mockRejectedValue(new Error(SECRET));
        const res = await GET({ params: { path: 'rankings/ai/p2.json' } });
        expect(res.status).toBe(500);
        const body = await res.text();
        // Deterministic generic shape.
        expect(JSON.parse(body)).toEqual({ error: 'Internal Server Error' });
        // ANTI-VACUITY: the raw exception message and its leaky tokens are gone.
        expect(body).not.toContain(SECRET);
        expect(body).not.toContain('boom');
        expect(body).not.toContain('stack@line42');
        expect(body).not.toContain('R2_ASSETS');
        expect(body).not.toContain('cache/rankings/ai/p2.json');
        expect(body.toLowerCase()).not.toContain('stack');
    });

    it('200 path streams the body and preserves metadata + ETag + Cache-Control', async () => {
        const writeHttpMetadata = vi.fn((h: Headers) => h.set('content-type', 'application/json'));
        const fakeBody = 'stream-body-bytes';
        mockR2.get.mockResolvedValue({
            body: fakeBody,
            httpEtag: '"etag-abc123"',
            writeHttpMetadata,
        });
        const res = await GET({ params: { path: 'rankings/ai/p1.json' } });
        expect(res.status).toBe(200);
        expect(writeHttpMetadata).toHaveBeenCalledOnce();
        expect(res.headers.get('etag')).toBe('"etag-abc123"');
        expect(res.headers.get('content-type')).toBe('application/json');
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
        expect(await res.text()).toBe(fakeBody);
    });

    it('missing object stays 404 (not 500, not leaked)', async () => {
        mockR2.get.mockResolvedValue(null);
        const res = await GET({ params: { path: 'rankings/ai/p99.json' } });
        expect(res.status).toBe(404);
        expect(JSON.parse(await res.text())).toEqual({ error: 'Not found' });
    });

    it('missing path stays 400 and never touches R2', async () => {
        const res = await GET({ params: { path: undefined } });
        expect(res.status).toBe(400);
        expect(JSON.parse(await res.text())).toEqual({ error: 'Path required' });
        expect(mockR2.get).not.toHaveBeenCalled();
    });

    it('R2 key is the LITERAL cache/ prefix joined to the path (no traversal/escape)', async () => {
        mockR2.get.mockResolvedValue(null);
        await GET({ params: { path: 'rankings/ai/p2.json' } });
        expect(mockR2.get).toHaveBeenCalledWith('cache/rankings/ai/p2.json');
        // Even a traversal-shaped path is still anchored under the cache/ prefix.
        mockR2.get.mockClear();
        await GET({ params: { path: '../secret' } });
        const key = mockR2.get.mock.calls[0][0] as string;
        expect(key.startsWith('cache/')).toBe(true);
    });
});

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (rel: string) => resolve(root, rel);

describe('cache route consumer preserved (GR-04 scope guard)', () => {
    it('ranking-client.js still consumes the /cache/ pagination route (unchanged)', () => {
        const f = abs('src/scripts/ranking-client.js');
        expect(existsSync(f), 'ranking-client consumer must remain').toBe(true);
        const src = readFileSync(f, 'utf8');
        expect(src).toContain('/cache/rankings/');
        expect(src).toContain('p${nextPage}.json');
    });

    it('the cache route stays GET-only and never reflects e.message on 500', () => {
        const src = readFileSync(abs('src/pages/cache/[...path].js'), 'utf8');
        expect(src).toContain('export async function GET');
        expect(src).not.toMatch(/POST|PUT|DELETE|PATCH/);
        // The leaky reflection must be gone; the generic body must be present.
        expect(src).not.toContain('error: e.message');
        expect(src).toContain("error: 'Internal Server Error'");
    });
});
