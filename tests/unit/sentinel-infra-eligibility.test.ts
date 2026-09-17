// tests/unit/sentinel-infra-eligibility.test.ts
//
// E-G1-01. Tier 1 had ZERO tests: the Tier-2 eligibility fix was applied to
// probePage and NOT to checkInfrastructure, and nothing executed the latter.
//
// `!stats.ok` conflated an HTTP failure with a BODY-read failure. timedRequest
// sets httpStatus when HEADERS arrive and only then reads the body, so a 200
// whose body fails leaves ok = false with httpStatus = 200 -- which fired a .gz
// fallback the baseline never fired. Worse than the Tier-2 case: the fallback's
// Last-Modified then became the freshness BASIS for the pagination-cap check,
// so a real Art 2.4 violation was reported as PASS.
//
// The one-hour staleness window and the cap's FRESH/stale arithmetic are NOT
// the defect and are deliberately unchanged; the guards below pin both. What did
// change is how p51 responses are ADMITTED to that comparison (outcome-based
// rather than status-based). The earlier wording here -- "The pagination cap and
// the one-hour staleness window are NOT the defect and are deliberately
// unchanged" -- was therefore too broad.
import { describe, it, expect, afterEach, vi } from 'vitest';
// @ts-ignore - JS ESM module under test (no .d.ts).
import { checkInfrastructure } from '../../scripts/lib/sentinel-infra.js';
// @ts-ignore - JS ESM module under test (no .d.ts).
import { isFallbackEligible } from '../../scripts/lib/sentinel-probe.js';

const LM_PRIMARY = 'Tue, 16 Sep 2026 12:00:00 GMT';   // stats primary
const LM_GZ      = 'Tue, 16 Sep 2026 14:00:00 GMT';   // stats .gz  (2h newer)
const LM_P51     = 'Tue, 16 Sep 2026 11:30:00 GMT';   // p51, 30min older than primary
const LM_P51_OLD = 'Tue, 16 Sep 2026 09:00:00 GMT';   // p51, 3h older -> genuinely stale

type Body = 'ok' | 'throws';
function response(status: number, lastModified: string, body: Body = 'ok') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'last-modified' ? lastModified : null) },
    text: () => body === 'throws'
      ? Promise.reject(new Error('primary-body-terminated'))
      : Promise.resolve('{"ok":true}')
  };
}

/** Install a fetch stub and record what was requested. */
function stubFetch(handler: (url: string, init: any) => any) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    seen.push(`${init?.method || 'GET'} ${String(url).replace('https://x.invalid', '')}`);
    return handler(String(url), init);
  });
  return seen;
}
const run = () => checkInfrastructure({ targetUrl: 'https://x.invalid', headers: {} });

afterEach(() => vi.unstubAllGlobals());

describe('E-G1-01 - a stats body failure must not re-base the freshness clock', () => {
  it('keeps FAIL, the original reason and the request evidence, and issues NO gzip request', async () => {
    // The operator's fixture. Pre-fix this returned PASS with all four p51
    // artifacts dismissed as "stale", suppressing a real Art 2.4 violation.
    const seen = stubFetch(url => {
      if (url.endsWith('category_stats.json')) return response(200, LM_PRIMARY, 'throws');
      if (url.endsWith('category_stats.json.gz')) return response(200, LM_GZ);
      return response(200, LM_P51);
    });

    const out: any = await run();

    expect(out.status).toBe('FAIL');
    expect(out.error).toBe('primary-body-terminated');          // the ORIGINAL reason
    expect(out.error).not.toMatch(/Stats fetch failed/);        // not relabelled as HTTP
    expect(seen).toEqual(['GET /cache/category_stats.json']);   // no .gz, no p51
    // Request evidence is preserved, not discarded.
    expect(out.requests).toHaveLength(1);
    expect(out.requests[0]).toMatchObject({ role: 'primary', httpStatus: 200, outcome: 'transfer-error' });
  });

  it('EVERY non-http-error outcome is ineligible - the predicate both tiers share', () => {
    // Deterministic replacement for a timing-raced probe-timeout fixture.
    // The list mixes two vocabularies on purpose: record outcomes (ok,
    // http-error, probe-timeout, transfer-error, skipped) and check outcomes
    // (content-mismatch, not-run), which are never record outcomes today. No
    // exported enum enforces either set, so this is an observation about the
    // current source, not a closed type.
    expect(isFallbackEligible({ outcome: 'http-error' })).toBe(true);
    for (const outcome of ['ok', 'probe-timeout', 'transfer-error', 'content-mismatch', 'skipped', 'not-run']) {
      expect(isFallbackEligible({ outcome }), `${outcome} must not be eligible`).toBe(false);
    }
    expect(isFallbackEligible(undefined as any)).toBe(false);
    // A 200 whose body failed is the exact shape that used to slip through.
    expect(isFallbackEligible({ outcome: 'transfer-error', httpStatus: 200 })).toBe(false);
    expect(isFallbackEligible({ outcome: 'probe-timeout', httpStatus: 200 })).toBe(false);
  });
});

describe('adjacent behaviour that must NOT change', () => {
  it('a genuine 404 primary still falls back to .gz and uses ITS Last-Modified', async () => {
    const seen = stubFetch(url => {
      if (url.endsWith('category_stats.json')) return response(404, LM_PRIMARY);
      if (url.endsWith('category_stats.json.gz')) return response(200, LM_GZ);
      return response(200, LM_P51);        // 2.5h older than the .gz -> stale -> ignored
    });
    const out: any = await run();
    expect(seen[1]).toBe('GET /cache/category_stats.json.gz');
    expect(out.status).toBe('PASS');
    expect(out.requests.map((r: any) => r.role)).toEqual(
      expect.arrayContaining(['primary', 'gz-fallback']));
  });

  it('the Art 2.4 pagination cap still FAILS on a fresh p51 (rule unchanged)', async () => {
    stubFetch(url => {
      if (url.endsWith('category_stats.json')) return response(200, LM_PRIMARY);  // body fine
      return response(200, LM_P51);                                               // 30min -> fresh
    });
    const out: any = await run();
    expect(out.status).toBe('FAIL');
    expect(out.error).toMatch(/Pagination CAP violated: text-generation\/p51\.json is FRESH \(Art 2\.4 Violation\)/);
  });

  it('the one-hour staleness window still ignores a genuinely stale p51 (rule unchanged)', async () => {
    stubFetch(url => {
      if (url.endsWith('category_stats.json')) return response(200, LM_PRIMARY);
      return response(200, LM_P51_OLD);                                           // 3h -> stale
    });
    const out: any = await run();
    expect(out.status).toBe('PASS');
  });

  it('a p51 that is not 200 is neither a violation nor a failure', async () => {
    stubFetch(url => {
      if (url.endsWith('category_stats.json')) return response(200, LM_PRIMARY);
      return response(404, LM_P51);
    });
    expect((await run() as any).status).toBe('PASS');
  });

  it('primary and .gz both non-ok keeps the legacy "Stats fetch failed" wording', async () => {
    stubFetch(url => response(url.endsWith('.gz') ? 503 : 404, LM_PRIMARY));
    const out: any = await run();
    expect(out.status).toBe('FAIL');
    expect(out.error).toBe('Stats fetch failed (503)');
  });

  it('a .gz whose OWN body fails is FAIL, not a trusted freshness basis', async () => {
    // Same class as E-G1-01, on the fallback side. "Baseline" here means the
    // PRE-WORK-ORDER implementation (82ece3305^), not the PR base 610ebe407:
    // that pre-work-order Tier 1 would have PASSED, because it never read a
    // body at all. (610ebe407 also FAILs, but with the wrong reason,
    // "Stats fetch failed (200)".) This build reads the body, so
    // the broken .gz cannot silently become the Last-Modified basis for the
    // pagination-cap check. Disclosed as a deliberate divergence from baseline,
    // in the fail-loud direction.
    stubFetch(url => {
      if (url.endsWith('category_stats.json')) return response(404, LM_PRIMARY);
      if (url.endsWith('category_stats.json.gz')) return response(200, LM_GZ, 'throws');
      return response(200, LM_P51);
    });
    const out: any = await run();
    expect(out.status).toBe('FAIL');
    expect(out.error).toBe('primary-body-terminated');
    expect(out.requests.map((r: any) => r.outcome)).toEqual(['http-error', 'transfer-error']);
  });

  it('a primary that never produced a response fails with its own reason, no fallback', async () => {
    const seen = stubFetch(() => { throw new Error('getaddrinfo ENOTFOUND'); });
    const out: any = await run();
    expect(out.status).toBe('FAIL');
    expect(out.error).toBe('getaddrinfo ENOTFOUND');
    expect(seen.some(r => r.includes('.gz'))).toBe(false);
  });
});
