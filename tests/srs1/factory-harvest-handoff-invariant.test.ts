// tests/srs1/factory-harvest-handoff-invariant.test.ts
//
// SRS-1 Tier-1 STATIC workflow-invariant lock for the HARVEST R2 source-authority
// handoff repair (Founder D-2026-0703-236 / D-237). Reads
// .github/workflows/factory-harvest.yml + scripts/factory/harvest-authoritative-
// handoff.mjs as TEXT (CRLF-normalized; NO workflow execution, NO network, NO YAML
// dep) and pins the repaired seam:
//   each of the 4 producer jobs ESTABLISHES its role authority (FAIL-RED) ->
//   Merge RESOLVES + CONSUMES four immutable R2 authorities from one exact
//   run/attempt (current-then-bounded-prior; skip_harvest exact tuple) and
//   withholds FOUR_R2_SOURCE_AUTHORITIES_VERIFIED before publication.
// It LOCKS the frozen role-membership contract against the workflow's actual
// `harvest-single.js <source>` invocations (drift guard) and locks the D-219 core
// + D-228 satellite frozen allowed_consumers arrays as byte-unchanged (isolation).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const yml = read('../../.github/workflows/factory-harvest.yml');
const mjs = read('../../scripts/factory/harvest-authoritative-handoff.mjs');
const core = read('../../scripts/factory/aggregate-handoff.mjs');
const sat = read('../../scripts/factory/satellite-registry-handoff.mjs');

// Slice the text of a single named job (up to the next top-level `  <job>:`).
function jobBlock(name: string): string {
  const start = yml.indexOf(`\n  ${name}:`);
  if (start < 0) return '';
  const rest = yml.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}
// Slice one named step (up to the next `      - name:` / `      - uses:`).
function stepBlock(block: string, stepName: string): string {
  const start = block.indexOf(`- name: ${stepName}`);
  if (start < 0) return '';
  const rest = block.slice(start + 1);
  const next = rest.search(/\n {6}- (name|uses):/);
  return next < 0 ? rest : rest.slice(0, next);
}
// The sources actually invoked by `harvest-single.js <source>` in a job block.
function harvestSourcesIn(block: string): Set<string> {
  return new Set([...block.matchAll(/harvest-single\.js\s+([a-z0-9-]+)/g)].map((m) => m[1]));
}
// The owned sources declared for a role in the frozen ROLE_MEMBERSHIP constant.
function contractSourcesFor(role: string): Set<string> {
  const line = mjs.split('\n').find((l) => l.trim().startsWith(`${role}: Object.freeze(`)) || '';
  return new Set([...line.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));
}

const ESTABLISH = 'Establish Authoritative R2 Harvest Source Authority';
const PRODUCERS: [string, string, string[]][] = [
  ['harvest-huggingface', 'huggingface', ['huggingface']],
  ['harvest-github', 'github', ['github']],
  ['harvest-academic', 'academic', ['arxiv', 'huggingface-papers', 'huggingface-datasets']],
  ['harvest-ecosystem', 'ecosystem', ['ollama', 'mcp', 'replicate', 'kaggle', 'civitai', 'semanticscholar', 'openllm', 'benchmark', 'deepspec', 'agents']],
];
const MERGE = jobBlock('merge-and-upload');

describe('producer establish steps are FAIL-RED per role', () => {
  it('each of the 4 producer jobs establishes its OWN role authority (fail-red, identity env)', () => {
    for (const [job, role] of PRODUCERS) {
      const block = jobBlock(job);
      expect(block, `${job} block`).not.toBe('');
      const step = stepBlock(block, ESTABLISH);
      expect(step, `${job} establish step`).not.toBe('');
      expect(step).toContain(`harvest-handoff-establish --role=${role}`);
      // FATAL: a failed establish must NOT be downgraded to a warning.
      expect(step, `${job} establish must be fail-red`).not.toContain('continue-on-error');
      // gated on the non-recovery path only.
      expect(step).toContain("if: github.event.inputs.skip_harvest != 'true'");
      // step-level R2 creds + attempt identity (auto GITHUB_* are also projected).
      for (const k of ['R2_ACCESS_KEY_ID', 'GITHUB_RUN_ID: ${{ github.run_id }}', 'GITHUB_RUN_ATTEMPT: ${{ github.run_attempt }}', 'PRODUCER_MAIN_SHA: ${{ github.sha }}']) {
        expect(step, `${job} establish env ${k}`).toContain(k);
      }
    }
  });

  it('exactly the 4 producer jobs carry an establish step (no fan-out / no merge establish)', () => {
    expect(yml.split('harvest-handoff-establish').length - 1).toBe(4);
    expect(MERGE).not.toContain('harvest-handoff-establish');
  });
});

describe('frozen role-membership contract == workflow harvest-single.js invocations (drift guard)', () => {
  it('each role owned-source set matches BOTH the workflow AND the frozen mjs contract', () => {
    for (const [job, role, expected] of PRODUCERS) {
      const expectedSet = new Set(expected);
      const fromWorkflow = harvestSourcesIn(jobBlock(job));
      const fromContract = contractSourcesFor(role);
      expect([...fromWorkflow].sort(), `${role} workflow sources`).toEqual([...expectedSet].sort());
      expect([...fromContract].sort(), `${role} mjs contract sources`).toEqual([...expectedSet].sort());
    }
  });

  it('membership is EXPLICIT config, not dir-scan (the mjs derives owned sets from ROLE_MEMBERSHIP)', () => {
    expect(mjs).toContain('export const ROLE_MEMBERSHIP = Object.freeze({');
    // no directory listing of data/ drives the authorized member set.
    expect(mjs).not.toMatch(/readdirSync[^\n]*data\/\*/);
  });
});

describe('Merge consumes four R2 authorities; the old GHA correctness gate is GONE', () => {
  it('Merge runs the R2 resolver (harvest-handoff-consume), fail-red, with both-mode identity env', () => {
    const step = stepBlock(MERGE, 'Resolve and Consume R2 Harvest Source Authorities');
    expect(step).not.toBe('');
    expect(step).toContain('harvest-handoff-consume');
    expect(step).not.toContain('continue-on-error');
    for (const k of ['GITHUB_RUN_ID: ${{ github.run_id }}', 'GITHUB_RUN_ATTEMPT: ${{ github.run_attempt }}', 'PRODUCER_MAIN_SHA: ${{ github.sha }}',
      'SKIP_HARVEST: ${{ github.event.inputs.skip_harvest }}', 'SOURCE_RUN_ID: ${{ github.event.inputs.source_run_id }}', 'SOURCE_RUN_ATTEMPT: ${{ github.event.inputs.source_run_attempt }}']) {
      expect(step, `resolver env ${k}`).toContain(k);
    }
  });

  it('NO GHA cache-hit fatal gate survives on EITHER path (current-run OR skip_harvest)', () => {
    // Founder D-231 lesson: a comment must NOT launder the removed gate. Both the
    // current-run gate (ATTEMPT_CACHE_SET_INCOMPLETE) AND the skip_harvest gate
    // (Source Attempt Provenance Gate) are gone workflow-wide.
    expect(yml).not.toContain('Attempt Cache Provenance Gate (4/4 exact hits required)');
    expect(yml).not.toContain('ATTEMPT_CACHE_SET_INCOMPLETE');
    expect(yml).not.toContain('cache_provenance_gate');
    expect(yml).not.toContain('Source Attempt Provenance Gate (4/4 exact hits required)');
    // FIX 3 / §K#3: no step consumes a restore_*/recover_* cache-hit output to
    // fail-close a merge — a GHA miss must never be fatal while a valid R2 authority
    // exists (this closes the GHA-miss-fatal-despite-valid-R2 gap on BOTH paths).
    expect(/steps\.(restore|recover)_\w+\.outputs\.cache-hit/.test(yml)).toBe(false);
  });

  it('the R2 resolver PRECEDES the NDJSON bridge + Merge Batches (authority before publication)', () => {
    const idx = (n: string) => yml.indexOf(n);
    const resolver = idx('name: Resolve and Consume R2 Harvest Source Authorities');
    expect(resolver).toBeGreaterThan(0);
    expect(idx('name: List Batches (Current or Recovered)')).toBeGreaterThan(resolver);
    expect(idx('name: Merge Batches')).toBeGreaterThan(resolver);
  });

  it('GHA is DEMOTED but attempt-scoped keys survive; the R2 prefix is never hardcoded in YAML', () => {
    // attempt-scoped current-run restore keys preserved (B1A), now accel-only.
    for (const g of ['huggingface', 'github', 'academic', 'ecosystem']) {
      expect(yml).toContain(`key: harvest-raw-${g}-` + '${{ github.run_id }}-attempt-${{ github.run_attempt }}');
    }
    // the internal-handoff/harvest prefix lives in module code, never YAML.
    expect(yml).not.toContain('internal-handoff');
  });
});

describe('D-219 core + D-228 satellite carriers untouched (contamination guard)', () => {
  it('the core + satellite frozen allowed_consumers arrays are byte-present + disjoint from harvest', () => {
    expect(core).toContain("export const ALLOWED_CONSUMERS = Object.freeze(['merge-core-persist', 'finalize']);");
    expect(sat).toContain("export const ALLOWED_CONSUMERS = Object.freeze(['search-index', 'rankings', 'knowledge-mesh', 'trending']);");
    expect(mjs).toContain("export const ALLOWED_CONSUMERS = Object.freeze(['merge']);");
    // harvest never lists a core/satellite consumer, nor vice versa.
    for (const r of ['merge-core-persist', 'finalize', 'search-index', 'rankings', 'knowledge-mesh', 'trending']) {
      expect(mjs).not.toContain(`'${r}'`);
    }
    for (const c of [core, sat]) expect(c).not.toContain("'merge'");
    // distinct R2 root prefixes (zero namespace collision).
    expect(mjs).toContain("export const HANDOFF_PREFIX_ROOT = 'internal-handoff/harvest';");
    expect(core).toContain("'internal-handoff/aggregate'");
    expect(sat).toContain("'internal-handoff/aggregate-satellite'");
  });

  it('the harvest carrier binds github.run_id as identity with NO independent cycle_id field', () => {
    expect(mjs).toContain('FOUR_R2_SOURCE_AUTHORITIES_VERIFIED');
    // §2: manifest binds github_run_id; a generic cycle_id authority is not introduced.
    expect(mjs).not.toMatch(/cycle_id:\s*identity/);
  });
});
