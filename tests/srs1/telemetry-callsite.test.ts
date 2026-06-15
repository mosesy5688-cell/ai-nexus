/**
 * SRS-1 TEL-CALLSITE -- P2 Adoption Telemetry TA2 request-path classifier +
 * call-site invariants (Founder D-2026-0615-53, CONTROLLING).
 *
 * Hermetic, deterministic. Asserts the PURE classifier behavior (O-1 cache,
 * O-3 MCP, O-4 method/surface, O-8 audience, O-9 time bucket) + the datasets
 * semantic lock (O-2 / H-23) + method lock (H-24) + audience precedence (H-26)
 * + cache honesty (H-27), plus the gate-B mutation proofs (H-25) and the
 * repo-invariant locks (H-28/H-29/H-30). EXEC against the shared pure modules
 * + the exported gate functions; no network, no prod, no AE write.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRestEvent, buildMcpEvent, buildDatasetsEvent,
  classifyRestSurface, classifyMcp, classifyDatasets, classifyRequestAudience,
} from '../../src/lib/telemetry/request-classifier';
import { validateEvent } from '../../src/lib/telemetry/schema';
import {
  runAssertionB, checkReturnedEventKeys, checkNoConsole, checkEmitSignature,
  checkBuilderReturnType, TA2_CALL_SITES, CLASSIFIER_MODULE,
} from '../../scripts/check-telemetry-no-read.mjs';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const NOW = new Date('2026-06-15T13:30:00Z');
const OWN = 'free2aitools.com';
const baseRest = {
  uaString: null, refererHost: null, ownHost: OWN, status: 200, now: NOW,
};

describe('TEL-CALLSITE: O-4 method gate + surface map', () => {
  it('maps canonical GET/POST surfaces by family, returns null for the rest', () => {
    expect(classifyRestSurface('GET', '/api/v1/search')).toBe('api.v1.search');
    // /api/search is the EXCLUDED internal engine (Founder D-53 NOT COUNTED) -> drop.
    expect(classifyRestSurface('GET', '/api/search')).toBeNull();
    expect(classifyRestSurface('GET', '/api/v1/entity/hf-model--x--y')).toBe('api.v1.entity');
    expect(classifyRestSurface('GET', '/api/v1/compare')).toBe('api.v1.compare');
    expect(classifyRestSurface('GET', '/api/v1/concepts')).toBe('api.v1.concepts');
    expect(classifyRestSurface('GET', '/api/v1/trends/batch')).toBe('api.v1.trends');
    expect(classifyRestSurface('GET', '/llms.txt')).toBe('discovery.llms_txt');
    expect(classifyRestSurface('GET', '/openapi.json')).toBe('discovery.openapi');
    expect(classifyRestSurface('GET', '/api/v1/badge/abc123')).toBe('badge');
    expect(classifyRestSurface('POST', '/api/v1/select')).toBe('api.v1.select');
  });

  it('H-24 method lock: non-canonical method or wrong verb -> null (drop)', () => {
    for (const m of ['OPTIONS', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
      expect(classifyRestSurface(m, '/api/v1/search')).toBeNull();
    }
    expect(classifyRestSurface('POST', '/api/v1/search')).toBeNull(); // GET-only as POST
    expect(classifyRestSurface('GET', '/api/v1/select')).toBeNull();  // POST-only as GET
    expect(classifyRestSurface('GET', '/api/unknown')).toBeNull();    // unrecognized path
    // datasets + mcp are route-owned -> NOT classified by the REST surface map.
    expect(classifyRestSurface('GET', '/api/v1/datasets')).toBeNull();
    expect(classifyRestSurface('POST', '/api/mcp')).toBeNull();
  });

  it('buildRestEvent returns a schema-valid event for an allowed surface, null otherwise', () => {
    const ev = buildRestEvent({ ...baseRest, method: 'GET', pathname: '/api/v1/search' });
    expect(ev).not.toBeNull();
    expect(validateEvent(ev).ok).toBe(true);
    expect(ev!.operation).toBeNull();              // REST surfaces never carry operation
    expect(buildRestEvent({ ...baseRest, method: 'OPTIONS', pathname: '/api/v1/search' })).toBeNull();
    expect(buildRestEvent({ ...baseRest, method: 'GET', pathname: '/nope' })).toBeNull();
  });
});

describe('TEL-CALLSITE: O-1 / H-27 cache honesty', () => {
  it('304 -> hit; ordinary 200 without trusted signal -> none (never auto-miss)', () => {
    expect(buildRestEvent({ ...baseRest, method: 'GET', pathname: '/api/v1/search', status: 200 })!.cache_class).toBe('none');
    expect(buildRestEvent({ ...baseRest, method: 'GET', pathname: '/api/v1/search', status: 304 })!.cache_class).toBe('hit');
  });
  it('a trusted explicit MISS signal -> miss (only when genuinely provided)', () => {
    const ev = buildRestEvent({ ...baseRest, method: 'GET', pathname: '/api/v1/search', status: 200, trustedCacheMiss: true });
    expect(ev!.cache_class).toBe('miss');
  });
  it('MCP + datasets are never cacheable -> cache_class none', () => {
    const mcp = buildMcpEvent({ method: 'initialize', toolName: null, uaString: null, refererHost: null, ownHost: OWN, status: 200, now: NOW });
    expect(mcp!.cache_class).toBe('none');
    const ds = buildDatasetsEvent({ isRealKnownFile302: true, uaString: null, refererHost: null, ownHost: OWN, now: NOW });
    expect(ds!.cache_class).toBe('none');
  });
});

describe('TEL-CALLSITE: O-8 / H-26 audience precedence', () => {
  it('MCP > first_party > bot > browser > programmatic > unknown', () => {
    // (1) MCP wins everything (even with a browser UA).
    expect(classifyRequestAudience(true, true, 'Mozilla/5.0 ...')).toBe('mcp_client');
    // (2) first_party (same-origin) beats bot/browser/api.
    expect(classifyRequestAudience(false, true, 'curl/8')).toBe('first_party');
    // (3) bot beats browser + programmatic.
    expect(classifyRequestAudience(false, false, 'Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe('bot_crawler');
    // (4) browser beats programmatic.
    expect(classifyRequestAudience(false, false, 'Mozilla/5.0 (Windows NT) AppleWebKit Chrome Safari')).toBe('human_browser');
    // (5) programmatic allowlist.
    for (const ua of ['curl/8.4', 'python-requests/2.31', 'wget/1.21', 'PostmanRuntime/7', 'go-http-client/1.1', 'axios/1.6']) {
      expect(classifyRequestAudience(false, false, ua)).toBe('external_api');
    }
    // (6) FORBIDDEN: empty UA / unknown non-browser -> unknown, never external_api.
    expect(classifyRequestAudience(false, false, null)).toBe('unknown');
    expect(classifyRequestAudience(false, false, '')).toBe('unknown');
    expect(classifyRequestAudience(false, false, 'SomeRandomClient/1.0')).toBe('unknown');
    // ambiguous "Agent" wording must NOT become mcp_client.
    expect(classifyRequestAudience(false, false, 'My-Agent/1.0')).toBe('unknown');
  });
});

describe('TEL-CALLSITE: O-3 MCP classifier + O-2 datasets', () => {
  it('O-3: initialize + the 5 frozen tools emit; everything else -> null', () => {
    expect(classifyMcp('initialize', null)).toEqual({ surface: 'mcp.initialize', operation: null });
    const tools: Record<string, string> = {
      free2aitools_search: 'search', free2aitools_rank: 'rank', free2aitools_explain: 'explain',
      free2aitools_select_model: 'select_model', free2aitools_compare: 'compare',
    };
    for (const [name, op] of Object.entries(tools)) {
      expect(classifyMcp('tools/call', name)).toEqual({ surface: 'mcp.tools_call', operation: op });
    }
    // tools/list, unknown method, unknown tool, missing name -> null (no emit).
    expect(classifyMcp('tools/list', null)).toBeNull();
    expect(classifyMcp('notifications/x', null)).toBeNull();
    expect(classifyMcp('tools/call', 'free2aitools_delete_db')).toBeNull();
    expect(classifyMcp('tools/call', null)).toBeNull();
    expect(classifyMcp(null, null)).toBeNull();
  });

  it('a known tool emits a valid event even with a 5xx business error status', () => {
    const ev = buildMcpEvent({ method: 'tools/call', toolName: 'free2aitools_compare', uaString: null, refererHost: null, ownHost: OWN, status: 503, now: NOW });
    expect(ev).not.toBeNull();
    expect(ev!.surface).toBe('mcp.tools_call');
    expect(ev!.operation).toBe('compare');
    expect(ev!.status_class).toBe('5xx');
    expect(ev!.audience_class).toBe('mcp_client');
    expect(validateEvent(ev).ok).toBe(true);
  });

  it('O-2 / H-23 datasets: only a real known-file 302 yields datasets.302', () => {
    expect(classifyDatasets(true)).toBe('datasets.302');
    expect(classifyDatasets(false)).toBeNull();
    const ev = buildDatasetsEvent({ isRealKnownFile302: true, uaString: null, refererHost: null, ownHost: OWN, now: NOW });
    expect(ev!.surface).toBe('datasets.302');
    expect(ev!.status_class).toBe('3xx');
    expect(validateEvent(ev).ok).toBe(true);
    expect(buildDatasetsEvent({ isRealKnownFile302: false, uaString: null, refererHost: null, ownHost: OWN, now: NOW })).toBeNull();
  });
});

describe('TEL-CALLSITE: O-9 time bucket + no-raw-leak', () => {
  it('time_bucket is the UTC hour "YYYY-MM-DDTHH"', () => {
    const ev = buildRestEvent({ ...baseRest, method: 'GET', pathname: '/api/v1/search' });
    expect(ev!.time_bucket).toBe('2026-06-15T13');
  });
  it('a raw UA/referer/path NEVER appears in any returned event field', () => {
    const ev = buildRestEvent({
      method: 'GET', pathname: '/api/v1/entity/secret-slug-leak', uaString: 'curl/8 SECRETUA',
      refererHost: 'evil.example.com', ownHost: OWN, status: 200, now: NOW,
    })!;
    const dump = JSON.stringify(ev);
    expect(dump).not.toMatch(/secret-slug-leak|SECRETUA|evil\.example\.com/);
    expect(ev.referer_host_class).toBe('other');   // raw host collapsed to closed class
    expect(ev.audience_class).toBe('external_api'); // curl -> programmatic
  });
});

describe('TEL-CALLSITE: H-25 gate-B mutation proofs', () => {
  it('baseline assertion B passes on the real tree', () => {
    const b = runAssertionB();
    expect(b.errors, b.errors.join(' | ')).toEqual([]);
    expect(b.scanned).toBeGreaterThan(0);
  });

  it('raw event-key injection into a returned event FAILS the key check', () => {
    const good = 'return {\n schema_version: "1", surface: s, operation: null,\n};';
    expect(checkReturnedEventKeys(good)).toEqual([]);
    const mutated = 'return {\n schema_version: "1", surface: s, pathname: input.pathname,\n};';
    expect(checkReturnedEventKeys(mutated).join(';')).toMatch(/pathname/);
  });

  it('console.log(rawUa) insertion FAILS the no-console check; revert passes', () => {
    const real = fs.readFileSync(path.join(ROOT, CLASSIFIER_MODULE), 'utf-8');
    expect(checkNoConsole(real)).toEqual([]);          // revert/baseline state
    expect(checkNoConsole(real + '\nconsole.log(rawUa);').length).toBeGreaterThan(0);
  });

  it('a Headers-typed emitter param FAILS the signature check', () => {
    const good = 'export function emit(env: TelemetryEnv | undefined, rawEvent: unknown): EmitResult {';
    expect(checkEmitSignature(good)).toEqual([]);
    const bad = 'export function emit(env: TelemetryEnv | undefined, h: Headers): EmitResult {';
    expect(checkEmitSignature(bad).join(';')).toMatch(/Headers/);
  });

  it('a builder returning a non-frozen type FAILS the return-type check', () => {
    const good = 'export function buildRestEvent(i: X): TelemetryEvent | null {\n return null;\n}';
    expect(checkBuilderReturnType(good)).toEqual([]);
    const bad = 'export function buildRestEvent(i: X): any {\n return null;\n}';
    expect(checkBuilderReturnType(bad).join(';')).toMatch(/TelemetryEvent/);
  });
});

describe('TEL-CALLSITE: H-28/H-29/H-30 repo invariants', () => {
  it('H-28: no forced-500 / test-header / test-query / test-mode backdoor in authorized files', () => {
    const files = [...TA2_CALL_SITES, CLASSIFIER_MODULE];
    const backdoor = /x-telemetry-test|telemetry[_-]?test[_-]?mode|__force_?500|force_?status|test_?query|TELEMETRY_TEST/i;
    let scanned = 0;
    for (const rel of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      scanned++;
      expect(backdoor.test(src), `${rel} contains a test/backdoor branch`).toBe(false);
    }
    expect(scanned).toBe(files.length);
  });

  it('H-30: schema.ts / vocab.ts / ae-adapter.ts / mock-binding.ts carry NO TA2 additions (unchanged)', () => {
    // A lightweight unchanged-check: the TA2 instrumentation imports/symbols must
    // not appear in the frozen substrate modules (they would be the only way a TA2
    // change could have touched them).
    const frozen = ['schema.ts', 'vocab.ts', 'ae-adapter.ts', 'mock-binding.ts'];
    const ta2Markers = /buildRestEvent|buildMcpEvent|buildDatasetsEvent|classifyRestSurface|request-classifier|cloudflare:workers|TA2_CALL_SITES/;
    let scanned = 0;
    for (const f of frozen) {
      const src = fs.readFileSync(path.join(ROOT, 'src/lib/telemetry', f), 'utf-8');
      scanned++;
      expect(ta2Markers.test(src), `${f} must not carry TA2 additions`).toBe(false);
    }
    expect(scanned).toBe(4);
  });
});
