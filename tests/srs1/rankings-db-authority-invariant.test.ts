// tests/srs1/rankings-db-authority-invariant.test.ts
//
// SRS-1 Tier-1 STATIC lock for the RANKINGS-DB AUTHORITY repair, part 1 of 3:
// the SINGLE-SOURCE group constant + SEAM_A (3/4 `aggregate-rankings` -> 3/4 `finalize`).
// Part 2 = rankings-db-seam-b-publication-invariant.test.ts (SEAM_B + the pre-publish
// gate); part 3 = rankings-db-verifier-source-invariant.test.ts (module source locks).
// Shared text fixtures + YAML slicers live in ./rankings-db-wf-fixtures.ts.
//
// ROOT CAUSE: the 10 `rankings-<group>.db` reached 4/4 ONLY via the `cycle-<run>-output`
// GHA cache (cache WRITES are 100% denied on this repo), the 3/4 recovery read a MUTABLE
// FIXED prefix (`state/satellite-rankings/*`) with 10 hardcoded names, every restore
// `|| true` and the count merely echoed, and `pack-finalizer.js` set
// `manifest.partitions.rankings_dbs` from an any-one-file `.some()` boolean inside a
// swallowing `try {} catch {}` -> the key was never written -> `/api/v1/select` 503.
import { describe, it, expect } from 'vitest';

import {
  AGG, UPL, CONSTANTS, FRONTEND_CONSTANTS, EXPORTER, GENERATOR, FINALIZER, CARRIER, VERIFIER,
  AGG_RANKINGS, AGG_FINALIZE, SEAM_A_PRODUCER, SEAM_A_CONSUMER,
  EXPECTED_GROUPS, stepBlock, codeOf, exists,
} from './rankings-db-wf-fixtures';

/**
 * The SINGLE detector for a `state/satellite-rankings/` COMMAND position, used by BOTH the
 * real workflow scan in #10 AND that test's own non-vacuity self-proof. Hoisted on purpose:
 * an inline predicate re-stated over string literals in the proof block cannot fail and does
 * not exercise the real scan, so #10 could go silently vacuous if the scan were narrowed.
 * A comment line naming the prefix is NOT a command position (the root-cause narrative
 * legitimately still names it).
 */
function satelliteRankingsCommands(yml: string): string[] {
  return yml.split('\n').filter((l) => l.includes('state/satellite-rankings/') && !l.trim().startsWith('#'));
}

describe('RANKINGS-DB-CONSTANT-SINGLE-SOURCE — one ordered source of the EXACT-10 group set', () => {
  it('#1 src/constants/rankings-groups.js declares exactly the 10 groups, frozen and ordered', () => {
    for (const g of EXPECTED_GROUPS) expect(CONSTANTS).toContain(`'${g}'`);
    expect(CONSTANTS).toMatch(/export const RANKINGS_GROUPS = Object\.freeze\(\[/);
    expect(CONSTANTS).toMatch(/export const RANKINGS_DB_COUNT = RANKINGS_GROUPS\.length;/);
    // plain .js on purpose: the Node factory scripts cannot import .ts
    expect(exists('src/constants/rankings-groups.js')).toBe(true);
    expect(exists('src/constants/rankings-groups.ts')).toBe(false);
  });

  it('#2 the 5 category slugs stay in parity with the frontend CATEGORY_SLUGS (no second taxonomy)', () => {
    const frontend = [...FRONTEND_CONSTANTS.matchAll(/^\s{4}'([a-z0-9-]+)',?$/gm)].map((m) => m[1]);
    const categories = [...CONSTANTS.matchAll(/^\s{4}'([a-z0-9-]+)',$/gm)].map((m) => m[1]);
    expect(frontend.length).toBe(5);
    expect(categories.slice(0, 5)).toEqual(frontend);
  });

  it('#3 NO consumer re-declares the group list: the producers/carrier/verifier IMPORT it', () => {
    for (const [name, src] of [['exporter', EXPORTER], ['generator', GENERATOR], ['carrier', CARRIER], ['verifier', VERIFIER]] as const) {
      expect(src, name).toMatch(/from '(\.\.\/)+src\/constants\/rankings-groups\.js'/);
    }
    // a local duplicate of the 10-name array (or of the category block) must not reappear
    for (const [name, src] of [['exporter', EXPORTER], ['generator', GENERATOR], ['carrier', CARRIER], ['verifier', VERIFIER], ['finalizer', FINALIZER]] as const) {
      expect(src.includes("'automation-workflow'"), `${name} must not re-declare category slugs`).toBe(false);
      expect(src.includes("'knowledge-retrieval'"), `${name} must not re-declare category slugs`).toBe(false);
    }
  });

  it('#4 NO workflow hardcodes the 10 group names (the old `for t in all model paper ...` loop is GONE)', () => {
    for (const [name, yml] of [['aggregate', AGG], ['upload', UPL]] as const) {
      expect(yml.includes('for t in all model paper dataset tool'), name).toBe(false);
      expect(yml.includes('automation-workflow'), `${name} must not carry a hardcoded rankings group list`).toBe(false);
      // and the fail-silent per-name restore shape is gone with it
      expect(yml.includes('state/satellite-rankings/rankings-'), name).toBe(false);
    }
  });
});

describe('RANKINGS-DB-SEAM-A-EXACT — aggregate-rankings -> finalize, exact + fail-closed', () => {
  it('#5 the producer establishes an attempt-scoped authority bound to run + attempt + head', () => {
    const step = stepBlock(AGG_RANKINGS, SEAM_A_PRODUCER);
    expect(step).not.toBe('');
    expect(step).toContain('HANDOFF_PRODUCER_RUN_ID: ${{ github.run_id }}');
    expect(step).toContain('HANDOFF_PRODUCER_ATTEMPT: ${{ github.run_attempt }}');
    expect(step).toContain('HANDOFF_HEAD_SHA: ${{ github.sha }}');
    expect(step).toContain('RUN_PREFIX="state/_handoff/rankings-satellite/${PID}"');
    expect(step).toContain('export STAGING="${RUN_PREFIX}/attempt-${ATT}/"');
    expect(step).toContain('set -euo pipefail');
    // no mutable-latest / list-latest / attempt glob may enter the path
    expect(step).not.toMatch(/attempt-(\*|latest|LATEST)/);
    expect(step).not.toMatch(/list-prefix[^\n]*attempt-/);
  });

  it('#6 producer ORDER: DB verification -> manifest -> data FIRST -> manifest LAST -> descriptor LAST-of-all -> read-backs', () => {
    const step = stepBlock(AGG_RANKINGS, SEAM_A_PRODUCER);
    const iVerifyDbs = step.indexOf('verify-dbs "$STAGE_LOCAL/data"');
    const iGen = step.indexOf('generate "$STAGE_LOCAL"');
    const iData = step.indexOf('backup-dir "$STAGE_LOCAL"');
    const iManifest = step.indexOf('upload-file /tmp/rankings-satellite-manifest.json');
    const iDesc = step.indexOf('upload-file /tmp/rankings-satellite-handoff.json');
    const iDescRb = step.indexOf('verify-descriptor /tmp/rankings-satellite-handoff-rb.json');
    const iSetRb = step.indexOf('RB_SET=$(node "$MOD" verify "${RB_DIR}"');
    const iAnnounce = step.indexOf('[RANKINGS-SATELLITE-HANDOFF] authority established');
    for (const i of [iVerifyDbs, iGen, iData, iManifest, iDesc, iDescRb, iSetRb, iAnnounce]) expect(i).toBeGreaterThan(0);
    expect(iGen).toBeGreaterThan(iVerifyDbs);
    expect(iData).toBeGreaterThan(iGen);
    expect(iManifest).toBeGreaterThan(iData);
    expect(iDesc).toBeGreaterThan(iManifest);
    expect(iDescRb).toBeGreaterThan(iDesc);
    expect(iSetRb).toBeGreaterThan(iDescRb);
    expect(iAnnounce).toBeGreaterThan(iSetRb);
  });

  it('#7 the exporter is handed the per-DB identity env (D6) so no DB is written without provenance', () => {
    const gen = stepBlock(AGG_RANKINGS, 'Generate Rankings');
    expect(gen).toContain('RANKINGS_RUN_ID: ${{ github.run_id }}');
    expect(gen).toContain('RANKINGS_RUN_ATTEMPT: ${{ github.run_attempt }}');
    expect(gen).toContain('RANKINGS_HEAD_SHA: ${{ github.sha }}');
    expect(EXPORTER).toMatch(/metaInsert\.run\('factory_run_id', identity\.runId\);/);
    expect(EXPORTER).toMatch(/metaInsert\.run\('factory_run_attempt', identity\.attempt\);/);
    expect(EXPORTER).toMatch(/metaInsert\.run\('head_sha', identity\.headSha\);/);
    // entity_count meaning/type UNCHANGED (live-read by catalog-fetcher pagination)
    expect(EXPORTER).toContain("metaInsert.run('entity_count', String(entities.length));");
  });

  it('#8 the finalize CONSUMER is descriptor-first, fail-closed, and NOT gated on a GHA cache hit', () => {
    const step = stepBlock(AGG_FINALIZE, SEAM_A_CONSUMER);
    expect(step).not.toBe('');
    // the OLD `if: steps.cache-rankings.outputs.cache-hit != 'true'` gate is GONE:
    // a GHA hit is not evidence of correctness, so the authority check ALWAYS runs.
    expect(step).not.toContain('cache-hit');
    expect(step).toContain('DESC="state/_handoff/rankings-satellite/${PID}/handoff.json"');
    expect(step).toContain('restore-file "$DESC" /tmp/rankings-satellite-handoff-rb.json --strict');
    expect(step).toContain('verify-descriptor /tmp/rankings-satellite-handoff-rb.json --carrier=rankings-satellite');
    expect(step).toContain('restore-file "${STAGING_PREFIX}manifest.json"');
    // every failure branch exits non-zero -- no `|| true`, no warning-only path
    expect(step).not.toMatch(/restore-file[^\n]*\|\| true/);
    expect(step).not.toMatch(/restore-dir[^\n]*\|\| true/);
    expect((step.match(/exit 1/g) || []).length).toBeGreaterThanOrEqual(6);
  });

  it('#9 the GHA accelerator is DISCARDED on mismatch and re-fetched from the EXACT prefix (D10)', () => {
    const step = stepBlock(AGG_FINALIZE, SEAM_A_CONSUMER);
    expect(step).toContain('NEED_RECOVER=1');
    expect(step).toContain('restore-dir "${STAGING_PREFIX}" "${STAGE}/" --strict');
    expect(step).toMatch(/\[ "\$\(printf '%s' "\$OUT2" \| tail -n1\)" = "\$EXPECT_SET_SHA" \]/);
    // the accelerator content is verified with the SAME verifier as R2 content
    expect(step).toContain('verify "$STAGE" /tmp/rankings-satellite-manifest.json --carrier=rankings-satellite');
    // promotion wipes stale rankings DBs, copies (never renames) and RE-VERIFIES
    expect(step).toContain('rm -f output/data/rankings-*.db');
    expect(step).toContain('cp "$STAGE"/data/rankings-*.db output/data/');
    expect(step).not.toContain('mv "$STAGE"/data');
    expect(step).toContain('verify-dbs output/data');
    // the unified defensive parse idiom: fields are cut from the LAST stdout line only
    expect(step).toMatch(/DESC_LINE=\$\(printf '%s' "\$OUT" \| tail -n1\)/);
    for (const line of codeOf(step).split('\n')) {
      if (/cut -f/.test(line)) expect(line, `must cut DESC_LINE, not raw $OUT: ${line.trim()}`).toContain('DESC_LINE');
    }
  });

  it('#9b BOTH promotion targets are WIPED (not merged) and the WHOLE projection is re-verified', () => {
    const step = stepBlock(AGG_FINALIZE, SEAM_A_CONSUMER);
    // A MERGE would let an orphan page from a previous attempt (a stale p40.json.zst after
    // totalPages shrank) survive into the cycle-output carrier and publish unverified.
    expect(step).toContain('rm -rf output/cache/rankings; mkdir -p output/cache/rankings');
    expect(step).toContain('cp -r "$STAGE"/cache/rankings/. output/cache/rankings/');
    // destination re-verification covers the PAGE half + category_stats, not only the DBs
    expect(step).toContain('verify-projection output /tmp/rankings-satellite-manifest.json --carrier=rankings-satellite');
    const iWipe = step.indexOf('rm -rf output/cache/rankings');
    const iCopy = step.indexOf('cp -r "$STAGE"/cache/rankings/.');
    const iProj = step.indexOf('verify-projection output');
    const iDbs = step.indexOf('verify-dbs output/data');
    expect(iCopy).toBeGreaterThan(iWipe);
    expect(iProj).toBeGreaterThan(iCopy);
    expect(iDbs).toBeGreaterThan(iProj);
    // identity binding is REQUIRED on the post-promotion check (never a silent degrade)
    expect(step).toContain('RANKINGS_REQUIRE_IDENTITY=1');
  });

  it('#10 the mutable fixed prefix state/satellite-rankings/ has ZERO command positions (write OR read)', () => {
    // Founder D-395 (RANKINGS-SATELLITE-PREFIX-RETIRED): the FUTURE writes are DELETED. The immutable
    // rankings-satellite authority is now the only rankings carrier for BOTH correctness and
    // diagnostics, so the ~510 PUT/cycle duplication is gone. NOTE: no existing R2 object is
    // deleted and no GC/delete behaviour is introduced -- only future writes stop.
    for (const [name, yml] of [['aggregate', AGG], ['upload', UPL]] as const) {
      const commands = satelliteRankingsCommands(yml);
      expect(commands, `${name} must carry NO state/satellite-rankings command: ${commands.join(' | ')}`).toEqual([]);
    }
    // NON-VACUITY THROUGH THE PRODUCTION PATH. Feed the REAL workflows (which must contribute
    // ZERO) plus one synthetic WRITE and one synthetic READ to the SAME detector the real scan
    // uses. Re-writing the predicate inline over string literals would be a TAUTOLOGY -- both
    // operands compile-time constants, unable to fail, and never exercising the real detector --
    // so a later narrowing of the scan would leave #10 silently vacuous. Routed this way, any
    // narrowing that stops matching either shape reds HERE.
    const syntheticWrite = '          node scripts/factory/r2-workflow-cli.js backup-dir output/cache/rankings/ state/satellite-rankings/rankings/';
    const syntheticRead = '          node scripts/factory/r2-workflow-cli.js restore-file state/satellite-rankings/rankings-all.db output/data/rankings-all.db';
    expect(satelliteRankingsCommands([AGG, UPL, syntheticWrite, syntheticRead].join('\n')))
      .toEqual([syntheticWrite, syntheticRead]);
    // each shape must be detectable ALONE (a write-only or read-only detector reds)
    expect(satelliteRankingsCommands(syntheticWrite)).toHaveLength(1);
    expect(satelliteRankingsCommands(syntheticRead)).toHaveLength(1);
    // ...and a COMMENT naming the prefix must NOT be detected, else the real scan false-fires
    expect(satelliteRankingsCommands('      # state/satellite-rankings/** is retired')).toEqual([]);
    // the retired prefix may still be NAMED in the root-cause narrative (comments only)
    const narrative = AGG.split('\n').filter((l) => l.includes('state/satellite-rankings/'));
    expect(narrative.length).toBeGreaterThan(0);
    for (const l of narrative) expect(l.trim().startsWith('#')).toBe(true);
  });

  it('#10b the accelerator decision is existence + identity, never `cache-hit` and never a count', () => {
    // `cache-hit` is 'true' ONLY on an exact primary-key hit: on a `restore-keys` PREFIX
    // match the files ARE on disk but cache-hit is 'false'. Both directions have bitten
    // this repo, so "do I already have the right files?" is answered ONLY by existence +
    // identity/hash verification against the descriptor's manifest.
    for (const [name, step] of [
      [SEAM_A_PRODUCER, stepBlock(AGG_RANKINGS, SEAM_A_PRODUCER)],
      [SEAM_A_CONSUMER, stepBlock(AGG_FINALIZE, SEAM_A_CONSUMER)],
    ] as const) {
      const code = codeOf(step);
      expect(code, `${name} must not branch on cache-hit`).not.toContain('cache-hit');
      expect(code, `${name} must not add a restore-keys prefix`).not.toContain('restore-keys');
      expect(code, `${name} must not be an actions/cache step`).not.toContain('actions/cache');
      expect(code, `${name} must not decide by count`).not.toMatch(/rankings-\*\.db[^\n]*\|\s*wc -l/);
    }
    const consumer = stepBlock(AGG_FINALIZE, SEAM_A_CONSUMER);
    expect(consumer).toContain('if OUT2=$(verify_stage) && [ "$(printf \'%s\' "$OUT2" | tail -n1)" = "$EXPECT_SET_SHA" ]; then');
    // This repair adds NO new cache restore and NO new restore-keys prefix anywhere.
    // Counts pinned at the pre-repair baseline (verified against `git show HEAD:`).
    expect(((AGG + UPL).match(/uses: actions\/cache\/restore@v5/g) || []).length).toBe(30);
    expect(((AGG + UPL).match(/restore-keys:/g) || []).length).toBe(14);
  });
});
