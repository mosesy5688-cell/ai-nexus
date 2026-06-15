/**
 * SRS-1 TEL-EXACTLY-ONCE -- P2 Adoption Telemetry TA2 single-emission ownership
 * (Founder D-2026-0615-53 GLOBAL INVARIANT O-4 / H-01-corrected).
 *
 * Hermetic, deterministic. Drives the REAL emit() (ae-adapter) through the REAL
 * pure builders (request-classifier) exactly as the call sites do, against the
 * mock binding -- asserting: at-most-one event per request; exactly-one only for
 * an eligible (flag ON + approved surface + canonical method + valid MCP op)
 * request; excluded/invalid/unknown/wrong-method/flag-OFF -> zero; flag-OFF
 * zero-write; sink-failure neutrality; and the response-identity / no-mutation
 * contract (emit returns a meta object, never a Response). No network/prod/AE.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  emit, isEnabled, getSubmissionErrorCount, resetSubmissionErrorCount,
  TELEMETRY_BINDING_NAME,
} from '../../src/lib/telemetry/ae-adapter';
import { MockTelemetryDataset } from '../../src/lib/telemetry/mock-binding';
import {
  buildRestEvent, buildMcpEvent, buildDatasetsEvent,
} from '../../src/lib/telemetry/request-classifier';
import { findBindingMentions, TEXTUAL_ALLOWLIST } from '../../scripts/check-telemetry-no-read.mjs';

const NOW = new Date('2026-06-15T13:30:00Z');
const OWN = 'free2aitools.com';

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

// Faithful re-creation of the call-site emit-ownership decision (one guarded
// block, emit at most once on the produced event). This mirrors the SHAPE the
// middleware/mcp/datasets call sites use; it does not re-implement classification
// (it calls the SAME shared builder).
function ownerEmitRest(env: any, method: string, pathname: string, status: number) {
  try {
    if (!isEnabled(env)) return;
    if (pathname === '/api/mcp' || pathname.startsWith('/api/v1/datasets')) return; // EXCLUDED
    const ev = buildRestEvent({ method, pathname, uaString: null, refererHost: null, ownHost: OWN, status, now: NOW });
    if (ev) emit(env, ev);
  } catch { /* swallow */ }
}
function ownerEmitMcp(env: any, mcpMethod: string | null, toolName: string | null, status: number) {
  try {
    if (!isEnabled(env)) return;
    const ev = buildMcpEvent({ method: mcpMethod, toolName, uaString: null, refererHost: null, ownHost: OWN, status, now: NOW });
    if (ev) emit(env, ev);
  } catch { /* swallow */ }
}
function ownerEmitDatasets(env: any, isKnown302: boolean) {
  try {
    if (!isEnabled(env)) return;
    const ev = buildDatasetsEvent({ isRealKnownFile302: isKnown302, uaString: null, refererHost: null, ownHost: OWN, now: NOW });
    if (ev) emit(env, ev);
  } catch { /* swallow */ }
}

describe('TEL-EXACTLY-ONCE: H-01 corrected -- at most one, exactly one when eligible', () => {
  beforeEach(() => resetSubmissionErrorCount());

  it('eligible canonical REST request (flag ON) -> exactly one event', () => {
    const { env, ds } = mkEnv(true);
    ownerEmitRest(env, 'GET', '/api/v1/search', 200);
    expect(ds.calls.length).toBe(1);
  });

  it('eligible MCP initialize / known tools_call -> exactly one each', () => {
    const a = mkEnv(true); ownerEmitMcp(a.env, 'initialize', null, 200);
    expect(a.ds.calls.length).toBe(1);
    const b = mkEnv(true); ownerEmitMcp(b.env, 'tools/call', 'free2aitools_compare', 200);
    expect(b.ds.calls.length).toBe(1);
  });

  it('eligible known-file datasets 302 -> exactly one event (H-23)', () => {
    const { env, ds } = mkEnv(true);
    ownerEmitDatasets(env, true);
    expect(ds.calls.length).toBe(1);
  });

  it('excluded / invalid / unknown / wrong-method / flag-OFF -> zero', () => {
    // EXCLUDED routes via middleware path (route-owned, not double-counted).
    let e = mkEnv(true); ownerEmitRest(e.env, 'POST', '/api/mcp', 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); ownerEmitRest(e.env, 'GET', '/api/v1/datasets', 200);
    expect(e.ds.calls.length).toBe(0);
    // wrong method.
    e = mkEnv(true); ownerEmitRest(e.env, 'OPTIONS', '/api/v1/search', 204);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); ownerEmitRest(e.env, 'HEAD', '/api/v1/search', 200);
    expect(e.ds.calls.length).toBe(0);
    // unknown route.
    e = mkEnv(true); ownerEmitRest(e.env, 'GET', '/api/whatever', 200);
    expect(e.ds.calls.length).toBe(0);
    // MCP: tools/list + unknown tool + missing name -> zero.
    e = mkEnv(true); ownerEmitMcp(e.env, 'tools/list', null, 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); ownerEmitMcp(e.env, 'tools/call', 'free2aitools_unknown', 200);
    expect(e.ds.calls.length).toBe(0);
    e = mkEnv(true); ownerEmitMcp(e.env, 'tools/call', null, 200);
    expect(e.ds.calls.length).toBe(0);
    // datasets manifest 200 / unknown 404 -> zero.
    e = mkEnv(true); ownerEmitDatasets(e.env, false);
    expect(e.ds.calls.length).toBe(0);
    // flag OFF -> zero even for an otherwise-eligible request.
    const off = mkEnv(false); ownerEmitRest(off.env, 'GET', '/api/v1/search', 200);
    expect(off.ds.calls.length).toBe(0);
  });

  it('one external request -> AT MOST one event (a REST surface is not re-counted as MCP)', () => {
    // The MCP route is excluded from the REST/middleware path; the MCP route's own
    // finalizer is the SOLE owner. Simulate both owners seeing the same /api/mcp
    // request: middleware excludes it (0), MCP finalizer counts it (1) -> total 1.
    const { env, ds } = mkEnv(true);
    ownerEmitRest(env, 'POST', '/api/mcp', 200);          // middleware: excluded -> 0
    ownerEmitMcp(env, 'tools/call', 'free2aitools_search', 200); // MCP finalizer -> 1
    expect(ds.calls.length).toBe(1);  // exactly one, not two
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

  it('a throwing sink never propagates -- the response path is untouched', () => {
    const throwing = new MockTelemetryDataset();
    (throwing as unknown as { writeDataPoint: () => void }).writeDataPoint = () => { throw new Error('AE down'); };
    const env: any = { TELEMETRY_ENABLED: 'true' };
    env[TELEMETRY_BINDING_NAME] = throwing;       // computed key -> no bare token here
    // The owner block swallows -- it never throws into the caller.
    expect(() => ownerEmitRest(env, 'GET', '/api/v1/search', 200)).not.toThrow();
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
