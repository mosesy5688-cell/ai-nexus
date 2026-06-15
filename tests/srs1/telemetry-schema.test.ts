/**
 * SRS-1 TEL-SCHEMA -- P2 Adoption Telemetry closed-world schema invariant.
 *
 * Hermetic, deterministic (no network, no prod, no timing). Asserts the closed
 * event schema (D-2026-0615-49 FINAL RAW EVENT SCHEMA): EXACTLY the allowed
 * dimensions, each a closed enum; status_class = 2xx|3xx|4xx|5xx (Erratum #4);
 * 302 -> 3xx; operation = tool name ONLY for mcp.tools_call; any extra/unknown
 * key rejected (closed-world: "nothing outside this list, ever").
 */
import { describe, it, expect } from 'vitest';
import {
  validateEvent, SCHEMA_VERSION, ALLOWED_KEYS,
} from '../../src/lib/telemetry/schema';
import {
  statusToClass, classifyAudience, classifyRefererHost,
  SURFACES, MCP_TOOLS, STATUS_CLASSES, AUDIENCE_CLASSES,
} from '../../src/lib/telemetry/vocab';

function validBase() {
  return {
    schema_version: '1', surface: 'api.v1.search', operation: null,
    status_class: '2xx', cache_class: 'miss', audience_class: 'external_api',
    referer_host_class: 'github', time_bucket: '2026-06-15T13',
  };
}

describe('TEL-SCHEMA: closed-world event schema', () => {
  it('accepts a fully-valid closed event (execution proof)', () => {
    let checks = 0;
    const r = validateEvent(validBase());
    checks++;
    expect(r.ok).toBe(true);
    expect(r.event).toBeDefined();
    // Returned event carries ONLY the allowed keys.
    expect(Object.keys(r.event!).sort()).toEqual([...ALLOWED_KEYS].sort());
    expect(checks).toBeGreaterThan(0);
  });

  it('status_class is exactly the 4-class set incl 3xx (Erratum #4)', () => {
    expect([...STATUS_CLASSES]).toEqual(['2xx', '3xx', '4xx', '5xx']);
    expect(statusToClass(200)).toBe('2xx');
    expect(statusToClass(302)).toBe('3xx');   // 302 -> 3xx, never faked as 2xx
    expect(statusToClass(404)).toBe('4xx');
    expect(statusToClass(503)).toBe('5xx');
    const r = validateEvent({ ...validBase(), surface: 'datasets.302', status_class: '3xx' });
    expect(r.ok).toBe(true);
  });

  it('rejects any unknown/extra key (closed-world violation)', () => {
    const r = validateEvent({ ...validBase(), extra_dim: 'x' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(';')).toMatch(/unknown field|closed-world/);
  });

  it('operation is tool-name ONLY for mcp.tools_call; null elsewhere', () => {
    // tools_call requires a closed tool name
    const good = validateEvent({ ...validBase(), surface: 'mcp.tools_call', operation: 'compare' });
    expect(good.ok).toBe(true);
    const badName = validateEvent({ ...validBase(), surface: 'mcp.tools_call', operation: 'delete_db' });
    expect(badName.ok).toBe(false);
    const opOnRest = validateEvent({ ...validBase(), surface: 'api.v1.search', operation: 'search' });
    expect(opOnRest.ok).toBe(false);
    expect([...MCP_TOOLS]).toEqual(['search', 'rank', 'explain', 'select_model', 'compare']);
  });

  it('rejects out-of-vocabulary surface / audience / status / cache / referer', () => {
    expect(validateEvent({ ...validBase(), surface: 'api.v2.search' }).ok).toBe(false);
    expect(validateEvent({ ...validBase(), audience_class: 'paying_customer' }).ok).toBe(false);
    expect(validateEvent({ ...validBase(), status_class: '1xx' }).ok).toBe(false);
    expect(validateEvent({ ...validBase(), cache_class: 'stale' }).ok).toBe(false);
    expect(validateEvent({ ...validBase(), referer_host_class: 'example.com' }).ok).toBe(false);
  });

  it('requires schema_version "1" and a UTC hour bucket', () => {
    expect(SCHEMA_VERSION).toBe('1');
    expect(validateEvent({ ...validBase(), schema_version: '2' }).ok).toBe(false);
    expect(validateEvent({ ...validBase(), time_bucket: '2026-06-15' }).ok).toBe(false);
    expect(validateEvent({ ...validBase(), time_bucket: 'not-a-date' }).ok).toBe(false);
  });

  it('never throws on garbage input (telemetry must not break callers)', () => {
    for (const bad of [null, undefined, 42, 'str', [], () => 0]) {
      expect(() => validateEvent(bad)).not.toThrow();
      expect(validateEvent(bad).ok).toBe(false);
    }
  });

  it('classifiers return only closed classes; undecidable -> unknown', () => {
    expect(AUDIENCE_CLASSES).toContain(classifyAudience({}));
    expect(classifyAudience({})).toBe('unknown');
    expect(classifyAudience({ isFirstParty: true })).toBe('first_party');
    expect(classifyAudience({ isMcpClient: true })).toBe('mcp_client');
    expect(classifyRefererHost('github.com', 'free2aitools.com')).toBe('github');
    expect(classifyRefererHost('free2aitools.com', 'free2aitools.com')).toBe('first_party');
    expect(classifyRefererHost('evil.example.com')).toBe('other'); // raw host never returned
    expect(classifyRefererHost(null)).toBe('none');
    expect(SURFACES.length).toBeGreaterThan(0);
  });
});
