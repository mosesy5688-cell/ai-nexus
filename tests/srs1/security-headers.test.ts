/**
 * SRS-1 GR-02 — Tier-A LIVE security headers (Founder D-184 §B). Hermetic,
 * deterministic. Proves the SSR-middleware response-path security-header applier:
 * correct human (text/html) set, correct machine/API subset, ADDITIVE preservation
 * of CORS/Cache-Control/ETag/Content-Type/status, idempotent single-value nosniff,
 * immutable-redirect no-throw, and the #2218 NO-new-top-level-import invariant.
 *
 * EXEC tier: imports the REAL exported pure functions from src/middleware.ts
 * (astro:middleware stubbed to the identity wrapper — no Worker runtime). SOURCE
 * tier: parses middleware.ts top-level imports. NON-VACUITY: a forbidden import
 * injected into the middleware source makes the import lock FAIL (mutation proof,
 * repo stays clean); the EXEC suite is anti-vacuous because the same applier that
 * sets a header is the one asserted absent on the other route class.
 *
 * Hermetic: no live network, no prod, no Worker. Pure Response/Headers objects.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// astro:middleware is a build-virtual module; stub defineMiddleware to identity so
// the production middleware.ts evaluates under vitest without the Astro build.
vi.mock('astro:middleware', () => ({ defineMiddleware: (fn: any) => fn }));

import { applyTierASecurityHeaders, isHumanHtmlResponse } from '../../src/middleware.ts';

const MW = path.resolve(__dirname, '../../src/middleware.ts');

// Count how many times a header name actually appears in a Headers object (undici
// merges duplicates into one comma-joined value via get(); the entry list is the
// authoritative single-vs-multiple signal for the "exactly one effective value").
const countHeader = (h: Headers, name: string) =>
  [...h].filter(([k]) => k.toLowerCase() === name.toLowerCase()).length;

const html = (init: ResponseInit = {}) =>
  new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

const PP = 'geolocation=(), camera=(), microphone=(), usb=(), payment=(), '
  + 'magnetometer=(), gyroscope=(), accelerometer=(), midi=(), serial=(), hid=()';

describe('GR-02 discriminator: human text/html vs machine/API', () => {
  it('text/html is human; api/asset content-types are machine (no misclassification)', () => {
    expect(isHumanHtmlResponse('text/html; charset=utf-8')).toBe(true);
    expect(isHumanHtmlResponse('TEXT/HTML')).toBe(true);
    for (const ct of ['application/json', 'application/json; charset=utf-8', 'text/plain',
      'application/wasm', 'text/javascript', 'application/javascript', 'image/jpeg',
      'application/xml', '', null, undefined]) {
      expect(isHumanHtmlResponse(ct), `${ct} must be machine`).toBe(false);
    }
  });
});

describe('GR-02 human (text/html) Tier-A set', () => {
  it('applies XFO + frame-ancestors CSP + Referrer-Policy + Permissions-Policy + nosniff', () => {
    const h = applyTierASecurityHeaders(html()).headers;
    expect(h.get('X-Frame-Options')).toBe('DENY');
    expect(h.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(h.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(h.get('Permissions-Policy')).toBe(PP);
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
  });
  it('CSP is frame-ancestors ONLY (no script/style/connect/img directives = Tier-B)', () => {
    const csp = applyTierASecurityHeaders(html()).headers.get('Content-Security-Policy')!;
    for (const d of ['script-src', 'style-src', 'connect-src', 'img-src', 'default-src', 'font-src']) {
      expect(csp).not.toContain(d);
    }
  });
  it('Permissions-Policy does NOT deny clipboard-write or fullscreen; no Tier-B headers', () => {
    const h = applyTierASecurityHeaders(html()).headers;
    expect(h.get('Permissions-Policy')).not.toContain('clipboard');
    expect(h.get('Permissions-Policy')).not.toContain('fullscreen');
    for (const f of ['geolocation', 'camera', 'microphone', 'payment', 'usb', 'hid', 'serial']) {
      expect(h.get('Permissions-Policy')).toContain(`${f}=()`);
    }
    for (const forbidden of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy',
      'Cross-Origin-Resource-Policy', 'Strict-Transport-Security']) {
      expect(h.has(forbidden), `${forbidden} (Tier-B) must NOT be set`).toBe(false);
    }
  });
});

describe('GR-02 machine/API subset', () => {
  const machine = () => new Response('{}', {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'cache-control': 'no-store',
      'etag': 'W/"abc123"',
    },
  });
  it('gets nosniff + XFO ONLY — no CSP/Referrer/Permissions/COOP/COEP/CORP', () => {
    const h = applyTierASecurityHeaders(machine()).headers;
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
    expect(h.get('X-Frame-Options')).toBe('DENY');
    for (const absent of ['Content-Security-Policy', 'Referrer-Policy', 'Permissions-Policy',
      'Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Cross-Origin-Resource-Policy']) {
      expect(h.has(absent), `${absent} must NOT be on a machine response`).toBe(false);
    }
  });
  it('preserves ACAO/ACAM/ACAH + Cache-Control + ETag + Content-Type unchanged', () => {
    const r = applyTierASecurityHeaders(machine());
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-methods')).toBe('GET,OPTIONS');
    expect(r.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('etag')).toBe('W/"abc123"');
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('GR-02 nosniff idempotency (exactly one effective value)', () => {
  it('does NOT duplicate when nosniff already present (edge-injected); preserves it', () => {
    const r = applyTierASecurityHeaders(html({ headers: {
      'content-type': 'text/html', 'x-content-type-options': 'nosniff' } }));
    expect(countHeader(r.headers, 'X-Content-Type-Options')).toBe(1);
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
  it('adds exactly one when absent', () => {
    const r = applyTierASecurityHeaders(html());
    expect(countHeader(r.headers, 'X-Content-Type-Options')).toBe(1);
  });
});

describe('GR-02 additive safety: status + immutable headers + redirect Location', () => {
  it('preserves a 410 status + Content-Type and still applies the human set', () => {
    const r = applyTierASecurityHeaders(html({ status: 410 }));
    expect(r.status).toBe(410);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('X-Frame-Options')).toBe('DENY');
  });
  it('preserves a 404 status', () => {
    expect(applyTierASecurityHeaders(html({ status: 404 })).status).toBe(404);
  });
  it('immutable redirect Response does NOT throw + status/Location preserved (best-effort skip)', () => {
    const redirect = Response.redirect('https://free2aitools.com/benchmarks', 301);
    let r!: Response;
    expect(() => { r = applyTierASecurityHeaders(redirect); }).not.toThrow();
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://free2aitools.com/benchmarks');
  });
});

describe('GR-02 #2218 cold-load: NO new top-level middleware import', () => {
  // PURE extractor over source TEXT — it never reads or writes the file itself, so
  // both the real check and the non-vacuity mutation call the same function.
  const topImports = (src: string) =>
    [...src.matchAll(/^\s*import\s[^\n]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  // Read the real tracked source ONCE into a string; every assertion runs over a
  // string. This test NEVER writes to src/middleware.ts — vitest runs files in
  // parallel and the #2218 telemetry-bundle-boundary guard reads the SAME import
  // graph; a parallel reader must never observe a mutated/dirty source.
  const source = fs.readFileSync(MW, 'utf8');
  it('middleware.ts imports ONLY astro:middleware (no helper/config/lib edge added)', () => {
    expect(topImports(source)).toEqual(['astro:middleware']);
  });
  it('NON-VACUITY: a forbidden import injected into an IN-MEMORY copy flips the lock (no fs write)', () => {
    const mutated = `import { x } from './lib/security-headers';\nvoid x;\n` + source;
    expect(topImports(mutated)).toContain('./lib/security-headers');
    expect(topImports(mutated)).not.toEqual(['astro:middleware']);
    // The real tracked source on disk is untouched and still clean.
    expect(topImports(fs.readFileSync(MW, 'utf8'))).toEqual(['astro:middleware']);
  });
});
