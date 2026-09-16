// tests/unit/ssr-warm-coverage.test.ts
//
// Warm coverage and warm-result verifiability (work-order items 1 and 2) plus
// acceptance case A5.
//
// The previous inline loop in factory-upload.yml was
//   curl -s -o /dev/null --max-time 20 ... || true
// which discarded the status code (no -w), the body (-o /dev/null) and the exit
// code (|| true), so a URL that returned instantly left a log line
// indistinguishable from one that had been warmed.
import { describe, it, expect } from 'vitest';
// @ts-ignore - JS ESM module under test (no .d.ts).
import {
  SSR_WARM_PATHS, PER_URL_MAX_TIME_S, PHASE_BUDGET_MS, CURL_EXIT_OPERATION_TIMEDOUT,
  classifyWarm, summarise, runWarmPlan, formatSummary, parseWriteOut
} from '../../scripts/factory/lib/ssr-warm-core.js';

const ORIGINAL_FOUR = [
  '/api/v1/entity/meta-llama/Llama-3.1-8B-Instruct',
  '/api/v1/entity/openai-community/gpt2',
  '/model/meta-llama/Llama-3.1-8B-Instruct',
  '/models'
];

describe('item 1 - warm coverage', () => {
  it('warms the two pages the health probe treats as critical', () => {
    // Neither was in the warm list before this change.
    expect(SSR_WARM_PATHS).toContain('/');
    expect(SSR_WARM_PATHS).toContain('/ranking');
  });

  it('keeps the four pre-existing URLs, in their original relative order', () => {
    for (const p of ORIGINAL_FOUR) expect(SSR_WARM_PATHS).toContain(p);
    const kept = SSR_WARM_PATHS.filter((p: string) => ORIGINAL_FOUR.includes(p));
    expect(kept).toEqual(ORIGINAL_FOUR);
  });

  it('the critical pages are warmed first so budget pressure drops the least critical target', () => {
    expect(SSR_WARM_PATHS[0]).toBe('/');
    expect(SSR_WARM_PATHS[1]).toBe('/ranking');
    expect(SSR_WARM_PATHS).toHaveLength(6);
  });

  it('keeps one request per URL at the existing 20s cap, under a 100s phase budget', () => {
    expect(PER_URL_MAX_TIME_S).toBe(20);
    expect(PHASE_BUDGET_MS).toBe(100_000);
    // Worst case grows by 20s, not 40s: 5 URLs can burn 20s each, then the
    // budget stops the 6th. The four pre-existing URLs can always still start
    // (4 x 20s = 80s < 100s).
    expect(4 * PER_URL_MAX_TIME_S * 1000).toBeLessThan(PHASE_BUDGET_MS);
    expect(5 * PER_URL_MAX_TIME_S * 1000).toBeGreaterThanOrEqual(PHASE_BUDGET_MS);
  });
});

describe('item 2 - classification of one warm attempt', () => {
  it('2xx and 3xx with a clean curl exit are successes', () => {
    expect(classifyWarm({ curlExit: 0, httpStatus: 200 })).toBe('succeeded');
    expect(classifyWarm({ curlExit: 0, httpStatus: 301 })).toBe('succeeded');
  });
  it('a served error status is an HTTP failure, not a success', () => {
    expect(classifyWarm({ curlExit: 0, httpStatus: 500 })).toBe('http-failure');
    expect(classifyWarm({ curlExit: 0, httpStatus: 404 })).toBe('http-failure');
    expect(classifyWarm({ curlExit: 0, httpStatus: 524 })).toBe('http-failure');
  });
  it('curl exit 28 is a timeout and outranks whatever http_code curl printed', () => {
    expect(CURL_EXIT_OPERATION_TIMEDOUT).toBe(28);
    expect(classifyWarm({ curlExit: 28, httpStatus: null })).toBe('timeout');
    expect(classifyWarm({ curlExit: 28, httpStatus: 200 })).toBe('timeout');
  });
  it('any other non-zero curl exit is a transfer failure', () => {
    expect(classifyWarm({ curlExit: 6, httpStatus: null })).toBe('transfer-failure');
    expect(classifyWarm({ curlExit: 7, httpStatus: null })).toBe('transfer-failure');
  });
});

describe('item 2 - per-URL record and reconciling summary', () => {
  it('records url, UTC-Z start, duration, HTTP status and curl exit for every URL', async () => {
    let clock = 1_757_000_000_000;
    const now = () => clock;
    const execute = async (url: string) => {
      clock += 1_000;
      return { curlExit: 0, httpStatus: 200, durationMs: 1_000, url };
    };
    const { records } = await runWarmPlan({ urls: ['https://x.invalid/a', 'https://x.invalid/b'], now, execute });
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(typeof r.url).toBe('string');
      expect(r.startedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(typeof r.durationMs).toBe('number');
      expect(r.httpStatus).toBe(200);
      expect(r.curlExit).toBe(0);
    }
  });

  it('the five summary buckets always reconcile with the total', () => {
    const records = [
      { outcome: 'succeeded' }, { outcome: 'succeeded' }, { outcome: 'http-failure' },
      { outcome: 'transfer-failure' }, { outcome: 'timeout' }, { outcome: 'skipped' }
    ];
    const s = summarise(records);
    expect(s).toEqual({ total: 6, succeeded: 2, httpFailure: 1, transferFailure: 1, timeout: 1, skipped: 1 });
    expect(s.succeeded + s.httpFailure + s.transferFailure + s.timeout + s.skipped).toBe(s.total);
    expect(formatSummary(s)).toContain('total=6 succeeded=2 http-failure=1 transfer-failure=1 timeout=1 skipped=1');
  });

  it("parses curl's write-out, including the 000 http_code a timed-out curl prints", () => {
    expect(parseWriteOut('200 4.576548')).toEqual({ httpStatus: 200, durationMs: 4577 });
    expect(parseWriteOut('000 20.001000')).toEqual({ httpStatus: null, durationMs: 20001 });
    expect(parseWriteOut('')).toEqual({ httpStatus: null, durationMs: null });
  });
});

describe('A5 - a failing warm URL is recorded and the loop continues', () => {
  it('500, transfer failure and timeout are each recorded as failed, and every later URL still runs', async () => {
    let clock = 1_757_000_000_000;
    const now = () => clock;
    const attempted: string[] = [];
    const scripted: Record<string, any> = {
      u2: { curlExit: 0, httpStatus: 500, durationMs: 120 },
      u3: { curlExit: 7, httpStatus: null, durationMs: 40, error: 'Failed to connect' },
      u4: { curlExit: 28, httpStatus: null, durationMs: 20_000 }
    };
    const execute = async (url: string) => {
      attempted.push(url);
      const r = scripted[url] || { curlExit: 0, httpStatus: 200, durationMs: 500 };
      clock += r.durationMs;
      return r;
    };

    const urls = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
    const { records, summary } = await runWarmPlan({ urls, budgetMs: 10_000_000, now, execute });

    expect(attempted).toEqual(urls);                       // nothing short-circuited
    expect(records.map((r: any) => r.outcome)).toEqual([
      'succeeded', 'http-failure', 'transfer-failure', 'timeout', 'succeeded', 'succeeded'
    ]);
    expect(summary).toEqual({ total: 6, succeeded: 3, httpFailure: 1, transferFailure: 1, timeout: 1, skipped: 0 });
    expect(records[2].error).toBe('Failed to connect');
  });

  it('a runner that throws is recorded, not propagated: the remaining URLs still run', async () => {
    const attempted: string[] = [];
    const execute = async (url: string) => {
      attempted.push(url);
      if (url === 'u1') throw new Error('spawn curl ENOENT');
      return { curlExit: 0, httpStatus: 200, durationMs: 5 };
    };
    const { records, summary } = await runWarmPlan({ urls: ['u1', 'u2'], execute });
    expect(attempted).toEqual(['u1', 'u2']);
    expect(records[0].outcome).toBe('transfer-failure');
    expect(records[0].error).toBe('spawn curl ENOENT');
    expect(summary.succeeded).toBe(1);
  });
});

describe('the phase budget is real: a URL past the deadline is skipped, not silently dropped', () => {
  it('records the remaining URLs as skipped and never executes them', async () => {
    let clock = 1_757_000_000_000;
    const now = () => clock;
    const attempted: string[] = [];
    const execute = async (url: string) => {
      attempted.push(url);
      clock += 20_000;
      return { curlExit: 0, httpStatus: 200, durationMs: 20_000 };
    };
    const urls = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
    const { records, summary } = await runWarmPlan({ urls, budgetMs: PHASE_BUDGET_MS, now, execute });

    expect(attempted).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
    expect(records[5].outcome).toBe('skipped');
    expect(records[5].httpStatus).toBeNull();
    expect(records[5].curlExit).toBeNull();
    expect(records[5].error).toMatch(/below the 4000ms minimum slot/);
    expect(summary.skipped).toBe(1);
    expect(summary.total).toBe(6);
  });
});
