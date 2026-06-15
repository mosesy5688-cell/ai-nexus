/**
 * SRS-1 TEL-PRIVACY -- P2 Adoption Telemetry privacy floor invariant.
 *
 * Hermetic, deterministic. Asserts the FORBIDDEN-field floor (D-2026-0615-49):
 * no latency / deployment SHA / snapshot ID / body / MCP arguments / query /
 * prompt / entity ID / slug / path / canonical_id / UMID / source URL / raw IP /
 * raw UA / raw referer / cookie / fingerprint / geo / clientInfo / error text
 * may EVER reach the sink. The emitter API accepts ONLY validated closed enums.
 */
import { describe, it, expect } from 'vitest';
import { validateEvent, FORBIDDEN_FIELDS } from '../../src/lib/telemetry/schema';
import { emit, eventToDataPoint } from '../../src/lib/telemetry/ae-adapter';
import { makeMockEnv } from '../../src/lib/telemetry/mock-binding';

function validBase() {
  return {
    schema_version: '1', surface: 'api.v1.search', operation: null,
    status_class: '2xx', cache_class: 'miss', audience_class: 'external_api',
    referer_host_class: 'github', time_bucket: '2026-06-15T13',
  };
}

describe('TEL-PRIVACY: forbidden fields can never reach the sink', () => {
  it('every forbidden field name is rejected as an event key (execution proof)', () => {
    let checks = 0;
    for (const f of FORBIDDEN_FIELDS) {
      checks++;
      const r = validateEvent({ ...validBase(), [f]: 'leak' });
      expect(r.ok, `forbidden field ${f} must reject`).toBe(false);
    }
    expect(checks).toBe(FORBIDDEN_FIELDS.length);
    expect(checks).toBeGreaterThan(20);
  });

  it('high-risk identifiers are explicitly rejected', () => {
    for (const f of ['query', 'prompt', 'body', 'ip', 'user_agent', 'referer',
      'entity_id', 'canonical_id', 'umid', 'source_url', 'geo', 'clientInfo',
      'latency', 'deployment_sha', 'snapshot_id', 'arguments', 'slug', 'path']) {
      expect(validateEvent({ ...validBase(), [f]: 'x' }).ok, f).toBe(false);
    }
  });

  it('the data point written carries ONLY the 8 closed enum dimensions', () => {
    const ev = validateEvent(validBase()).event!;
    const dp = eventToDataPoint(ev);
    // 8 closed-enum blobs, no doubles, exactly one index (AE caps).
    expect(dp.blobs.length).toBe(8);
    expect(dp.doubles.length).toBe(0);
    expect(dp.indexes.length).toBe(1);          // EXACTLY one index
    // No blob value is anything but a known closed-enum string (or null operation).
    for (const b of dp.blobs) {
      if (b === null) continue;
      expect(typeof b).toBe('string');
      // no raw-looking value: no spaces, no '/', no '?', no '@' (path/url/query/ua markers)
      expect(b).not.toMatch(/[\/?@ ]/);
    }
  });

  it('a forbidden field attached to a write attempt never reaches the mock sink', () => {
    const env = makeMockEnv(true);
    // Caller tries to smuggle a query string + raw UA alongside valid dims.
    const res = emit(env, { ...validBase(), query: 'gpt-4', user_agent: 'curl/8' });
    expect(res.attempted).toBe(false);          // rejected by closed-world validator
    expect(env.ADOPTION_TELEMETRY.calls.length).toBe(0); // nothing written
  });

  it('emit accepts only the (env, event) shape -- no Request/URL/body', () => {
    // The signature is structurally enum-only; this asserts the runtime behavior:
    // passing a Request-like object as the event is rejected (not classified/leaked).
    const env = makeMockEnv(true);
    const reqLike = { url: 'https://x/y?q=secret', method: 'GET', headers: {} };
    const res = emit(env, reqLike as unknown);
    expect(res.attempted).toBe(false);
    expect(env.ADOPTION_TELEMETRY.calls.length).toBe(0);
  });
});
