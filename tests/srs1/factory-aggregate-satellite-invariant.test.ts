// tests/srs1/factory-aggregate-satellite-invariant.test.ts
//
// SRS-1 Tier-1 STATIC workflow-invariant lock for the SATELLITE-REGISTRY R2
// handoff repair (Founder D-2026-0702-228 / D-230). Reads
// .github/workflows/factory-aggregate.yml as TEXT (CRLF-normalized; NO workflow
// execution, NO network, NO YAML dep) and pins the repaired DAG:
//   Persist ESTABLISHES an authoritative R2 satellite handoff (FAIL-RED) ->
//   ONE satellite-authority-preflight (needs Persist) -> the four aggregate-*
//   satellites each `needs: satellite-authority-preflight` (NOT merge-core-persist)
//   and independently CONSUME + verify the R2 handoff -> finalize needs all four.
// It also LOCKS the D-211/D-219 CORE handoff steps + the core frozen
// allowed_consumers array as byte-unchanged (contamination guard).
// ROOT CAUSE (SATELLITE_REGISTRY_HANDOFF_CONTINUITY_INCIDENT): the warning-only
// GHA satellite cache save was write-auth DENIED, leaving Persist green with no
// carrier and the four satellites with no R2 fallback for the registry INPUT.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const WF = path.resolve(__dirname, '../../.github/workflows/factory-aggregate.yml');
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');
const CORE = path.resolve(__dirname, '../../scripts/factory/aggregate-handoff.mjs');
const core = fs.readFileSync(CORE, 'utf8').replace(/\r\n/g, '\n');

// Slice the text of a single named job (up to the next top-level `  <job>:`).
function jobBlock(name: string): string {
  const start = yml.indexOf(`\n  ${name}:`);
  if (start < 0) return '';
  const rest = yml.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}
function needsOf(block: string): string {
  const m = block.match(/\n {4}needs:\s*(.+)/);
  return m ? m[1].trim() : '';
}
// Slice one named step (up to the next `      - name:` / `      - uses:`).
function stepBlock(block: string, stepName: string): string {
  const start = block.indexOf(`- name: ${stepName}`);
  if (start < 0) return '';
  const rest = block.slice(start + 1);
  const next = rest.search(/\n {6}- (name|uses):/);
  return next < 0 ? rest : rest.slice(0, next);
}

const PERSIST = jobBlock('merge-core-persist');
const PREFLIGHT = jobBlock('satellite-authority-preflight');
const SEARCH = jobBlock('aggregate-search');
const RANKINGS = jobBlock('aggregate-rankings');
const TRENDING = jobBlock('aggregate-trending');
const RELATIONS = jobBlock('aggregate-relations');
const FINALIZE = jobBlock('finalize');
const CONSUMERS: [string, string, string][] = [
  ['aggregate-search', SEARCH, 'search-index'],
  ['aggregate-rankings', RANKINGS, 'rankings'],
  ['aggregate-trending', TRENDING, 'trending'],
  ['aggregate-relations', RELATIONS, 'knowledge-mesh'],
];
const SAT_KEY = 'intra-cycle-${{ github.run_id }}-satellite';

describe('satellite handoff DAG - preflight gate + consumer edges', () => {
  it('satellite-authority-preflight EXISTS and needs merge-core-persist', () => {
    expect(PREFLIGHT).not.toBe('');
    expect(needsOf(PREFLIGHT)).toContain('merge-core-persist');
    // the preflight step runs the verify-only CLI (establishes/consumes nothing to workspace)
    expect(PREFLIGHT).toContain('satellite-registry-preflight');
  });

  it('each of the four satellites needs satellite-authority-preflight, NOT merge-core-persist', () => {
    for (const [name, block] of CONSUMERS) {
      const needs = needsOf(block);
      expect(needs, `${name} needs`).toContain('satellite-authority-preflight');
      expect(needs, `${name} must not need merge-core-persist directly`).not.toContain('merge-core-persist');
    }
  });

  it('finalize still needs ALL FOUR satellites + check-upstream (edge set UNCHANGED)', () => {
    const needs = needsOf(FINALIZE);
    for (const dep of ['aggregate-search', 'aggregate-rankings', 'aggregate-trending', 'aggregate-relations', 'check-upstream']) {
      expect(needs).toContain(dep);
    }
  });

  it('ONLY the preflight job depends on merge-core-persist (no satellite fans out from Persist)', () => {
    // Every `needs:` that names merge-core-persist must be the preflight job's.
    const persistDependents = yml.split('\n').filter((l) => /^ {4}needs:.*merge-core-persist/.test(l));
    expect(persistDependents.length).toBe(1);
  });
});

describe('producer establish + preflight are FAIL-RED (no warning-only-green)', () => {
  it('Persist ESTABLISHES the authoritative R2 satellite handoff, fail-red', () => {
    const step = stepBlock(PERSIST, 'Establish Authoritative R2 Satellite Registry Handoff');
    expect(step).not.toBe('');
    expect(step).toContain('satellite-registry-establish');
    expect(step).toContain('if: success()');
    // FATAL: a failed establish must NOT be downgraded to a warning.
    expect(step).not.toContain('continue-on-error');
    // step-level R2 creds + attempt identity are projected (composite setup cannot inject secrets)
    for (const k of ['R2_ACCESS_KEY_ID', 'CYCLE_ID: ${{ needs.check-upstream.outputs.process-id }}', 'PRODUCER_MAIN_SHA: ${{ github.sha }}']) {
      expect(step).toContain(k);
    }
  });

  it('preflight step is fail-red (no continue-on-error)', () => {
    const step = stepBlock(PREFLIGHT, 'Preflight Satellite Registry Authority (R2)');
    expect(step).not.toBe('');
    expect(step).not.toContain('continue-on-error');
  });

  it('each satellite runs its exact consume role against the R2 handoff', () => {
    for (const [name, block, role] of CONSUMERS) {
      expect(block, `${name} consume`).toContain(`satellite-registry-consume --role=${role}`);
      // consume step carries step-level R2 creds + the SAME attempt identity as the producer
      const step = stepBlock(block, 'Consume Satellite Registry Handoff (R2)');
      expect(step).toContain('CYCLE_ID: ${{ needs.check-upstream.outputs.process-id }}');
      expect(step).toContain('PRODUCER_MAIN_SHA: ${{ github.sha }}');
    }
  });
});

describe('GHA satellite carrier removed from the correctness path (Option 1)', () => {
  it('no consumer job restores the removed satellite carrier or the global-registry carrier', () => {
    for (const [name, block] of CONSUMERS) {
      expect(block, `${name} must not carry the removed -satellite cache`).not.toContain(SAT_KEY);
      expect(block, `${name} must not restore global-registry-<run>`).not.toContain('global-registry-${{ github.run_id }}');
    }
  });

  it('no consumer or preflight job uses a restore-keys prefix (no latest/prefix fallback)', () => {
    for (const block of [PREFLIGHT, SEARCH, RANKINGS, TRENDING, RELATIONS]) {
      expect(block).not.toContain('restore-keys:');
    }
  });

  it('the removed Restore/Save Satellite Cache steps are gone workflow-wide', () => {
    expect(yml).not.toContain('name: Restore Satellite Cache');
    expect(yml).not.toContain('name: Save Satellite Cache');
    // Trending's removed global-registry restore (id cache-restore-registry) + its two
    // fail-closed guards (incl. the forbidden "Re-run failed jobs" recovery text) are gone.
    expect(TRENDING).not.toContain('cache-restore-registry');
    expect(TRENDING).not.toContain('Re-run failed jobs');
  });

  it('the removed satellite INPUT carrier is ABSENT workflow-wide (no executable step AND no inert comment)', () => {
    // Founder D-2026-0702-231: the legacy `intra-cycle-<run>-satellite` INPUT carrier
    // must not appear ANYWHERE in the YAML - not on an executable cache step, and not
    // as a compatibility comment (which would launder the frozen core WF-2 marker).
    expect(yml).not.toContain(SAT_KEY);
    expect(yml).not.toMatch(new RegExp(`key:\\s*${SAT_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});

describe('D-211/D-219 CORE handoff untouched (contamination guard)', () => {
  it('the three CORE handoff steps + exact core roles are byte-present', () => {
    expect(yml.split('handoff-establish').length - 1).toBe(1); // exactly the ONE core establish
    expect(yml).toContain('handoff-consume --role=merge-core-persist');
    expect(yml).toContain('handoff-consume --role=finalize');
    expect(yml.split('name: Consume Authoritative R2 Handoff (Core)').length - 1).toBe(2); // persist + finalize
    expect(yml).toContain('name: Establish Authoritative R2 Handoff (Core)');
  });

  it('the R2 prefix is never hardcoded/mutated in the workflow YAML', () => {
    // The internal-handoff prefix is built in module code, never in YAML (also a core WF-6 lock).
    expect(yml).not.toContain('internal-handoff');
    expect(yml).not.toMatch(/delete-prefix\s+internal-handoff/);
  });

  it('the CORE aggregate-handoff frozen allowed_consumers array is byte-unchanged', () => {
    // ADDING a satellite role here would red BOTH this lock and the core exact-array
    // test (aggregate-handoff.test.mjs), proving the satellite contract is isolated.
    expect(core).toContain("export const ALLOWED_CONSUMERS = Object.freeze(['merge-core-persist', 'finalize']);");
    for (const r of ['search-index', 'rankings', 'knowledge-mesh', 'trending']) {
      expect(core).not.toContain(`'${r}'`);
    }
  });
});
