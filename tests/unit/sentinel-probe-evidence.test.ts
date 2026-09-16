// tests/unit/sentinel-probe-evidence.test.ts
//
// Evidence shape of a Tier-2 check: acceptance case A1 and constraints R4, R5,
// plus the budget invariant that keeps the report/upload reserve enforceable.
//
// The artifact used to record only {name, status[, error]} per check, so a check
// that took two minutes and one that took 90ms were indistinguishable, and a
// success served by the `.gz` fallback looked exactly like a primary success.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
// @ts-ignore - JS ESM module under test (no .d.ts).
import { probePage, notRunCheck, timedRequest, DEPLOY_VERSION_HEADERS, UNKNOWN_VERSION } from '../../scripts/lib/sentinel-probe.js';
// @ts-ignore - JS ESM module under test (no .d.ts).
import {
  assertBudgetsLeaveReportReserve, budgetManifest,
  PER_CHECK_BUDGET_MS, TIER1_BUDGET_MS, TIER2_TOTAL_BUDGET_MS,
  AUDIT_NETWORK_BUDGET_MS, JOB_TIMEOUT_MS, REPORT_RESERVE_MS
} from '../../scripts/lib/sentinel-budgets.js';

const HEADERS = { 'User-Agent': 'test' };

function response(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: () => Promise.resolve(body)
  };
}

describe('A1 - primary fails, .gz fallback succeeds', () => {
  const body = JSON.stringify({ items: new Array(40).fill('x') });
  const fetchImpl = async (url: string) => url.endsWith('.gz') ? response(200, body) : response(404, 'Not found');

  it('keeps BOTH results and says plainly that the success came from the fallback', async () => {
    const check = await probePage({
      baseUrl: 'https://example.invalid',
      page: { url: '/cache/trending.json', name: 'Trending JSON', minSize: 100, critical: true },
      headers: HEADERS, budgetMs: 5_000, fetchImpl
    });

    expect(check.status).toBe('PASS');
    expect(check.requests).toHaveLength(2);
    expect(check.requests[0]).toMatchObject({ role: 'primary', httpStatus: 404, outcome: 'http-error', error: 'HTTP 404' });
    expect(check.requests[1]).toMatchObject({ role: 'gz-fallback', httpStatus: 200, outcome: 'ok' });
    expect(check.usedResponse).toBe('gz-fallback');
    expect(check.note).toContain('Success came from the .gz fallback');
    expect(check.note).toContain('the primary request');
    expect(check.note).toContain('HTTP 404');
  });

  it('the body that was content-checked is the fallback body, not the primary body', async () => {
    const check = await probePage({
      baseUrl: 'https://example.invalid',
      page: { url: '/cache/trending.json', name: 'Trending JSON', minSize: 100, critical: true },
      headers: HEADERS, budgetMs: 5_000, fetchImpl
    });
    // The 404 body ('Not found', 9 bytes) would have failed minSize 100.
    expect(check.requests[0].bodyLength).toBeNull();
    expect(check.requests[1].bodyLength).toBe(body.length);
  });
});

describe('R4 - existing health-report.json fields survive; new ones are additive', () => {
  it('a passing check still carries {name, status} and carries NO error key', async () => {
    const fetchImpl = async () => response(200, 'Free AI Tools live');
    const check = await probePage({
      baseUrl: 'https://example.invalid',
      page: { url: '/', name: 'Home', text: 'Free AI Tools', critical: true },
      headers: HEADERS, budgetMs: 5_000, fetchImpl
    });
    expect(check.name).toBe('Home');
    expect(check.status).toBe('PASS');
    expect(Object.prototype.hasOwnProperty.call(check, 'error')).toBe(false);
    // Additive instrumentation.
    expect(typeof check.durationMs).toBe('number');
    expect(check.budgetMs).toBe(5_000);
    expect(Array.isArray(check.requests)).toBe(true);
  });

  it('a failing check still carries {name, status, error}', async () => {
    const fetchImpl = async () => response(500, 'boom');
    const check = await probePage({
      baseUrl: 'https://example.invalid',
      page: { url: '/', name: 'Home', text: 'Free AI Tools', critical: true },
      headers: HEADERS, budgetMs: 5_000, fetchImpl
    });
    expect(check).toMatchObject({ name: 'Home', status: 'FAIL', error: 'HTTP 500' });
  });

  it('a check that did not run is recorded as FAIL with a not-run outcome, never as PASS', () => {
    const skipped = notRunCheck({ url: '/ranking', name: 'Rankings', critical: true }, TIER2_TOTAL_BUDGET_MS);
    expect(skipped.status).toBe('FAIL');
    expect(skipped.status).not.toBe('PASS');
    expect(skipped.outcome).toBe('not-run');
    expect(skipped.error).toMatch(/^Not run: the Tier 2 total budget \(150000ms\) was exhausted/);
    // It is an absence of evidence, not a verdict against the page.
    expect(skipped.note).toContain('Not a verdict on this page');
    expect(skipped.requests).toEqual([]);
  });
});

describe('R5 - the served version is distinguished from the checking script', () => {
  it('records a real deploy identifier when the response carries one', async () => {
    const fetchImpl = async () => response(200, 'Free AI Tools', { 'x-deploy-id': 'deploy-abc123' });
    const { record } = await timedRequest({
      role: 'primary', url: 'https://example.invalid/', headers: HEADERS,
      deadlineAt: Date.now() + 5_000, fetchImpl
    });
    expect(record.responseVersion).toBe('deploy-abc123');
  });

  it('records "unknown" when the response carries no deploy identifier', async () => {
    const fetchImpl = async () => response(200, 'Free AI Tools');
    const { record } = await timedRequest({
      role: 'primary', url: 'https://example.invalid/', headers: HEADERS,
      deadlineAt: Date.now() + 5_000, fetchImpl
    });
    expect(record.responseVersion).toBe(UNKNOWN_VERSION);
    expect(record.responseVersion).toBe('unknown');
  });

  it('X-Guardian-Version is NOT treated as a version: it is a middleware string literal', async () => {
    // src/middleware.ts sets it to the constant 'v18.12.5-resilient', identical on
    // every deploy. Accepting it would report a version that identifies nothing.
    expect(DEPLOY_VERSION_HEADERS).not.toContain('x-guardian-version');
    const fetchImpl = async () => response(200, 'Free AI Tools', {
      'x-guardian-version': 'v18.12.5-resilient',
      'x-guardian-time': '1118.00ms',
      'cf-cache-status': 'HIT'
    });
    const { record } = await timedRequest({
      role: 'primary', url: 'https://example.invalid/', headers: HEADERS,
      deadlineAt: Date.now() + 5_000, fetchImpl
    });
    expect(record.responseVersion).toBe('unknown');
    // Both are still captured raw as observations, just not as a version.
    expect(record.originRenderHeader).toBe('1118.00ms');
    expect(record.cfCacheStatus).toBe('HIT');
  });
});

describe('budgets leave the report/upload reserve', () => {
  it('the configured budgets satisfy the invariant', () => {
    expect(AUDIT_NETWORK_BUDGET_MS).toBe(TIER1_BUDGET_MS + TIER2_TOTAL_BUDGET_MS);
    expect(AUDIT_NETWORK_BUDGET_MS).toBeLessThanOrEqual(JOB_TIMEOUT_MS - REPORT_RESERVE_MS);
    expect(() => assertBudgetsLeaveReportReserve()).not.toThrow();
    expect(REPORT_RESERVE_MS).toBeGreaterThanOrEqual(3 * 60 * 1000);
  });

  it('the invariant is enforced, not decorative: an over-budget configuration throws', () => {
    expect(() => assertBudgetsLeaveReportReserve({ auditMs: JOB_TIMEOUT_MS - REPORT_RESERVE_MS + 1 }))
      .toThrow(/Sentinel budget invariant violated/);
  });

  it('per-check 45s sits below the documented 125s Cloudflare Proxy Read Timeout', () => {
    expect(PER_CHECK_BUDGET_MS).toBe(45_000);
    expect(PER_CHECK_BUDGET_MS).toBeLessThan(125_000);
    expect(TIER2_TOTAL_BUDGET_MS).toBe(150_000);
  });

  it('the budget block is exported into the report so the artifact is self-describing', () => {
    expect(budgetManifest()).toMatchObject({
      perCheckMs: 45_000, tier1TotalMs: 90_000, tier2TotalMs: 150_000,
      auditNetworkMs: 240_000, jobTimeoutMs: 600_000, reportReserveMs: 180_000
    });
  });
});

describe('sentinel-prod.js orchestration (static text lock)', () => {
  const sentinel = fs.readFileSync(path.resolve(__dirname, '../../scripts/sentinel-prod.js'), 'utf8').replace(/\r\n/g, '\n');

  it('enforces the budget invariant at import time, before any request is issued', () => {
    expect(sentinel).toContain('assertBudgetsLeaveReportReserve();');
  });

  it('clamps the per-check budget by what the Tier-2 total has left', () => {
    // Without the clamp, four 45s checks could run to 180s against a 150s total.
    expect(sentinel).toContain('Math.min(PER_CHECK_BUDGET_MS, remaining)');
  });

  it('records an unreached check via notRunCheck, and marks it critical-unhealthy', () => {
    expect(sentinel).toContain('notRunCheck(page, TIER2_TOTAL_BUDGET_MS)');
    expect(sentinel).toContain('if (page.critical) finalReport.healthy = false;');
  });

  it('emits the report from a finally block, so a throwing audit still produces one', () => {
    expect(sentinel).toMatch(/} finally \{[\s\S]{0,200}emitReport\(finalReport\);/);
    expect(sentinel).toContain('`Audit aborted: ${err.message}`');
  });

  it('labels the checkout SHA as the checking script, never as the served version', () => {
    expect(sentinel).toContain("commit: process.env.GITHUB_SHA || 'unknown'");
    expect(sentinel).toContain('Identifies this checking script, not the served version.');
  });
});
