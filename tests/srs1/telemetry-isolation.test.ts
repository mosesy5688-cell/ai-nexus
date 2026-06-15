/**
 * SRS-1 TEL-ISOLATION -- P2 Adoption Telemetry constitutional-isolation invariant.
 *
 * Hermetic, deterministic. Asserts the SPEC s8/s11 floor + the D-49 binding-
 * confinement rulings:
 *  - DEFAULT-OFF: TELEMETRY_ENABLED != 'true' => no write.
 *  - LOCAL/NO-BINDING NO-OP: absent binding => no write, no throw.
 *  - DIRECT NON-BLOCKING SUBMISSION (Erratum #5): emit() calls AE writeDataPoint
 *    DIRECTLY and returns synchronously -- it does NOT await / hand back a Promise
 *    and does NOT use waitUntil.
 *  - FAILURE ISOLATION: a SYNCHRONOUSLY throwing sink never throws into the
 *    caller; the submission-error meta-counter increments and emit() honestly
 *    reports attempted:false instead.
 *  - NEUTRALITY: the telemetry path imports nothing from FNI/ranking/search/
 *    projection/MCP-response, and emit() returns NO serving value.
 *  - NO-READ + BINDING-CONFINEMENT static gate runs green AND is non-vacuous.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  emit, isEnabled, getSubmissionErrorCount, resetSubmissionErrorCount,
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
  beforeEach(() => resetSubmissionErrorCount());

  it('binding name is the frozen ADOPTION_TELEMETRY', () => {
    expect(TELEMETRY_BINDING_NAME).toBe('ADOPTION' + '_TELEMETRY');
  });

  it('DEFAULT-OFF: flag unset or != "true" => zero mock writes', () => {
    expect(isEnabled(undefined)).toBe(false);
    expect(isEnabled({})).toBe(false);
    expect(isEnabled({ TELEMETRY_ENABLED: 'false' })).toBe(false);
    expect(isEnabled({ TELEMETRY_ENABLED: '1' })).toBe(false);
    expect(isEnabled({ TELEMETRY_ENABLED: 'true' })).toBe(true);
    const env = makeMockEnv(false); // flag off
    const res = emit(env, validBase());
    expect(res.attempted).toBe(false);
    expect(env.ADOPTION_TELEMETRY.calls.length).toBe(0);  // zero mock writes
  });

  it('NO-BINDING NO-OP: absent binding => zero writes, no throw', () => {
    expect(() => emit({ TELEMETRY_ENABLED: 'true' }, validBase())).not.toThrow();
    expect(emit({ TELEMETRY_ENABLED: 'true' }, validBase()).attempted).toBe(false);
  });

  it('DIRECT NON-BLOCKING SUBMISSION: enabled + bound submits exactly one data '
    + 'point synchronously, returning without awaiting a Promise (Erratum #5)', () => {
    const env = makeMockEnv(true);
    const res = emit(env, validBase());
    // emit() returns a plain meta object, NOT a Promise -- nothing to await.
    expect(res).not.toBeInstanceOf(Promise);
    expect(typeof (res as unknown as { then?: unknown }).then).toBe('undefined');
    expect(res.attempted).toBe(true);
    // The write already happened synchronously by the time emit() returned --
    // no waitUntil, no microtask flush needed.
    expect(env.ADOPTION_TELEMETRY.calls.length).toBe(1);
    expect(env.ADOPTION_TELEMETRY.calls[0].indexes).toEqual(['api.v1.search']);
  });

  it('FAILURE ISOLATION: a SYNCHRONOUSLY throwing sink is caught -- never throws '
    + 'into the caller; counted + reported honestly', () => {
    const throwing = new MockTelemetryDataset();
    (throwing as unknown as { writeDataPoint: () => void }).writeDataPoint = () => {
      throw new Error('AE down');                // synchronous throw
    };
    const env = { ADOPTION_TELEMETRY: throwing, TELEMETRY_ENABLED: 'true' };
    let res: { attempted: boolean; reason?: string } | undefined;
    expect(() => { res = emit(env, validBase()); }).not.toThrow();
    expect(res!.attempted).toBe(false);          // honest: nothing was submitted
    expect(getSubmissionErrorCount()).toBe(1);   // counted, not surfaced to caller
  });

  it('NEUTRALITY: emit returns no serving value and the telemetry modules import '
    + 'nothing from FNI/ranking/search/projection/MCP-response', () => {
    // emit returns only a meta status object -- never a Response / score / order,
    // and never a written/persisted/delivered confirmation.
    const env = makeMockEnv(true);
    const res = emit(env, validBase());
    expect(Object.keys(res).sort()).toEqual(['attempted']);
    expect('written' in res).toBe(false);        // no false delivery confirmation
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

  // ANTI-VACUITY MUTATION PROOF for the repo-wide confinement scan (Blocker C):
  // injecting the binding token into a NON-allowlisted text file that the OLD
  // scan missed (.github/workflows + astro.config) MUST make the gate FAIL;
  // removing it MUST restore PASS. Done via temp-write+revert so the repo is
  // never left dirty (uses real tracked files, restored in finally).
  it('confinement scan FAILS when the binding is injected into astro.config or a '
    + 'workflow, and PASSES once removed (mutation proof, repo stays clean)', () => {
    const root = path.resolve(__dirname, '../..');
    const targets = [
      'astro.config.mjs',
      '.github/workflows/test-suite.yml',
    ].map((rel) => path.join(root, rel)).filter((p) => fs.existsSync(p));
    expect(targets.length).toBeGreaterThan(0);   // anti-vacuity: targets exist

    // Baseline: no leak.
    const base = findBindingMentions();
    expect(base.hits.every((h) => TEXTUAL_ALLOWLIST.has(h))).toBe(true);

    for (const abs of targets) {
      const original = fs.readFileSync(abs, 'utf-8');
      try {
        fs.writeFileSync(abs, original + '\n# leak ADOPTION_TELEMETRY\n', 'utf-8');
        const after = findBindingMentions();
        const rel = path.relative(root, abs).split(path.sep).join('/');
        // The injected file is NOT in the allowlist => it must appear as a leak.
        const leaks = after.hits.filter((h) => !TEXTUAL_ALLOWLIST.has(h));
        expect(leaks, `injection into ${rel} must be detected`).toContain(rel);
      } finally {
        fs.writeFileSync(abs, original, 'utf-8');   // revert -> repo stays clean
      }
    }
    // Removed: back to no leak.
    const restored = findBindingMentions();
    expect(restored.hits.every((h) => TEXTUAL_ALLOWLIST.has(h))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEL-CONFIG (Blocker A): preview-env non-inheritable binding invariant.
// Cloudflare Pages r2_buckets + analytics_engine_datasets are NON-INHERITABLE:
// once an env overrides ANY of them, EVERY required serving binding must be
// re-declared there. This BLOCKING config test parses wrangler.toml and asserts
// env.preview retains R2_ASSETS while overriding ONLY the telemetry dataset.
// ---------------------------------------------------------------------------
describe('TEL-CONFIG: preview env retains all non-inheritable serving bindings', () => {
  const root = path.resolve(__dirname, '../..');
  const toml = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf-8');

  // Minimal scoped parser: collect, per top-level scope (top vs env.preview),
  // the binding= values declared under each non-inheritable table array.
  function collectBindings(table: string) {
    const top: string[] = [];
    const preview: string[] = [];
    const lines = toml.split('\n');
    let scope: 'other' | 'top' | 'preview' = 'other';
    let inTable = false;
    for (const raw of lines) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const header = line.match(/^\[\[?([A-Za-z0-9_.]+)\]?\]$/);
      if (header) {
        const name = header[1];
        if (name === `env.preview.${table}`) { scope = 'preview'; inTable = true; }
        else if (name === table) { scope = 'top'; inTable = true; }
        else { inTable = false; scope = name.startsWith('env.preview') ? 'preview' : (name.includes('.') || name.startsWith('env.') ? 'other' : 'other'); }
        continue;
      }
      if (!inTable) continue;
      const b = line.match(/^binding\s*=\s*"([^"]+)"/);
      if (b) (scope === 'preview' ? preview : top).push(b[1]);
    }
    return { top, preview };
  }

  it('preview overrides analytics_engine_datasets (telemetry) => it MUST re-declare R2_ASSETS', () => {
    const r2 = collectBindings('r2_buckets');
    const ae = collectBindings('analytics_engine_datasets');

    // Precondition truth: top-level declares both serving + telemetry bindings.
    expect(r2.top).toContain('R2_ASSETS');
    expect(ae.top).toContain('ADOPTION_TELEMETRY');

    // The override condition: preview overrides at least one non-inheritable key.
    const previewOverrides = r2.preview.length > 0 || ae.preview.length > 0;
    expect(previewOverrides).toBe(true);         // anti-vacuity: there IS an override

    // THE INVARIANT: because preview overrides a non-inheritable key, EVERY
    // required serving binding must be restated -> R2_ASSETS present in preview.
    expect(r2.preview, 'preview must re-declare R2_ASSETS (non-inheritable)').toContain('R2_ASSETS');

    // And the telemetry binding is re-declared too (it is the intended override).
    expect(ae.preview).toContain('ADOPTION_TELEMETRY');
  });

  it('preview changes ONLY the telemetry DATASET (prod -> canary), not the binding', () => {
    expect(toml).toMatch(/dataset\s*=\s*"free2aitools_adoption_v1"/);          // prod (top)
    expect(toml).toMatch(/dataset\s*=\s*"free2aitools_adoption_canary_v1"/);   // canary (preview)
    // preview R2 bucket name is the same physical serving bucket (not changed).
    const r2 = collectBindings('r2_buckets');
    expect(r2.preview).toContain('R2_ASSETS');
    expect(toml).toMatch(/\[\[env\.preview\.r2_buckets\]\][\s\S]*?bucket_name\s*=\s*"ai-nexus-assets"/);
  });
});
