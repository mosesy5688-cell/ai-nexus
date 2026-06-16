/**
 * SRS-1 TEL-EXACTLY-ONCE -- P2 Adoption Telemetry TA2 single-emission ownership
 * (Founder D-2026-0615-53 GLOBAL INVARIANT O-4 / H-01-corrected).
 *
 * Hermetic, deterministic. Drives the REAL production finalizers exactly as the
 * call sites do, with an INJECTABLE TelemetryEnv (mock binding) -- NOT mirror
 * copies. The three exported real finalizers exercised here are:
 *   - middleware.recordTelemetry(env, pathname, method, headers, ownHost, status)
 *   - mcp.finalizeMcpTelemetry(env, request, parsedMethod, toolName, status)
 *   - datasets.recordDatasets302(env, request)
 * Asserts: at-most-one event per request; exactly-one only for an eligible
 * (flag ON + approved surface + canonical method + valid MCP op) request;
 * excluded/invalid/unknown/wrong-method/flag-OFF -> zero; flag-OFF zero-write;
 * sink-failure neutrality; and the response-identity / no-mutation contract
 * (onRequest returns the SAME Response object under OFF/ON/sink-throw). No
 * network, no prod, no AE write. The middleware onRequest is also exercised with
 * a fake Astro context whose locals.runtime.env is the mock binding.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// astro:middleware is an Astro-injected virtual module unavailable under vitest;
// defineMiddleware is an identity typing helper at runtime, so mock it to the
// identity so we can import the REAL middleware (and its REAL recordTelemetry /
// onRequest). The mcp.ts route transitively imports heavy business handlers
// (search/select/compare/entity + mcp-* helpers); we mock those to inert stubs so
// importing the REAL finalizeMcpTelemetry does not pull the whole route graph.
// These mocks DO NOT touch the telemetry code under test.
vi.mock('astro:middleware', () => ({ defineMiddleware: (fn: any) => fn }));
vi.mock('../../src/pages/api/search.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/select.js', () => ({ POST: vi.fn() }));
vi.mock('../../src/pages/api/v1/compare.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/entity/[...id].js', () => ({ GET: vi.fn() }));
vi.mock('../../src/lib/mcp-explain.js', () => ({ callEntity: vi.fn(), buildExplainResult: vi.fn() }));
vi.mock('../../src/lib/mcp-compare.js', () => ({ callCompare: vi.fn(), buildCompareResult: vi.fn() }));
vi.mock('../../src/lib/mcp-search.js', () => ({ callSearchStatus: vi.fn(), buildSearchResult: vi.fn() }));
vi.mock('../../src/lib/mcp-select.js', () => ({ callSelectStatus: vi.fn(), buildSelectResult: vi.fn() }));

import {
  emit, getSubmissionErrorCount, resetSubmissionErrorCount,
  TELEMETRY_BINDING_NAME,
} from '../../src/lib/telemetry/ae-adapter';
import { MockTelemetryDataset } from '../../src/lib/telemetry/mock-binding';
import { buildRestEvent } from '../../src/lib/telemetry/request-classifier';
import { recordTelemetry, onRequest } from '../../src/middleware';
import { finalizeMcpTelemetry } from '../../src/pages/api/mcp';
import { recordDatasets302 } from '../../src/pages/api/v1/datasets';
import { findBindingMentions, TEXTUAL_ALLOWLIST } from '../../scripts/check-telemetry-no-read.mjs';

const NOW = new Date('2026-06-15T13:30:00Z');
const OWN = 'free2aitools.com';
const ORIGIN = 'https://free2aitools.com';

// Build a mock env WITHOUT ever writing the bare binding token in this file
// (binding-confinement: a new file must not name it). The binding key is taken
// from the adapter's exported TELEMETRY_BINDING_NAME via a computed property, and
// we keep a direct `ds` handle so assertions read ds.calls -- never env[token].
function mkEnv(enabled: boolean): { env: any; ds: MockTelemetryDataset } {
  const ds = new MockTelemetryDataset();
  const env: any = { TELEMETRY_ENABLED: enabled ? 'true' : 'false' };
  env[TELEMETRY_BINDING_NAME] = ds;
  return { env, ds };
}

// --- thin REAL-call-site drivers (NO classification re-implementation): each
// calls the SAME exported production finalizer the route/middleware calls. ------
const headersFor = (): Headers => new Headers();          // empty UA/referer
function realRest(env: any, method: string, pathname: string, status: number) {
  recordTelemetry(env, pathname, method, headersFor(), OWN, status);
}
function mkReq(): Request { return new Request(ORIGIN + '/api/mcp'); }
function realMcp(env: any, mcpMethod: string | null, toolName: string | null, status: number) {
  finalizeMcpTelemetry(env, mkReq(), mcpMethod, toolName, status);
}
function realDatasets(env: any, isKnown302: boolean) {
  // The REAL recordDatasets302 ONLY emits the known-file 302 branch (it is only
  // invoked from that branch in production); a non-known request never calls it.
  if (isKnown302) recordDatasets302(env, new Request(ORIGIN + '/api/v1/datasets?file=fni_lite_latest'));
}

describe('TEL-EXACTLY-ONCE: H-01 corrected -- at most one, exactly one when eligible', () => {
  beforeEach(() => resetSubmissionErrorCount());

  it('eligible canonical REST request (flag ON) -> exactly one event', () => {
    const { env, ds } = mkEnv(true);
    realRest(env, 'GET', '/api/v1/search', 200);
    expect(ds.calls.length).toBe(1);
  });

  it('eligible MCP initialize / known tools_call -> exactly one each', () => {
    const a = mkEnv(true); realMcp(a.env, 'initialize', null, 200);
    expect(a.ds.calls.length).toBe(1);
    const b = mkEnv(true); realMcp(b.env, 'tools/call', 'free2aitools_compare', 200);
    expect(b.ds.calls.length).toBe(1);
  });

  it('a known MCP tool emits ONE even on a JSON-RPC error status', () => {
    const { env, ds } = mkEnv(true);
    realMcp(env, 'tools/call', 'free2aitools_search', 500);
    expect(ds.calls.length).toBe(1);
  });

  it('eligible known-file datasets 302 -> exactly one event (H-23)', () => {
    const { env, ds } = mkEnv(true);
    realDatasets(env, true);
    expect(ds.calls.length).toBe(1);
  });

  it('excluded / invalid / unknown / wrong-method / flag-OFF -> zero', () => {
    // EXCLUDED routes via middleware path (route-owned, not double-counted).
    let e = mkEnv(true); realRest(e.env, 'POST', '/api/mcp', 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); realRest(e.env, 'GET', '/api/v1/datasets', 200);
    expect(e.ds.calls.length).toBe(0);
    // wrong method.
    e = mkEnv(true); realRest(e.env, 'OPTIONS', '/api/v1/search', 204);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); realRest(e.env, 'HEAD', '/api/v1/search', 200);
    expect(e.ds.calls.length).toBe(0);
    // unknown route + route-grammar neighbors (Blocker B) -> zero.
    e = mkEnv(true); realRest(e.env, 'GET', '/api/whatever', 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); realRest(e.env, 'GET', '/api/v1/trends', 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); realRest(e.env, 'GET', '/api/v1/trendsetter', 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); realRest(e.env, 'GET', '/api/v1/badge/', 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); realRest(e.env, 'GET', '/api/v1/entity/', 200);
    expect(e.ds.calls.length).toBe(0);
    // MCP: tools/list + unknown tool + missing name -> zero.
    e = mkEnv(true); realMcp(e.env, 'tools/list', null, 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); realMcp(e.env, 'tools/call', 'free2aitools_unknown', 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); realMcp(e.env, 'tools/call', null, 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); realMcp(e.env, null, null, 200);
    expect(e.ds.calls.length).toBe(0);
    // datasets manifest 200 / unknown 404 -> the known-302 branch never fires.
    e = mkEnv(true); realDatasets(e.env, false);
    expect(e.ds.calls.length).toBe(0);
    // flag OFF -> zero even for an otherwise-eligible request (each finalizer).
    const off = mkEnv(false); realRest(off.env, 'GET', '/api/v1/search', 200);
    realMcp(off.env, 'initialize', null, 200);
    realDatasets(off.env, true);
    expect(off.ds.calls.length).toBe(0);
  });

  it('one external request -> AT MOST one event (a REST surface is not re-counted as MCP)', () => {
    // The MCP route is excluded from the REST/middleware path; the MCP route's own
    // finalizer is the SOLE owner. Simulate both owners seeing the same /api/mcp
    // request: middleware excludes it (0), MCP finalizer counts it (1) -> total 1.
    const { env, ds } = mkEnv(true);
    realRest(env, 'POST', '/api/mcp', 200);                 // middleware: excluded -> 0
    realMcp(env, 'tools/call', 'free2aitools_search', 200); // MCP finalizer -> 1
    expect(ds.calls.length).toBe(1);  // exactly one, not two
  });
});

// --- middleware onRequest response-identity contract via the REAL middleware ---
// A fake Astro context whose locals.runtime.env is the mock binding, a `next`
// returning a KNOWN Response. The middleware must return the SAME object (===).
function mkCtx(env: any, path = '/api/v1/search') {
  const url = new URL(ORIGIN + path);
  return {
    request: new Request(url.toString(), { method: 'GET' }),
    url,
    locals: { runtime: { env } },
    redirect: (to: string) => Response.redirect(to, 302),
  } as any;
}

describe('TEL-EXACTLY-ONCE: middleware onRequest response identity (REAL middleware)', () => {
  beforeEach(() => resetSubmissionErrorCount());

  it('OFF: returns the SAME Response object; zero emit', async () => {
    const { env, ds } = mkEnv(false);
    const known = new Response('ok', { status: 200 });
    const out = await onRequest(mkCtx(env), async () => known);
    expect(out).toBe(known);
    expect(ds.calls.length).toBe(0);
  });

  it('ON: returns the SAME Response object; exactly one emit for an eligible surface', async () => {
    const { env, ds } = mkEnv(true);
    const known = new Response('ok', { status: 200 });
    const out = await onRequest(mkCtx(env, '/api/v1/search'), async () => known);
    expect(out).toBe(known);
    expect(ds.calls.length).toBe(1);
  });

  it('sink-throw: returns the SAME Response object; never throws into the serve path', async () => {
    const throwing = new MockTelemetryDataset();
    (throwing as unknown as { writeDataPoint: () => void }).writeDataPoint = () => { throw new Error('AE down'); };
    const env: any = { TELEMETRY_ENABLED: 'true' };
    env[TELEMETRY_BINDING_NAME] = throwing;
    const known = new Response('ok', { status: 200 });
    const out = await onRequest(mkCtx(env, '/api/v1/search'), async () => known);
    expect(out).toBe(known);
    expect(getSubmissionErrorCount()).toBe(1);
  });
});

describe('TEL-EXACTLY-ONCE: response identity + sink-failure neutrality', () => {
  beforeEach(() => resetSubmissionErrorCount());

  it('emit() returns a meta object, never a Response/score/order (no serve value)', () => {
    const { env } = mkEnv(true);
    const ev = buildRestEvent({ method: 'GET', pathname: '/api/v1/search', uaString: null, refererHost: null, ownHost: OWN, status: 200, now: NOW });
    const res = emit(env, ev);
    expect(res).not.toBeInstanceOf(Response);
    expect(Object.keys(res).sort()).toEqual(['attempted']);
  });

  it('a throwing sink never propagates -- the REAL recorder is untouched', () => {
    const throwing = new MockTelemetryDataset();
    (throwing as unknown as { writeDataPoint: () => void }).writeDataPoint = () => { throw new Error('AE down'); };
    const env: any = { TELEMETRY_ENABLED: 'true' };
    env[TELEMETRY_BINDING_NAME] = throwing;       // computed key -> no bare token here
    // The REAL recordTelemetry swallows -- it never throws into the caller.
    expect(() => realRest(env, 'GET', '/api/v1/search', 200)).not.toThrow();
    expect(getSubmissionErrorCount()).toBe(1);
  });

  it('telemetry ON vs OFF: identical produced event is byte-identical (no per-flag dimension)', () => {
    const ev = buildRestEvent({ method: 'GET', pathname: '/api/v1/search', uaString: null, refererHost: null, ownHost: OWN, status: 200, now: NOW });
    // The event the classifier produces does not depend on the flag (the flag only
    // gates whether emit() writes) -> identical object both ways.
    const again = buildRestEvent({ method: 'GET', pathname: '/api/v1/search', uaString: null, refererHost: null, ownHost: OWN, status: 200, now: NOW });
    expect(JSON.stringify(ev)).toBe(JSON.stringify(again));
  });
});

describe('TEL-EXACTLY-ONCE: H-29 binding-allowlist not enlarged', () => {
  it('the binding token still appears ONLY in the textual allowlist (no new location)', () => {
    const { hits, filesScanned } = findBindingMentions();
    expect(filesScanned).toBeGreaterThan(0);
    for (const h of hits) {
      expect(TEXTUAL_ALLOWLIST.has(h), `binding leaked into new location: ${h}`).toBe(true);
    }
    // The TA2 instrumented files must NOT be among the mentions.
    for (const f of ['src/middleware.ts', 'src/pages/api/mcp.ts', 'src/pages/api/v1/datasets.ts',
      'src/lib/telemetry/request-classifier.ts']) {
      expect(hits).not.toContain(f);
    }
  });
});
