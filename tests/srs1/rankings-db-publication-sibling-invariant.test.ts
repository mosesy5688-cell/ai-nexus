// tests/srs1/rankings-db-publication-sibling-invariant.test.ts
//
// SRS-1 Tier-1 STATIC lock for the Founder D-395 amend: the ADDITIVE
// `shards_manifest.json` publication SIBLING of the D-245 attempt-scoped vfs-pack
// authority, plus the pack-cache version bump that makes the first post-merge run a
// necessarily FRESH pack.
//
// FAILURE CHAIN THIS CLOSES (Founder-confirmed on the pre-amend head):
//   VFS_PACK_CODE_VERSION unchanged -> an OLD pack cache can hit -> pack-db.js is SKIPPED
//   -> pack-finalizer.js (the ONLY writer of partitions.rankings_dbs=true AND of
//   shards_manifest.json) never runs -> FIX-4 recovery does `rm -rf output/data/` and
//   restores ONLY .db / warm .bin / term_index, never shards_manifest.json -> the D9b gate
//   requires that file -> publication is refused on the skip-compute and FIX-4 paths.
// The fix is (i) bump the cache version and (ii) carry the manifest as a verified sibling.
// D9b itself is UNCHANGED: `partitions.rankings_dbs` is still required boolean `true`.
import { describe, it, expect } from 'vitest';
import { AGG, UPL, CARRIER, PACK_JOB, UPLOAD_JOB, jobBlock, stepBlock, codeOf, read } from './rankings-db-wf-fixtures';

const VD_JOB = jobBlock(UPL, 'vfs-derived');
const SIBLING_STEP = 'Verify or Recover Published shards_manifest.json from VFS Pack Authority (D-395)';
const FIX4_STEP = 'Verify or Recover Published meta-NN.db from VFS Pack Authority (FIX-4 / D-252)';
const PRODUCER_STEP = 'Produce Exact-Producer R2 Handoff (VFS-PACK, D-245)';
const PUB_GATE = 'Rankings-DB Publication Gate (fail-closed, BEFORE any public write)';
const PUBLISH = 'run: node scripts/factory/r2-upload-s3.js';

describe('D-395 (1) pack-cache version bump — an OLD cache can never bypass the new pack semantics', () => {
  it('#S1 VFS_PACK_CODE_VERSION is the NEW frozen token (reverting it reds this)', () => {
    const m = UPL.match(/VFS_PACK_CODE_VERSION:\s*'([^']+)'/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('rankings-manifest-authority-v1');
    // the retired token must appear nowhere: an old cache key can never be reconstructed
    expect(UPL).not.toContain('citation-authority-v2');
  });

  it('#S2 the new token scopes EVERY intra-4-4-vfs-pack cache key AND restore-prefix', () => {
    const lines = UPL.split('\n').map((l) => l.trim()).filter((l) => l.includes('intra-4-4-vfs-pack-') && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(l).toContain('intra-4-4-vfs-pack-${{ env.VFS_PACK_CODE_VERSION }}-');
    // no bare cross-version prefix may exist as a fallback
    for (const l of lines) expect(l).not.toMatch(/intra-4-4-vfs-pack-\s*$/);
  });

  it('#S3 skip-compute STILL requires the sentinel to equal the (now new) version', () => {
    const detect = stepBlock(PACK_JOB, 'Detect vfs-pack output present');
    expect(detect).toContain('"$SENTINEL_VAL" = "$VFS_PACK_CODE_VERSION"');
    // a fresh pack stamps the sentinel, so an old-cache tree can never satisfy it
    expect(UPL).toMatch(/printf '%s' "\$VFS_PACK_CODE_VERSION" > output\/meta\/vfs-pack-code-version\.txt/);
  });
});

describe('D-395 (2) producer — the sibling is established BEFORE the descriptor commit', () => {
  it('#S4 the sibling is staged at the exact attempt prefix and NOT mixed into the .db set hash', () => {
    const step = stepBlock(PACK_JOB, PRODUCER_STEP);
    expect(step).not.toBe('');
    expect(step).toContain('shards-manifest-emit output/data/shards_manifest.json');
    expect(step).toContain('upload-file output/data/shards_manifest.json "${STAGING}publication/shards_manifest.json"');
    // the existing meta manifest generate call is UNCHANGED (--ext=.db, no new member)
    expect(step).toContain('generate output/data/ /tmp/vfs-pack-manifest.json --carrier=vfs-pack-authority --ext=.db --rss-base=.');
    // and shards_manifest.json is NOT handed to the .db manifest generator
    expect(step).not.toMatch(/generate[^\n]*shards_manifest/);
  });

  it('#S5 descriptor carries BOTH additive fields, and the ORDER is validate -> data -> descriptor -> read-back -> announce', () => {
    const step = stepBlock(PACK_JOB, PRODUCER_STEP);
    expect(step).toContain('shards_manifest_sha256:String(process.env.SM_SHA)');
    expect(step).toContain('shards_manifest_size:Number(process.env.SM_SIZE)');
    const iEmit = step.indexOf('shards-manifest-emit');
    const iData = step.indexOf('upload-file output/data/shards_manifest.json "${STAGING}publication/');
    const iDesc = step.indexOf('upload-file /tmp/vfs-pack-handoff.json "${RUN_PREFIX}/handoff.json"');
    const iFields = step.indexOf('shards-manifest-fields /tmp/vfs-pack-handoff-rb.json');
    const iRb = step.indexOf('restore-file "${STAGING}publication/shards_manifest.json"');
    const iReverify = step.indexOf('shards-manifest-verify /tmp/vfs-pack-shards-manifest-rb.json');
    const iAnnounce = step.indexOf('[VFS-PACK-HANDOFF] staging=');
    for (const i of [iEmit, iData, iDesc, iFields, iRb, iReverify, iAnnounce]) expect(i).toBeGreaterThan(0);
    expect(iData).toBeGreaterThan(iEmit);      // semantics validated BEFORE any upload
    expect(iDesc).toBeGreaterThan(iData);      // data FIRST, descriptor LAST
    expect(iFields).toBeGreaterThan(iDesc);    // descriptor read-back carries the fields
    expect(iRb).toBeGreaterThan(iDesc);        // sibling object read back after commit
    expect(iReverify).toBeGreaterThan(iRb);    // re-verified hash/size/semantics
    expect(iAnnounce).toBeGreaterThan(iReverify); // announced ONLY after all of it
    // every producer branch fails closed
    expect(codeOf(step)).not.toMatch(/shards-manifest[^\n]*\|\| true/);
  });

  it('#S6 the verified sibling identity is exported for BOTH consumers', () => {
    expect(PACK_JOB).toContain('verified_vfs_pack_shards_manifest_sha: ${{ steps.vfs-pack-handoff.outputs.shards_manifest_sha }}');
    expect(PACK_JOB).toContain('verified_vfs_pack_shards_manifest_size: ${{ steps.vfs-pack-handoff.outputs.shards_manifest_size }}');
    const step = stepBlock(PACK_JOB, PRODUCER_STEP);
    expect(step).toContain('echo "shards_manifest_sha=${RB_SM_SHA}" >> "$GITHUB_OUTPUT"');
    expect(step).toContain('echo "shards_manifest_size=${RB_SM_SIZE}" >> "$GITHUB_OUTPUT"');
  });

  it('#S6b the enforced identity is SOURCED from the durable descriptor read-back (canonical-form + name-census locks, value guaranteed by the divergence gate)', () => {
    // Founder finding on the first amend: presence+syntax made the binding DECORATIVE. A
    // different-but-well-formed SHA and a different-but-positive size passed every check because
    // the sibling was verified against the PRODUCER-LOCAL values and those locals were exported.
    // Required flow: local file -> descriptor -> DURABLE read-back -> parsed descriptor identity
    // -> durable sibling verification -> job outputs -> both FIX-4 consumers.
    const step = stepBlock(PACK_JOB, PRODUCER_STEP);
    const code = codeOf(step);
    // (a) the identity is PARSED OUT of the read-back descriptor file...
    expect(code).toContain('RB_FIELDS=$(node scripts/factory/rankings-db-handoff-manifest.mjs shards-manifest-fields /tmp/vfs-pack-handoff-rb.json');
    expect(code).toMatch(/RB_SM_SHA=\$\(printf '%s' "\$RB_FIELDS_LINE" \| cut -f1\)/);
    expect(code).toMatch(/RB_SM_SIZE=\$\(printf '%s' "\$RB_FIELDS_LINE" \| cut -f2\)/);
    // (b) ...and must AGREE exactly with the locally computed values (divergence => fail-closed)
    expect(code).toContain('--expect-sha="${SM_SHA}" --expect-size="${SM_SIZE}"');
    // an EMPTY parsed value is a HARD error, never "no expectation"
    expect(code).toMatch(/if \[ -z "\$\{RB_SM_SHA\}" \] \|\| \[ -z "\$\{RB_SM_SIZE\}" \]; then[^\n]*exit 1/);
    // ...and so is an empty LOCAL identity: the module's no-expectation branch is
    // legacy-permissive for off-workflow callers, so an empty --expect-* would SILENTLY SKIP the
    // divergence check. The pipeline closes that at the CALL SITE, before the descriptor is even
    // written, so the binding is unconditional here regardless of the module's default.
    expect(code).toMatch(/if \[ -z "\$\{SM_SHA\}" \] \|\| \[ -z "\$\{SM_SIZE\}" \]; then[^\n]*exit 1/);
    const iLocalGuard = code.indexOf('-z "${SM_SHA}"');
    expect(iLocalGuard).toBeGreaterThan(0);
    expect(code.indexOf('shards_manifest_sha256:String(process.env.SM_SHA)'),
      'the local non-empty guard must precede the descriptor write').toBeGreaterThan(iLocalGuard);
    expect(code.indexOf('--expect-sha="${SM_SHA}"'),
      'the local non-empty guard must precede the expectation it feeds').toBeGreaterThan(iLocalGuard);
    // (c) the durable sibling is verified with the READ-BACK values, NOT the locals
    expect(code).toContain('shards-manifest-verify /tmp/vfs-pack-shards-manifest-rb.json --sha="${RB_SM_SHA}" --size="${RB_SM_SIZE}"');
    expect(code).not.toContain('shards-manifest-verify /tmp/vfs-pack-shards-manifest-rb.json --sha="${SM_SHA}"');
    // (d) SOURCE-pinned outputs: the producer-local variables must NOT be exported at all
    expect(code).not.toMatch(/shards_manifest_sha=\$\{SM_SHA\}/);
    expect(code).not.toMatch(/shards_manifest_size=\$\{SM_SIZE\}/);

    // CANONICAL-FORM LOCK + NAME CENSUS. This is NOT a general dataflow proof -- it is a
    // syntactic pin on the ONE place these two variables may be set, plus a census of every
    // other mention of their names. The VALUE guarantee still rests on the divergence gate
    // above (which proves RB_* == SM_* before anything downstream runs); these locks exist so
    // the enforced value cannot be re-bound to the producer-local without a visible edit.
    //
    // The two earlier locks constrained TEXT and were bypassable six ways (reviewer): the
    // blacklist's `[^$\n]*` cannot cross a `$`, so any interposed `$(...)`, `${!...}` or
    // intermediate variable defeated it, and BOTH locks keyed on `=`, so `read -r RB_SM_SHA`
    // and `printf -v RB_SM_SHA` were invisible to them. Replaced by:
    //   (i) the single assignment line must EQUAL its canonical form verbatim -- so any
    //       "append another rebind to this line" spelling fails without being enumerated;
    //   (ii) the names may appear on NO other executable line than the allow-listed READ
    //       sites -- so any `=`-less mechanism (read/printf -v/declare/eval/indirect) fails
    //       simply by mentioning the name somewhere unsanctioned.
    // NOTE FOR FUTURE EDITORS: reformatting either the assignment line or a read site is a
    // DELIBERATE update of the constants below, not a test bug.
    const CANONICAL_RB_ASSIGN = 'RB_SM_SHA=$(printf \'%s\' "$RB_FIELDS_LINE" | cut -f1); RB_SM_SIZE=$(printf \'%s\' "$RB_FIELDS_LINE" | cut -f2)';
    const SANCTIONED_RB_READS = [
      // the empty-value hard guard
      'if [ -z "${RB_SM_SHA}" ] || [ -z "${RB_SM_SIZE}" ]; then echo "::error::RANKINGS-PUBLICATION-SIBLING: empty shards_manifest identity parsed from the read-back descriptor. Fail-closed."; exit 1; fi',
      // the durable sibling verification
      'node scripts/factory/rankings-db-handoff-manifest.mjs shards-manifest-verify /tmp/vfs-pack-shards-manifest-rb.json --sha="${RB_SM_SHA}" --size="${RB_SM_SIZE}" || { echo "::error::RANKINGS-PUBLICATION-SIBLING: publication sibling read-back failed hash/size/semantic verification. Fail-closed."; exit 1; }',
      // the two job outputs consumed by both FIX-4 consumers
      'echo "shards_manifest_sha=${RB_SM_SHA}" >> "$GITHUB_OUTPUT"',
      'echo "shards_manifest_size=${RB_SM_SIZE}" >> "$GITHUB_OUTPUT"',
      // the announce line
      'echo "[VFS-PACK-HANDOFF] staging=${V_PREFIX} set_sha256=${V_SET} warm_read_set_sha256=${WARM_SET_SHA} shards_manifest_sha256=${RB_SM_SHA} shards_manifest_size=${RB_SM_SIZE} descriptor=${RUN_PREFIX}/handoff.json"',
    ];
    const rbLines = code.split('\n').map((l) => l.trim()).filter((l) => /RB_SM_(SHA|SIZE)/.test(l));
    const allowed = new Set([CANONICAL_RB_ASSIGN, ...SANCTIONED_RB_READS]);
    const unsanctioned = rbLines.filter((l) => !allowed.has(l));
    expect(unsanctioned,
      `RB_SM_SHA/RB_SM_SIZE may appear ONLY on the canonical assignment or an allow-listed read site. Unsanctioned: ${unsanctioned.join(' || ')}`)
      .toEqual([]);
    expect(rbLines.filter((l) => l === CANONICAL_RB_ASSIGN),
      'the canonical assignment line must appear EXACTLY once, verbatim').toHaveLength(1);
    for (const readLine of SANCTIONED_RB_READS) {
      expect(rbLines, `sanctioned read site missing/reformatted: ${readLine.slice(0, 60)}`).toContain(readLine);
    }
    // ORDER: agreement gate -> sibling verify -> export (a later gate cannot launder an earlier lie)
    const iGate = code.indexOf('--expect-sha="${SM_SHA}"');
    const iEmptyGuard = code.indexOf('-z "${RB_SM_SHA}"');
    const iSibling = code.indexOf('--sha="${RB_SM_SHA}"');
    const iExport = code.indexOf('shards_manifest_sha=${RB_SM_SHA}');
    for (const i of [iGate, iEmptyGuard, iSibling, iExport]) expect(i).toBeGreaterThan(0);
    expect(iEmptyGuard).toBeGreaterThan(iGate);
    expect(iSibling).toBeGreaterThan(iEmptyGuard);
    expect(iExport).toBeGreaterThan(iSibling);
    // the local values keep exactly ONE legitimate role: seeding the descriptor + the expectation
    expect(code).toContain('shards_manifest_sha256:String(process.env.SM_SHA)');
    // and the module must actually implement divergence as its own failure class
    expect(CARRIER).toContain("fail('DESC_SHARDS_MANIFEST_SHA_DIVERGED'");
    expect(CARRIER).toContain("fail('DESC_SHARDS_MANIFEST_SIZE_DIVERGED'");
  });
});

describe('D-395 (3) consumers — verify-or-recover in BOTH FIX-4 paths, before any public write', () => {
  it('#S7 BOTH vfs-derived and upload carry the sibling verify-or-recover step', () => {
    // EXACT step-name lock (not a substring match): `stepBlock` keys off the literal
    // `- name: <SIBLING_STEP>`, so a RENAME or a REMOVAL in EITHER job reds this. The count
    // assertion additionally catches a rename in only ONE of the two jobs.
    expect(UPL.split(`- name: ${SIBLING_STEP}`).length - 1,
      'exactly two steps (one per FIX-4 consumer job) must carry this exact name').toBe(2);
    for (const [name, job] of [['vfs-derived', VD_JOB], ['upload', UPLOAD_JOB]] as const) {
      const step = stepBlock(job, SIBLING_STEP);
      expect(step, `${name} must carry the sibling consumer`).not.toBe('');
      expect(step).toContain('EXPECT_SM_SHA: ${{ needs.vfs-pack-db.outputs.verified_vfs_pack_shards_manifest_sha }}');
      expect(step).toContain('EXPECT_SM_SIZE: ${{ needs.vfs-pack-db.outputs.verified_vfs_pack_shards_manifest_size }}');
      // verify -> (on ANY failure) recover from the EXACT attempt prefix -> RE-VERIFY
      expect(step).toContain('shards-manifest-verify output/data/shards_manifest.json --sha="${EXPECT_SM_SHA}" --size="${EXPECT_SM_SIZE}"');
      expect(step).toContain('restore-file "${STAGING_PREFIX}publication/shards_manifest.json" output/data/shards_manifest.json --strict');
      const iRestore = step.indexOf('restore-file "${STAGING_PREFIX}publication/');
      const iReverify = step.lastIndexOf('verify_sm ||');
      expect(iReverify).toBeGreaterThan(iRestore);
      // fail-closed: no softened command, no fabrication/patching of the manifest
      expect(codeOf(step)).not.toMatch(/\|\| true/);
      expect(step).not.toContain('continue-on-error');
      expect(step).not.toMatch(/rankings_dbs['"]?\s*[:=]\s*true/);
      expect(step).not.toMatch(/jq[^\n]*rankings_dbs/);
      expect((step.match(/exit 1/g) || []).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('#S8 in upload the recovery runs AFTER FIX-4 erases output/data/ and BEFORE the public write', () => {
    const iFix4 = UPLOAD_JOB.indexOf(FIX4_STEP);
    const iSibling = UPLOAD_JOB.indexOf(SIBLING_STEP);
    const iGate = UPLOAD_JOB.indexOf(PUB_GATE);
    const iPublish = UPLOAD_JOB.indexOf(PUBLISH);
    for (const i of [iFix4, iSibling, iGate, iPublish]) expect(i).toBeGreaterThan(0);
    // FIX-4 is the step that wipes output/data/, so recovery MUST follow it
    expect(stepBlock(UPLOAD_JOB, FIX4_STEP)).toContain('rm -rf output/data/');
    expect(iSibling).toBeGreaterThan(iFix4);
    // ...and must precede BOTH the gate that reads the file and the sole public CDN write
    expect(iGate).toBeGreaterThan(iSibling);
    expect(iPublish).toBeGreaterThan(iSibling);
  });

  it('#S9 D9b is UNCHANGED: still requires boolean true, still before the publish', () => {
    const gate = stepBlock(UPLOAD_JOB, PUB_GATE);
    expect(gate).toContain('verify-publication output/data output/data/shards_manifest.json');
    expect(gate).toContain('RANKINGS_REQUIRE_IDENTITY=1');
    expect((gate.match(/exit 1/g) || []).length).toBeGreaterThanOrEqual(4);
    // the required-boolean-true semantics live in the module and are NOT relaxed
    expect(CARRIER).toMatch(/parts\.rankings_dbs !== true/);
    expect(CARRIER).toContain("fail('RANKINGS_FLAG_ABSENT'");
    expect(CARRIER).toContain("fail('RANKINGS_FLAG_NOT_TRUE'");
    expect(UPLOAD_JOB.indexOf(PUBLISH)).toBeGreaterThan(UPLOAD_JOB.indexOf(PUB_GATE));
  });

  it('#S10 the D-245 carrier module was NOT modified for this sibling (additive-by-composition)', () => {
    const d245 = read('scripts/factory/vfs-derived-handoff-manifest.mjs');
    expect(d245).not.toContain('shards_manifest');
    expect(d245).not.toContain('publication/');
    // the sibling logic lives in the rankings carrier instead
    expect(CARRIER).toMatch(/export function inspectShardsManifest/);
    expect(CARRIER).toMatch(/export function verifyShardsManifestSibling/);
    expect(CARRIER).toMatch(/export function verifyShardsManifestDescriptorFields/);
  });
});
