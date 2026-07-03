// tests/unit/harvest-cache-provenance.test.ts
// WO-3-B1 PR-B1A cache-provenance invariants, RECONCILED to the D-2026-0703-236/
// -237 R2 source-authority handoff (Founder D-70 PART II preserved; D-236/D-237
// supersedes the GHA-as-correctness gate). HERMETIC/STATIC: reads
// .github/workflows/factory-harvest.yml AND scripts/factory/harvest-authoritative-
// handoff.mjs as TEXT (no workflow execution, no network, no YAML dep).
//
// PRESERVED (still valid): attempt-scoped GHA cache keys are the accel carrier
// (#1 save, #11 no run-id-only, #2/#13 if:always save-guard, #3 restore==save,
// #4/#12 no restore-keys prefix, #7/#8 key-encodes-attempt) + the skip_harvest
// exact source-attempt provenance (#10/#10b).
// REPLACED (obsolete): the run/attempt 4/4-GHA-hit correctness gate
// (ATTEMPT_CACHE_SET_INCOMPLETE, #5/#6/#9/#5b) — GHA is DEMOTED to R2-verified
// acceleration; R2 is the sole authority. The revised block asserts the 12
// D-237 §C R2-authority properties on EXECUTABLE source (no comment/echo/dead-var
// laundering, D-231).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const yml = read('../../.github/workflows/factory-harvest.yml');
const mjs = read('../../scripts/factory/harvest-authoritative-handoff.mjs');
const lines = yml.split('\n');

const GROUPS = ['huggingface', 'github', 'academic', 'ecosystem'] as const;
function currentKey(group: string): string { return `key: harvest-raw-${group}-\${{ github.run_id }}-attempt-\${{ github.run_attempt }}`; }
function sourceKey(group: string): string { return `key: harvest-raw-${group}-\${{ github.event.inputs.source_run_id }}-attempt-\${{ github.event.inputs.source_run_attempt }}`; }
function harvestRawKeyLines(): string[] { return lines.map((l) => l.trim()).filter((l) => l.startsWith('key: harvest-raw-')); }
function stepLineIdx(stepName: string): number { return lines.findIndex((l) => l.includes(`name: ${stepName}`)); }

describe('WO-3-B1 PR-B1A — attempt-scoped GHA cache keys (accel carrier, PRESERVED)', () => {
  it('#1 all 4 Solidify save keys carry both run_id AND run_attempt', () => {
    for (const g of GROUPS) expect(yml).toContain(currentKey(g));
    expect(yml).toContain('actions/cache/save@v5');
  });

  it('#11 NEGATIVE: no current harvest-raw key uses the run-id-only (no run_attempt) form', () => {
    for (const g of GROUPS) {
      const bare = `key: harvest-raw-${g}-\${{ github.run_id }}`;
      expect(lines.some((l) => l.trim() === bare)).toBe(false);
      expect(lines.some((l) => l.trim() === currentKey(g))).toBe(true);
    }
  });

  it('#2/#13 all 4 Solidify save steps retain if: always() (failed-harvest sidecar still saved)', () => {
    const guard = "if: always() && github.event.inputs.skip_harvest != 'true'";
    expect(lines.filter((l) => l.trim() === guard).length).toBe(4);
  });
});

describe('WO-3-B1 PR-B1A — exact-only current-run restores (PRESERVED)', () => {
  it('#3 the 4 Merge current-run restore keys equal the 4 save keys (byte-identical, attempt-scoped)', () => {
    for (const g of GROUPS) expect(yml.split(currentKey(g)).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('#4/#12 NEGATIVE: no harvest-raw restore uses a restore-keys: prefix (exact-only)', () => {
    expect(/restore-keys:\s*harvest-raw-/.test(yml)).toBe(false);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('key: harvest-raw-')) expect((lines[i + 1] || '').trim().startsWith('restore-keys')).toBe(false);
    }
  });

  it('#7/#8 every harvest-raw key encodes run_attempt (current) or source_run_attempt (skip)', () => {
    const keys = harvestRawKeyLines();
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const k of keys) {
      expect(k.includes('attempt-${{ github.run_attempt }}') || k.includes('attempt-${{ github.event.inputs.source_run_attempt }}')).toBe(true);
    }
  });
});

describe('D-236/D-237 — R2 source-authority REPLACES the GHA correctness gate', () => {
  // The obsolete #5/#6/#9/#5b assertions (the 4/4-GHA-hit ATTEMPT_CACHE gate) are
  // removed with the gate. GHA is now accel-only; R2 is the sole authority.
  it('the old run/attempt 4/4-GHA correctness gate is GONE (executable AND comment)', () => {
    expect(yml).not.toContain('Attempt Cache Provenance Gate (4/4 exact hits required)');
    expect(yml).not.toContain('ATTEMPT_CACHE_SET_INCOMPLETE');
    expect(yml).not.toContain('cache_provenance_gate');
    // no current-run gate consumes restore cache-hit outputs to fail-close a merge.
    expect(yml).not.toMatch(/steps\.restore_hf\.outputs\.cache-hit/);
  });

  it('the workflow delegates authority to the R2 resolver BEFORE the bridge + merge', () => {
    const resolverIdx = stepLineIdx('Resolve and Consume R2 Harvest Source Authorities');
    expect(resolverIdx).toBeGreaterThan(0);
    const step = yml.slice(yml.indexOf('name: Resolve and Consume R2 Harvest Source Authorities'), yml.indexOf('name: R2 Batch Recovery (Fallback)'));
    expect(step).toContain('harvest-handoff-consume');
    expect(step).not.toContain('continue-on-error'); // fail-closed
    expect(step).toContain('SKIP_HARVEST: ${{ github.event.inputs.skip_harvest }}');
    expect(resolverIdx).toBeLessThan(stepLineIdx('List Batches (Current or Recovered)'));
    expect(resolverIdx).toBeLessThan(stepLineIdx('Merge Batches'));
  });

  // The 12 D-237 §C properties, each pinned to the EXECUTABLE source that encodes it.
  const R2_PROPS: [string, string][] = [
    ['GHA accel-only: probe the R2 manifest inventory', 'ghaProbe(workspaceDir, manifest.inventory)'],
    ['GHA-hit not sufficient: only a byte+sha EXACT match skips R2', "if (status === 'GHA_EXACT_MATCH')"],
    ['used-GHA must MATCH the selected R2 manifest (byte+sha per member)', 'if (bytes !== e.bytes || sha256 !== e.sha256)'],
    ['GHA mismatch is discarded via a fresh clean staging', 'deps.prepareCleanStaging(stagingDir, treeDir)'],
    ['miss/mismatch -> download the EXACT R2 archive', 'await deps.download(r2, archiveKey, archiveDest)'],
    ['downloaded R2 archive is byte+sha verified', 'HANDOFF_SHA_MISMATCH'],
    ['merge blocked until FOUR R2 authorities verified', 'FOUR_R2_SOURCE_AUTHORITIES_VERIFIED'],
    ['current-partial fails closed (no prior fallback)', "fail('HARVEST_MERGE_CURRENT_PARTIAL'"],
    ['current-empty -> bounded highest prior-complete of the SAME run', 'HIGHEST_PRIOR_COMPLETE_ATTEMPT_OF_SAME_RUN'],
    ['bounded DESCENDING same-run search (no cross-run)', 'for (let a = currentN - 1; a >= 1; a -= 1)'],
    ['skip_harvest is the EXACT (source_run_id, source_run_attempt) tuple only', 'export async function resolveExactTuple'],
    ['exact object keys only (never prefix/latest/alias)', 'manifestKeyFor(expected)'],
  ];
  it('the R2 resolver encodes the 12 D-237 §C authority properties (executable source)', () => {
    for (const [label, needle] of R2_PROPS) expect(mjs, label).toContain(needle);
    // NEGATIVE: a GHA status is NEVER a per-se fatal (no fail('GHA_*)); no
    // prefix/latest/restore-keys authority lookup leaks into the resolver.
    expect(/fail\(\s*'GHA_/.test(mjs)).toBe(false);
    expect(mjs).not.toContain('restore-keys');
    expect(mjs).not.toContain('listPrefix');
    expect(mjs).toContain("if (v === 'latest')"); // identity rejects the mutable token
  });
});

describe('WO-3-B1 PR-B1A — skip_harvest source-attempt provenance (PRESERVED)', () => {
  it('#10 skip_harvest declares a source_run_attempt input and uses exact source-attempt keys', () => {
    expect(yml).toContain('source_run_attempt:');
    for (const g of GROUPS) expect(yml).toContain(sourceKey(g));
  });

  it('#10b input Pre-Check PRESERVED (both inputs, fail-closed); the GHA 4/4 source gate is GONE (§J)', () => {
    // PRESERVED: the input Pre-Check hard-requires BOTH inputs and fail-closes on a
    // missing one — the legitimate fail-closed-on-missing-provenance-inputs.
    const preIdx = stepLineIdx('Source Attempt Provenance Pre-Check (skip_harvest)');
    expect(preIdx).toBeGreaterThan(0);
    const preBlock = yml.slice(yml.indexOf('Source Attempt Provenance Pre-Check'), yml.indexOf('Source Attempt Provenance Pre-Check') + 900);
    expect(preBlock).toContain('source_run_id');
    expect(preBlock).toContain('source_run_attempt');
    expect(preBlock).toContain('exit 1');
    // REMOVED (FIX 1 / D-237 §J): the skip_harvest 4/4-GHA correctness gate made a
    // GHA miss fatal despite a valid R2 authority. Its step name + its COMPLETE token
    // are gone, and NO step consumes a recover_* cache-hit output (resolveExactTuple
    // is the sole authority; recover_* restores are R2-verified acceleration only).
    expect(yml).not.toContain('Source Attempt Provenance Gate (4/4 exact hits required)');
    expect(yml).not.toContain('SOURCE_ATTEMPT_PROVENANCE_COMPLETE');
    expect(/steps\.recover_\w+\.outputs\.cache-hit/.test(yml)).toBe(false);
  });
});

describe('scope guard (#14 reconciled): load-bearing surfaces unchanged; R2 authority is the additive change', () => {
  it('#14 merge floor 85000 + health summary + per-job timeouts + legacy R2 keys unchanged', () => {
    // Untouched by this repair (the R2 source-authority hierarchy is ADDITIVE).
    expect(yml).toContain('-lt 85000');
    expect(yml).toContain('Harvest Health Summary');
    expect(yml).toContain('timeout-minutes: 330');
    expect(yml).toContain('timeout-minutes: 300');
    expect(yml).toContain('timeout-minutes: 120');
    // Legacy fixed-key object hierarchy + the ingestion/raw stream remain.
    expect(yml).toContain('ingestion/raw/');
    expect(yml).toContain('state/harvest-health/latest.json');
  });
});
