// tests/srs1/rankings-db-seam-b-publication-invariant.test.ts
//
// SRS-1 Tier-1 STATIC lock for the RANKINGS-DB AUTHORITY repair, part 2 of 3:
// SEAM_B (3/4 `finalize` -> 4/4 `vfs-pack-db`) + the TWO fail-closed gates that stand
// between a verified rankings set and the sole public CDN write. Part 1 =
// rankings-db-authority-invariant.test.ts; part 3 = rankings-db-verifier-source-invariant.
// Shared text fixtures + YAML slicers live in ./rankings-db-wf-fixtures.ts.
import { describe, it, expect } from 'vitest';
import {
  AGG, UPL, CARRIER, FINALIZER, SELECT, AGG_FINALIZE, PACK_JOB, UPLOAD_JOB,
  SEAM_B_PRODUCER, SEAM_B_CONSUMER, PUB_GATE, PUBLISH, stepBlock, jobBlock, codeOf, jsCodeOf,
  rankingsVerifySites,
} from './rankings-db-wf-fixtures';

describe('RANKINGS-DB-SEAM-B-EXACT — finalize -> 4/4 vfs-pack-db, exact + fail-closed', () => {
  it('#11 finalize establishes the SEPARATE rankings-db carrier (a second descriptor, its own prefix root)', () => {
    const step = stepBlock(AGG_FINALIZE, SEAM_B_PRODUCER);
    expect(step).not.toBe('');
    expect(step).toContain('RUN_PREFIX="state/_handoff/rankings-db/${PID}"');
    expect(step).toContain('export STAGING="${RUN_PREFIX}/attempt-${ATT}/"');
    expect(step).toContain('--carrier=rankings-db');
    expect(step).toContain('set -euo pipefail');
    expect(AGG_FINALIZE).toContain('rankings_db_staging_prefix: ${{ steps.establish-rankings-db.outputs.staging_prefix }}');
    expect(AGG_FINALIZE).toContain('rankings_db_set_sha: ${{ steps.establish-rankings-db.outputs.set_sha }}');
    // the two seams have DISTINCT prefix roots (one descriptor cannot bind both)
    expect(AGG).toContain('state/_handoff/rankings-satellite/');
    expect(AGG).toContain('state/_handoff/rankings-db/');
  });

  it('#12 SEAM_B producer ORDER mirrors the canonical commit-last shape + full-set read-back', () => {
    const step = stepBlock(AGG_FINALIZE, SEAM_B_PRODUCER);
    const iVerify = step.indexOf('verify-dbs "$STAGE_LOCAL/data"');
    const iGen = step.indexOf('generate "$STAGE_LOCAL" /tmp/rankings-db-manifest.json');
    const iData = step.indexOf('backup-dir "$STAGE_LOCAL"');
    const iManifest = step.indexOf('upload-file /tmp/rankings-db-manifest.json');
    const iDesc = step.indexOf('upload-file /tmp/rankings-db-handoff.json');
    const iRb = step.indexOf('RB_SET=$(node "$MOD" verify "${RB_DIR}"');
    for (const i of [iVerify, iGen, iData, iManifest, iDesc, iRb]) expect(i).toBeGreaterThan(0);
    expect(iGen).toBeGreaterThan(iVerify);
    expect(iData).toBeGreaterThan(iGen);
    expect(iManifest).toBeGreaterThan(iData);
    expect(iDesc).toBeGreaterThan(iManifest);
    expect(iRb).toBeGreaterThan(iDesc);
    expect(step.indexOf('[RANKINGS-DB-HANDOFF] authority established')).toBeGreaterThan(iRb);
  });

  it('#13 the 4/4 consumer resolves the descriptor, family-binds the head SHA, and promotes by verified COPY', () => {
    const step = stepBlock(PACK_JOB, SEAM_B_CONSUMER);
    expect(step).not.toBe('');
    // cross-workflow cycle key = the 3/4 run id = check-upstream upstream-run-id
    expect(step).toContain('HANDOFF_PRODUCER_RUN_ID: ${{ needs.check-upstream.outputs.upstream-run-id }}');
    expect(step).toContain('DESC="state/_handoff/rankings-db/${PID}/handoff.json"');
    expect(step).toContain('verify-descriptor /tmp/rankings-db-handoff-rb.json --carrier=rankings-db');
    // head-SHA bind for a seam whose consumer cannot know the 3/4 sha on its own
    expect(step).toContain('verify-sibling /tmp/rankings-db-handoff-rb.json /tmp/rankings-db-sibling.json');
    expect(step).toContain('state/_handoff/cycle-output/${PID}/handoff.json');
    // exact staging -> /tmp (never a new output/ subtree) -> full check set -> copy -> re-verify
    expect(step).toContain('restore-dir "${STAGING_PREFIX}" "${STAGE}/" --strict');
    expect(step).toContain('STAGE=/tmp/rankings-stage');
    expect(step).toContain('node "$MOD" verify-dbs "$STAGE/data"');
    expect(step).toContain('rm -f output/data/rankings-*.db');
    expect(step).toContain('cp "$STAGE"/data/rankings-*.db output/data/');
    expect(step).toContain('node "$MOD" verify-dbs output/data');
    expect(step).not.toMatch(/attempt-(\*|latest|LATEST)/);
    expect(step).not.toContain('mv "$STAGE"/data');
    // unified defensive parse: fields cut from the LAST stdout line only
    expect(step).toMatch(/DESC_LINE=\$\(printf '%s' "\$OUT" \| tail -n1\)/);
    for (const line of codeOf(step).split('\n')) {
      if (/cut -f/.test(line)) expect(line, `must cut DESC_LINE: ${line.trim()}`).toContain('DESC_LINE');
    }
    // no authority-path command may be softened: `|| true` is allowed ONLY on the
    // best-effort sidecar cleanup, never on a restore/verify/copy.
    for (const line of codeOf(step).split('\n')) {
      if (!/\|\| true/.test(line)) continue;
      expect(line, `softened authority command: ${line.trim()}`).toMatch(/^\s*rm -f .*2>\/dev\/null \|\| true$/);
    }
  });

  it('#14 promotion runs UNCONDITIONALLY, AFTER the vfs-pack cache restore and BEFORE skip-detection + the Packer', () => {
    const iCacheRestore = PACK_JOB.indexOf('Restore VFS Pack Output for Skip Detection (V27.52)');
    const iPromote = PACK_JOB.indexOf(SEAM_B_CONSUMER);
    const iDetect = PACK_JOB.indexOf('Detect vfs-pack output present');
    const iPacker = PACK_JOB.indexOf('Execute Stable 1.0 Packer');
    const iHandoff = PACK_JOB.indexOf('id: vfs-pack-handoff');
    for (const i of [iCacheRestore, iPromote, iDetect, iPacker, iHandoff]) expect(i).toBeGreaterThan(0);
    expect(iPromote).toBeGreaterThan(iCacheRestore);
    expect(iDetect).toBeGreaterThan(iPromote);
    expect(iPacker).toBeGreaterThan(iPromote);
    // in place before the vfs-pack handoff manifest captures output/data/*.db (FIX-4 binding)
    expect(iHandoff).toBeGreaterThan(iPromote);
    // NOT gated on skip_compute / force_fresh -- a skip path must still get the authority
    const code = codeOf(stepBlock(PACK_JOB, SEAM_B_CONSUMER));
    expect(code).not.toContain('skip_compute');
    expect(code).not.toContain('force_fresh');
    expect(code).not.toMatch(/\n\s+if:/);
    expect(code).not.toContain('cache-hit');
    expect(code).not.toContain('restore-keys');
  });

  it('#15 the Packer step receives the authority binding so pack-finalizer can enforce identity (D9a)', () => {
    const packer = stepBlock(PACK_JOB, 'Execute Stable 1.0 Packer');
    expect(packer).toContain('RANKINGS_DB_MANIFEST: /tmp/rankings-db-manifest.json');
    expect(packer).toContain('RANKINGS_MEMBER_PREFIX: data/');
    expect(packer).toContain('RANKINGS_EXPECT_RUN_ID: ${{ steps.promote-rankings-dbs.outputs.expect_run_id }}');
    expect(packer).toContain('RANKINGS_EXPECT_HEAD_SHA: ${{ steps.promote-rankings-dbs.outputs.expect_head_sha }}');
    expect(packer).toContain('RANKINGS_MAX_ATTEMPT: ${{ steps.promote-rankings-dbs.outputs.max_attempt }}');
    // NO SILENT DEGRADE: if those $GITHUB_OUTPUT values were ever lost, an EMPTY expectation
    // must THROW (IDENTITY_BINDING_REQUIRED_BUT_EMPTY), not downgrade D9a to structure-only.
    expect(packer).toContain("RANKINGS_REQUIRE_IDENTITY: '1'");
  });

  it('#15b CENSUS: every rankings verify invocation is identity-required (reds on an unflagged ADDITION)', () => {
    // The permissive "empty == no expectation" default may only survive for non-workflow
    // callers. This is DISCOVERY-based, not a fixed count: a NEW verify-dbs /
    // verify-publication invocation shows up automatically, so adding one WITHOUT the flag
    // reds here instead of silently degrading that path to structure-only.
    //
    // PINNED ENUMERATION. Adding a site requires NAMING it here -- the count alone cannot be
    // bumped, which is the whole point (a bare count is a rubber stamp).
    const EXPECTED_SITES = [
      'factory-aggregate.yml :: aggregate-rankings :: Establish Rankings-Satellite Authority (SEAM_A) :: verify-dbs "$STAGE_LOCAL/data"',
      'factory-aggregate.yml :: finalize :: Consume Rankings-Satellite Authority (SEAM_A, fail-closed) :: verify-dbs output/data',
      'factory-aggregate.yml :: finalize :: Establish Rankings-DB Authority (SEAM_B) :: verify-dbs "$STAGE_LOCAL/data"',
      'factory-upload.yml :: upload :: Rankings-DB Publication Gate (fail-closed, BEFORE any public write) :: verify-publication output/data output/data/shards_manifest.json',
      'factory-upload.yml :: vfs-pack-db :: Promote Rankings DBs from R2 Authority (SEAM_B, fail-closed) :: verify-dbs "$STAGE/data"',
      'factory-upload.yml :: vfs-pack-db :: Promote Rankings DBs from R2 Authority (SEAM_B, fail-closed) :: verify-dbs output/data',
    ].sort();

    const sites = rankingsVerifySites();
    // (a) the discovered set EXACTLY equals the enumeration -> an ADDITION or a REMOVAL reds
    expect(sites.map((s) => s.label)).toEqual(EXPECTED_SITES);

    // (b) EVERY discovered invocation is identity-required, resolved through its OWN
    // enclosing step (the flag may be inline on the command or exported once in the step).
    const stepTextFor = (wf: string, step: string) => {
      const yml = wf === 'factory-aggregate.yml' ? AGG : UPL;
      for (const job of ['aggregate-rankings', 'finalize', 'vfs-pack-db', 'upload']) {
        const block = stepBlock(jobBlock(yml, job), step);
        if (block) return block;
      }
      return '';
    };
    for (const s of sites) {
      const text = stepTextFor(s.wf, s.step);
      expect(text, `could not resolve the step for ${s.label}`).not.toBe('');
      expect(text, `NOT identity-required: ${s.label}`).toMatch(/RANKINGS_REQUIRE_IDENTITY[=:] ?'?1'?/);
    }

    // (c) pack-db.js reaches the SAME verifier via pack-finalizer, so its step is bound too
    expect(stepBlock(PACK_JOB, 'Execute Stable 1.0 Packer')).toMatch(/RANKINGS_REQUIRE_IDENTITY: '1'/);
  });
});

describe('RANKINGS-DB-FAILCLOSED-PREPUBLISH — the flag and the last barrier before the public write', () => {
  it('#16 pack-finalizer sets the flag ONLY as the result of a THROWING complete-set verification', () => {
    const code = jsCodeOf(FINALIZER);
    expect(code).toContain("import { assertRankingsDbSet, verifyOptsFromEnv } from './rankings-db-verifier.js';");
    expect(code).toContain('assertRankingsDbSet(shardDir, verifyOptsFromEnv());');
    expect(code).toContain('partitionCounts.rankings_dbs = true;');
    expect(code).not.toMatch(/\.some\(/);
    expect(code).not.toMatch(/rankings_dbs\s*=\s*false/);
    // the throw must precede the manifest write, so nothing publishable is produced first
    expect(code.indexOf('assertRankingsDbSet')).toBeLessThan(code.indexOf("shards_manifest.json'"));
  });

  it('#17 the upload job carries the MANDATORY gate strictly BETWEEN the family gate and the public write', () => {
    const iFamily = UPLOAD_JOB.indexOf('Publication-Family Closure Gate (BEFORE R2 publish)');
    const iGate = UPLOAD_JOB.indexOf(PUB_GATE);
    const iCapacity = UPLOAD_JOB.indexOf('Capacity Preflight — Final Upload');
    const iPublish = UPLOAD_JOB.indexOf(PUBLISH);
    for (const i of [iFamily, iGate, iCapacity, iPublish]) expect(i).toBeGreaterThan(0);
    expect(iGate).toBeGreaterThan(iFamily);
    expect(iCapacity).toBeGreaterThan(iGate);
    // THE load-bearing assertion: the gate precedes the SOLE public CDN write
    expect(iPublish).toBeGreaterThan(iGate);
    // exactly one public write site, so "before it" is unambiguous
    expect((UPLOAD_JOB.match(/run: node scripts\/factory\/r2-upload-s3\.js/g) || []).length).toBe(1);
  });

  it('#18 the gate re-derives the authority itself and asserts the manifest flag === true, else exit 1', () => {
    const step = stepBlock(UPLOAD_JOB, PUB_GATE);
    expect(step).not.toBe('');
    expect(step).toContain('DESC="state/_handoff/rankings-db/${UP}/handoff.json"');
    expect(step).toContain('restore-file "$DESC" /tmp/rankings-db-handoff-pub.json --strict');
    expect(step).toContain('verify-descriptor /tmp/rankings-db-handoff-pub.json --carrier=rankings-db');
    expect(step).toContain('restore-file "${STAGING_PREFIX}manifest.json" /tmp/rankings-db-manifest-pub.json --strict');
    expect(step).toContain('verify-publication output/data output/data/shards_manifest.json');
    expect(step).toContain('RANKINGS_DB_MANIFEST=/tmp/rankings-db-manifest-pub.json');
    expect(step).toContain('RANKINGS_EXPECT_RUN_ID="$UP"');
    expect(step).toContain('RANKINGS_REQUIRE_IDENTITY=1');
    // unified defensive parse: fields cut from the LAST stdout line only
    expect(step).toMatch(/DESC_LINE=\$\(printf '%s' "\$OUT" \| tail -n1\)/);
    for (const line of codeOf(step).split('\n')) {
      if (/cut -f/.test(line)) expect(line, `must cut DESC_LINE: ${line.trim()}`).toContain('DESC_LINE');
    }
    // fail-closed only: no softened command, no continue-on-error, every branch exits 1
    expect(codeOf(step)).not.toMatch(/\|\| true/);
    expect(step).not.toContain('continue-on-error');
    expect(codeOf(step)).not.toContain('cache-hit');
    expect((step.match(/exit 1/g) || []).length).toBeGreaterThanOrEqual(4);
    // the gate is REQUIRED because skip_compute bypasses pack-db.js entirely
    expect(PACK_JOB).toContain("if: steps.detect-vfs-pack.outputs.skip_compute != 'true'");
  });

  it('#19 the published flag contract: absent key and `false` are both refused by the verifier module', () => {
    expect(CARRIER).toContain("return fail('RANKINGS_FLAG_ABSENT'");
    expect(CARRIER).toContain("return fail('RANKINGS_FLAG_NOT_TRUE'");
    expect(CARRIER).toMatch(/parts\.rankings_dbs !== true/);
    expect(CARRIER).toMatch(/hasOwnProperty\.call\(parts, 'rankings_dbs'\)/);
  });

  it('#20 the select.ts 503 protection is UNTOUCHED (the fix restores the data, it never weakens the guard)', () => {
    expect(SELECT).toContain('if (!manifest?.partitions?.rankings_dbs) {');
    expect(SELECT).toContain("return error(503, 'Rankings data not yet available. Retry after next pipeline run.');");
  });
});
