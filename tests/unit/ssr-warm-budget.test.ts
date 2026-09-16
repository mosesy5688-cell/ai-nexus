// tests/unit/ssr-warm-budget.test.ts
//
// The warm phase budget must constrain EXECUTION, not merely gate STARTS.
//
// Before the slot model, runWarmPlan checked the budget before each URL but
// never sized the per-URL cap from what remained, so five URLs could finish at
// 99,995ms of a 100,000ms budget and the sixth still started with a full 20s
// cap. And the subprocess wait was `capMs + 1000` on the DEFAULT SIGTERM, which
// Node documents as not bounding the wait at all (see ssr-warm-budget.js).
//
// Numbers asserted here are RESULTS FOR THESE FIXTURES, not wall-clock upper
// bounds over all execution paths: they hold while the two named assumptions in
// ssr-warm-budget.js hold. The process-level counterpart is
// tests/unit/ssr-warm-entrypoint.test.ts.
import { describe, it, expect } from 'vitest';
// @ts-ignore - JS ESM module under test (no .d.ts).
import {
  PER_URL_MAX_TIME_S, PHASE_BUDGET_MS, runWarmPlan, buildCurlArgs,
  curlCapForRemaining, subprocessWaitMs,
  KILL_GRACE_MS, SPAWN_OVERHEAD_MS, MIN_CURL_CAP_MS, MIN_URL_SLOT_MS
} from '../../scripts/factory/lib/ssr-warm-core.js';

describe('F1 - the phase budget is a COMPLETION deadline, not just a start gate', () => {
  // Before the clamp, runWarmPlan gated STARTS only: five URLs could finish at
  // 99,995ms of a 100,000ms budget and the sixth still started with a full 20s
  // cap, so the phase ran to 119,994ms (129,995ms on the curl-wedge path) --
  // an added wait of 39,994ms / 49,995ms against a 40,000ms ceiling.

  // A URL's slot is curl cap + KILL_GRACE_MS + SPAWN_OVERHEAD_MS. The fake
  // below spends exactly that, i.e. it models the WORST case in which curl
  // ignores its own --max-time and has to be SIGKILLed after the grace.
  const worstCaseSlot = (remainingMs: number) =>
    subprocessWaitMs(curlCapForRemaining(remainingMs)) + SPAWN_OVERHEAD_MS;

  it('hands each URL the REMAINING budget, strictly decreasing', async () => {
    let clock = 0; const now = () => clock;
    const handed: number[] = [];
    const execute = async (_url: string, remainingMs: number) => {
      handed.push(remainingMs);
      clock += worstCaseSlot(remainingMs);
      return { curlExit: 28, httpStatus: null, durationMs: 0 };
    };
    await runWarmPlan({ urls: ['a', 'b', 'c', 'd', 'e', 'f'], budgetMs: PHASE_BUDGET_MS, now, execute });
    expect(handed[0]).toBe(PHASE_BUDGET_MS);
    for (let i = 1; i < handed.length; i++) expect(handed[i]).toBeLessThan(handed[i - 1]);
  });

  it('the phase stays inside its budget on the worst-case slot for every URL', async () => {
    let clock = 0; const now = () => clock;
    const execute = async (_url: string, remainingMs: number) => {
      clock += worstCaseSlot(remainingMs);
      return { curlExit: 28, httpStatus: null, durationMs: 0 };
    };
    await runWarmPlan({ urls: ['a', 'b', 'c', 'd', 'e', 'f'], budgetMs: PHASE_BUDGET_MS, now, execute });
    // RESULT FOR THIS FIXTURE, not a wall-clock upper bound over all execution
    // paths: it holds only while the two named assumptions hold (spawn+teardown
    // fits SPAWN_OVERHEAD_MS; SIGKILL removes curl promptly).
    expect(clock).toBeLessThanOrEqual(PHASE_BUDGET_MS);
    // ...and therefore inside the work order's 40s ceiling on the ADDED wait.
    expect(clock - 4 * PER_URL_MAX_TIME_S * 1000).toBeLessThanOrEqual(40_000);
  });

  it('every started URL fits in what the budget had left', async () => {
    let clock = 0; const now = () => clock;
    const fits: boolean[] = [];
    const execute = async (_url: string, remainingMs: number) => {
      fits.push(worstCaseSlot(remainingMs) <= remainingMs);
      clock += worstCaseSlot(remainingMs);
      return { curlExit: 28, httpStatus: null, durationMs: 0 };
    };
    await runWarmPlan({ urls: ['a', 'b', 'c', 'd', 'e', 'f'], budgetMs: PHASE_BUDGET_MS, now, execute });
    expect(fits.length).toBeGreaterThan(0);
    expect(fits.every(Boolean)).toBe(true);
  });

  it('a sub-slot remainder must SKIP, not start a URL that cannot finish', async () => {
    // 95s budget: four full slots consume 92s, leaving 3s -- under MIN_URL_SLOT_MS.
    // A gate of `remaining <= 0` would start that URL anyway and overrun to 96s.
    let clock = 0; const now = () => clock;
    const started: string[] = [];
    const execute = async (url: string, remainingMs: number) => {
      started.push(url);
      clock += worstCaseSlot(remainingMs);
      return { curlExit: 28, httpStatus: null, durationMs: 0 };
    };
    const { records } = await runWarmPlan({ urls: ['a', 'b', 'c', 'd', 'e', 'f'], budgetMs: 95_000, now, execute });
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    expect(records[4].outcome).toBe('skipped');
    expect(clock).toBeLessThanOrEqual(95_000);
  });

  it('the slot terms are named and add up; none is hidden in a "+1000"', () => {
    expect(MIN_URL_SLOT_MS).toBe(MIN_CURL_CAP_MS + KILL_GRACE_MS + SPAWN_OVERHEAD_MS);
    expect(subprocessWaitMs(20_000)).toBe(20_000 + KILL_GRACE_MS);
    // A full budget leaves the per-URL cap at the unchanged 20s.
    expect(curlCapForRemaining(PHASE_BUDGET_MS)).toBe(PER_URL_MAX_TIME_S * 1000);
    // A short remainder buys curl only what is left after grace + overhead.
    expect(curlCapForRemaining(8_000)).toBe(8_000 - KILL_GRACE_MS - SPAWN_OVERHEAD_MS);
    expect(curlCapForRemaining(MIN_URL_SLOT_MS)).toBe(MIN_CURL_CAP_MS);
  });

  it('the curl argv carries the CLAMPED cap, not the constant', () => {
    // Asserted on the actual argv, not on a text match against the source.
    expect(buildCurlArgs('https://x.invalid/', curlCapForRemaining(19_000), '/dev/null'))
      .toEqual(['-s', '-o', '/dev/null', '--max-time', '16', '-H',
                'User-Agent: Nexus-Warmer/1.0', '-w', '%{http_code} %{time_total}', 'https://x.invalid/']);
    expect(buildCurlArgs('https://x.invalid/', curlCapForRemaining(PHASE_BUDGET_MS), '/dev/null')[4]).toBe('20');
  });
});
