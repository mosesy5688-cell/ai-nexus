/**
 * SRS-1 TEL-ISOLATION -- P2 Adoption Telemetry constitutional-isolation invariant.
 *
 * Hermetic, deterministic. Asserts the SPEC s8/s11 floor + the D-49 binding-
 * confinement rulings:
 *  - DEFAULT-OFF: TELEMETRY_ENABLED != 'true' => no write.
 *  - LOCAL/NO-BINDING NO-OP: absent binding => no write, no throw.
 *  - FAILURE ISOLATION: a throwing sink never throws into the caller; lost-write
 *    meta-counter increments instead.
 *  - waitUntil FIRE-AND-FORGET: the write runs inside the supplied waitUntil hook.
 *  - NEUTRALITY: the telemetry path imports nothing from FNI/ranking/search/
 *    projection/MCP-response, and emit() returns NO serving value.
 *  - NO-READ + BINDING-CONFINEMENT static gate runs green AND is non-vacuous.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  emit, isEnabled, getLostWriteCount, resetLostWriteCount,
  TELEMETRY_BINDING_NAME,
} from '../../src/lib/telemetry/ae-adapter';
import { makeMockEnv, MockTelemetryDataset } from '../../src/lib/telemetry/mock-binding';
import { findBindingMentions, NO_READ_PATHS, TEXTUAL_ALLOWLIST }
  from '../../scripts/check-telemetry-no-read.mjs';
import fs from 'fs';
import path from 'path';

function validBase() {
  return {
    schema_version: '1', surface: 'api.v1.search', operation: null,
    status_class: '2xx', cache_class: 'miss', audience_class: 'external_api',
    referer_host_class: 'github', time_bucket: '2026-06-15T13',
  };
}

describe('TEL-ISOLATION: default-off + no-op + failure isolation', () => {
  beforeEach(() => resetLostWriteCount());

  it('binding name is the frozen ADOPTION_TELEMETRY', () => {
    expect(TELEMETRY_BINDING_NAME).toBe('ADOPTION' + '_TELEMETRY');
  });

  it('DEFAULT-OFF: flag unset or != "true" => no write', () => {
    expect(isEnabled(undefined)).toBe(false);
    expect(isEnabled({})).toBe(false);
    expect(isEnabled({ TELEMETRY_ENABLED: 'false' })).toBe(false);
    expect(isEnabled({ TELEMETRY_ENABLED: '1' })).toBe(false);
    expect(isEnabled({ TELEMETRY_ENABLED: 'true' })).toBe(true);
    const env = makeMockEnv(false); // flag off
    const res = emit(env, validBase());
    expect(res.written).toBe(false);
    expect(env.ADOPTION_TELEMETRY.calls.length).toBe(0);
  });

  it('NO-BINDING NO-OP: absent binding => no write, no throw', () => {
    expect(() => emit({ TELEMETRY_ENABLED: 'true' }, validBase())).not.toThrow();
    expect(emit({ TELEMETRY_ENABLED: 'true' }, validBase()).written).toBe(false);
  });

  it('ENABLED + bound: writes exactly one data point per valid event', () => {
    const env = makeMockEnv(true);
    const res = emit(env, validBase());
    expect(res.written).toBe(true);
    expect(env.ADOPTION_TELEMETRY.calls.length).toBe(1);
    expect(env.ADOPTION_TELEMETRY.calls[0].indexes).toEqual(['api.v1.search']);
  });

  it('FAILURE ISOLATION: a throwing sink never throws into the caller', async () => {
    const throwing = new MockTelemetryDataset();
    (throwing as unknown as { writeDataPoint: () => void }).writeDataPoint = () => {
      throw new Error('AE down');
    };
    const env = { ADOPTION_TELEMETRY: throwing, TELEMETRY_ENABLED: 'true' };
    let captured: Promise<unknown> | null = null;
    const waitUntil = (p: Promise<unknown>) => { captured = p; };
    expect(() => emit(env, validBase(), waitUntil)).not.toThrow();
    await captured;                              // resolve the fire-and-forget task
    expect(getLostWriteCount()).toBe(1);         // counted, not surfaced
  });

  it('waitUntil FIRE-AND-FORGET: write runs inside the supplied hook', async () => {
    const env = makeMockEnv(true);
    const tasks: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => { tasks.push(p); };
    emit(env, validBase(), waitUntil);
    expect(tasks.length).toBe(1);                // platform hook received the task
    await Promise.all(tasks);
    expect(env.ADOPTION_TELEMETRY.calls.length).toBe(1);
  });

  it('NEUTRALITY: emit returns no serving value and the telemetry modules import '
    + 'nothing from FNI/ranking/search/projection/MCP-response', () => {
    // emit returns only a meta status object -- never a Response / score / order.
    const env = makeMockEnv(true);
    const res = emit(env, validBase());
    expect(Object.keys(res).sort()).toEqual(['written']);
    // Static neutrality: no telemetry module imports a serving/scoring source.
    const root = path.resolve(__dirname, '../..');
    const forbidden = /from\s+['"].*(fni-score|ranking-order|entity-projection|cluster-rerank|api\/search|api\/mcp|api\/v1)/;
    const mods = ['vocab.ts', 'schema.ts', 'ae-adapter.ts', 'mock-binding.ts'];
    let scanned = 0;
    for (const m of mods) {
      const src = fs.readFileSync(path.join(root, 'src/lib/telemetry', m), 'utf-8');
      scanned++;
      expect(forbidden.test(src), `${m} must not import a serving/scoring module`).toBe(false);
    }
    expect(scanned).toBe(4);                     // anti-vacuity
  });
});

describe('TEL-GATE: no-read + binding-confinement static gate is green + non-vacuous', () => {
  it('binding is confined to the textual allowlist only', () => {
    const { hits, filesScanned } = findBindingMentions();
    expect(filesScanned).toBeGreaterThan(0);     // anti-vacuity: it scanned files
    expect(hits.length).toBeGreaterThan(0);      // anti-vacuity: it found mentions
    for (const h of hits) {
      expect(TEXTUAL_ALLOWLIST.has(h), `binding leaked outside allowlist: ${h}`).toBe(true);
    }
    // The write adapter MUST be among the mentions (else confinement is vacuous).
    expect(hits).toContain('src/lib/telemetry/ae-adapter.ts');
  });

  it('NO-READ paths exist and never name the binding', () => {
    const root = path.resolve(__dirname, '../..');
    let scanned = 0;
    const re = /(?<![A-Za-z0-9_])ADOPTION_TELEMETRY(?![A-Za-z0-9_])/;
    for (const rel of NO_READ_PATHS) {
      const abs = path.join(root, rel);
      expect(fs.existsSync(abs), `no-read path missing: ${rel}`).toBe(true);
      scanned++;
      expect(re.test(fs.readFileSync(abs, 'utf-8')), `${rel} reads telemetry binding`).toBe(false);
    }
    expect(scanned).toBe(NO_READ_PATHS.length);
    expect(scanned).toBeGreaterThan(10);         // anti-vacuity
  });
});
