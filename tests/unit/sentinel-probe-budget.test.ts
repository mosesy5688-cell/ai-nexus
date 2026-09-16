// tests/unit/sentinel-probe-budget.test.ts
//
// Budget + abort semantics of the Tier-2 page probe (scripts/lib/sentinel-probe.js).
// Covers acceptance cases A2, A3, A4 and constraints R1, R2, R3.
//
// The previous implementation had NO timeout at all: `let res = await fetch(url)`
// could wait until the job's own timeout-minutes killed it, and a killed job
// writes no health-report.json. These tests pin the replacement.
//
// Real timers are used deliberately: the assertion under test is that an
// AbortController actually fires and terminates the in-flight request (R2), which
// a fake-timer harness would not demonstrate. Margins are wide enough that the
// pass/fail boundary is the reset-timer mutant, not scheduler jitter.
import { describe, it, expect } from 'vitest';
// @ts-ignore - JS ESM module under test (no .d.ts).
import { probePage, timedRequest } from '../../scripts/lib/sentinel-probe.js';

type FakeInit = { signal: AbortSignal; headers?: Record<string, string>; method?: string };

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: () => Promise.resolve(body)
  };
}

/** A response whose body never settles until the caller's signal aborts. */
function stallingBodyResponse(status: number, seen: { aborted: boolean }, init: FakeInit) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: () => new Promise<string>((_res, reject) => {
      init.signal.addEventListener('abort', () => {
        seen.aborted = true;
        reject(new Error('The operation was aborted.'));
      });
    })
  };
}

/** A request that never returns headers until the caller's signal aborts. */
function stallingRequest(seen: { aborted: boolean }, init: FakeInit) {
  return new Promise((_res, reject) => {
    init.signal.addEventListener('abort', () => {
      seen.aborted = true;
      reject(new Error('The operation was aborted.'));
    });
  });
}

const HEADERS = { 'User-Agent': 'test' };

describe('A2 - primary 524, .gz fallback 404: BOTH statuses preserved', () => {
  it('keeps each request record and still reports the primary status as the error', async () => {
    const fetchImpl = async (url: string) => jsonResponse(url.endsWith('.gz') ? 404 : 524, 'x');
    const check = await probePage({
      baseUrl: 'https://example.invalid',
      page: { url: '/ranking', name: 'Rankings', text: 'AI Ecosystem Rankings', critical: true },
      headers: HEADERS, budgetMs: 5_000, fetchImpl
    });

    expect(check.status).toBe('FAIL');
    expect(check.requests).toHaveLength(2);
    expect(check.requests[0]).toMatchObject({ role: 'primary', httpStatus: 524, outcome: 'http-error' });
    expect(check.requests[1]).toMatchObject({ role: 'gz-fallback', httpStatus: 404, outcome: 'http-error' });
    expect(check.usedResponse).toBe('none');
    // Previous behaviour preserved: a failed fallback leaves the ORIGINAL status
    // in the thrown message. The fallback's own 404 is not lost - it is in requests[].
    expect(check.error).toBe('HTTP 524');
  });
});

describe('A3 / R2 / R3 - HTTP 200 then the body stalls', () => {
  it('aborts the in-flight request, records a probe timeout, and never calls it 524', async () => {
    const seen = { aborted: false };
    const fetchImpl = async (_url: string, init: FakeInit) => stallingBodyResponse(200, seen, init);

    const started = Date.now();
    const check = await probePage({
      baseUrl: 'https://example.invalid',
      page: { url: '/', name: 'Home', text: 'Free AI Tools', critical: true },
      headers: HEADERS, budgetMs: 250, fetchImpl
    });
    const elapsed = Date.now() - started;

    // R2: the client request was actually aborted, not merely abandoned.
    expect(seen.aborted).toBe(true);
    expect(check.status).toBe('FAIL');
    expect(check.outcome).toBe('probe-timeout');
    // R3: a body that stalls AFTER a 200 still fails honestly, and the 200 that
    // did arrive is recorded rather than being rewritten into the failure.
    expect(check.requests[0].httpStatus).toBe(200);
    expect(check.requests[0].timedOutDuring).toBe('body');
    // R3: a local deadline is never dressed up as a CDN status.
    expect(JSON.stringify(check)).not.toContain('524');
    expect(check.error).toMatch(/Probe timeout after 250ms during body read \(local abort/);
    expect(elapsed).toBeLessThan(1_500);
  });

  it('a stall BEFORE headers is recorded as a headers-phase probe timeout with no status', async () => {
    const seen = { aborted: false };
    const fetchImpl = (_url: string, init: FakeInit) => stallingRequest(seen, init);
    const check = await probePage({
      baseUrl: 'https://example.invalid',
      page: { url: '/', name: 'Home', text: 'Free AI Tools', critical: true },
      headers: HEADERS, budgetMs: 200, fetchImpl
    });
    expect(seen.aborted).toBe(true);
    expect(check.requests[0]).toMatchObject({ httpStatus: null, outcome: 'probe-timeout', timedOutDuring: 'headers' });
    // Eligibility unchanged: a request that produced no response gets NO fallback.
    expect(check.requests).toHaveLength(1);
  });
});

describe('A4 / R1 - the fallback shares the check budget, it does not reset it', () => {
  it('a slow primary leaves the fallback only the remainder, and the check stays inside its budget', async () => {
    const BUDGET = 400;
    const PRIMARY_MS = 300;
    const seen = { aborted: false };
    const fetchImpl = async (url: string, init: FakeInit) => {
      if (url.endsWith('.gz')) return stallingRequest(seen, init);
      await new Promise(r => setTimeout(r, PRIMARY_MS));
      return jsonResponse(404, 'not found');
    };

    const started = Date.now();
    const check = await probePage({
      baseUrl: 'https://example.invalid',
      page: { url: '/cache/trending.json', name: 'Trending JSON', minSize: 100, critical: true },
      headers: HEADERS, budgetMs: BUDGET, fetchImpl
    });
    const elapsed = Date.now() - started;

    expect(seen.aborted).toBe(true);
    expect(check.requests).toHaveLength(2);
    expect(check.requests[1].outcome).toBe('probe-timeout');
    // The mutant this kills: giving the fallback a fresh `budgetMs` would make the
    // fallback alone wait ~400ms and the check ~700ms. Both bounds below fail then.
    expect(check.requests[1].durationMs).toBeLessThan(BUDGET - PRIMARY_MS + 150);
    expect(check.durationMs).toBeLessThan(BUDGET + 250);
    expect(elapsed).toBeLessThan(BUDGET + 400);
  });
});

describe('R1 - a request due to start after the deadline is skipped, not issued', () => {
  it('records a skipped request and never calls fetch', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return jsonResponse(200, 'ok'); };
    const { record, ok } = await timedRequest({
      role: 'gz-fallback', url: 'https://example.invalid/x.gz', headers: HEADERS,
      deadlineAt: Date.now() - 1, fetchImpl
    });
    expect(calls).toBe(0);
    expect(ok).toBe(false);
    expect(record.outcome).toBe('skipped');
    expect(record.error).toMatch(/budget was already exhausted/);
  });
});

describe('content checks are unchanged', () => {
  it('a 200 whose body misses the expected text fails with the original message', async () => {
    const fetchImpl = async () => jsonResponse(200, 'nothing here');
    const check = await probePage({
      baseUrl: 'https://example.invalid',
      page: { url: '/', name: 'Home', text: 'Free AI Tools', critical: true },
      headers: HEADERS, budgetMs: 2_000, fetchImpl
    });
    expect(check.status).toBe('FAIL');
    expect(check.outcome).toBe('content-mismatch');
    expect(check.error).toBe('Text missing: "Free AI Tools"');
  });

  it('a 200 whose body is under minSize fails with the original message', async () => {
    const fetchImpl = async () => jsonResponse(200, 'ab');
    const check = await probePage({
      baseUrl: 'https://example.invalid',
      page: { url: '/cache/trending.json', name: 'Trending JSON', minSize: 100, critical: true },
      headers: HEADERS, budgetMs: 2_000, fetchImpl
    });
    expect(check.error).toBe('Payload too small: 2b < 100b');
  });
});
