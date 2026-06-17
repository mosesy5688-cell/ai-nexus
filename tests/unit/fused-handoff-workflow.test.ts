// tests/unit/fused-handoff-workflow.test.ts
// MASTER-FUSION-HANDOFF PR-A (S1-BR EXACT-PRODUCER R2 HANDOFF) — STATIC workflow
// invariants. Reads .github/workflows/factory-upload.yml as TEXT (CRLF-normalized;
// no workflow execution, no network, no YAML execution) and locks the exact-producer
// R2 handoff DAG: Compute produces a durable run+producer-attempt staging set +
// descriptor-LAST; Persist reads the descriptor, verifies provenance, uses GHA only
// as an OPTIONAL fast path (no restore-keys), and recovers from the EXACT staging on
// miss/mismatch BEFORE the compatibility publish; VFS + Upload verify the restored
// fused set EQUALS Persist's VERIFIED identity and recover from the SAME exact staging,
// never from the fixed state/fused-entities/ prefix; staging lifecycle cleanup + GC.
// ROOT CAUSE: the GHA cache carrying output/cache/fused/ was unretrievable at Persist
// restore time, so the empty-state guard fail-closed. Durable R2 handoff is the fix.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const WF = path.resolve(__dirname, '../../.github/workflows/factory-upload.yml');
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

// Slice the text of a single named job (up to the next top-level `  <job>:`).
function jobBlock(name: string): string {
    const start = yml.indexOf(`\n  ${name}:`);
    if (start < 0) return '';
    const rest = yml.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next);
}
const computeJob = jobBlock('master-fusion-compute');
const persistJob = jobBlock('master-fusion-persist');
const vfsJob = jobBlock('vfs-pack-db');
const uploadJob = jobBlock('upload');

const STAGING_LITERAL = 'state/_handoff/fused/${UP}/${RUN}';

describe('S1-BR Compute — durable producer handoff', () => {
    it('#1 generates a manifest, uploads the carrier set, manifest LAST, descriptor LAST-of-all', () => {
        expect(computeJob).toContain('fused-handoff-manifest.js generate output/cache/fused/ output/cache/fused/manifest.json');
        // attempt-scoped staging prefix derived from PRODUCER run_attempt
        expect(computeJob).toContain('RUN_PREFIX="state/_handoff/fused/${UP}/${RUN}"');
        expect(computeJob).toContain('STAGING="${RUN_PREFIX}/attempt-${ATT}/"');
        expect(computeJob).toContain('HANDOFF_PRODUCER_ATTEMPT: ${{ github.run_attempt }}');
        // data first (extensions filter excludes manifest.json), manifest second, descriptor third
        const dataIdx = computeJob.indexOf('backup-dir output/cache/fused/ "${STAGING}" --extensions=.json.zst,.complete');
        const manIdx = computeJob.indexOf('upload-file output/cache/fused/manifest.json "${STAGING}manifest.json"');
        const descIdx = computeJob.indexOf('upload-file output/cache/fused/handoff.json "${RUN_PREFIX}/handoff.json"');
        expect(dataIdx).toBeGreaterThan(0);
        expect(manIdx).toBeGreaterThan(dataIdx);
        expect(descIdx).toBeGreaterThan(manIdx);
    });

    it('#2 descriptor is written LAST (after the data + manifest uploads in the same step)', () => {
        // The handoff.json file is written + uploaded strictly after backup-dir + manifest
        // upload in the produce step; if either earlier upload fails (set -e), the descriptor
        // line is never reached -> descriptor absent. Lock the set -e + ordering.
        expect(computeJob).toContain('set -euo pipefail');
        const writeIdx = computeJob.indexOf("writeFileSync('output/cache/fused/handoff.json'");
        const manIdx = computeJob.indexOf('upload-file output/cache/fused/manifest.json');
        expect(writeIdx).toBeGreaterThan(manIdx);
        // descriptor carries the exact required field set
        for (const f of ['producer_attempt', 'exact_staging_prefix', 'manifest_sha256', 'set_sha256', 'upstream_run_id', 'factory_run_id', 'head_sha', 'created_at']) {
            expect(computeJob).toContain(`${f}:`);
        }
    });

    it('the handoff staging prefix is run + PRODUCER-attempt scoped (no list/latest token)', () => {
        expect(computeJob).toContain(`${STAGING_LITERAL}`);
        expect(computeJob).not.toMatch(/attempt-(latest|LATEST)/);
    });
});

describe('S1-BR Persist — descriptor authority, GHA optional fast path', () => {
    it('reads + verifies the run-scoped descriptor BEFORE trusting any cache', () => {
        expect(persistJob).toContain('state/_handoff/fused/${UP}/${RUN}/handoff.json');
        expect(persistJob).toContain('fused-handoff-manifest.js verify-descriptor /tmp/handoff.json');
        // provenance env: current upstream + current run + current run_attempt
        expect(persistJob).toContain('HANDOFF_RUN_ATTEMPT: ${{ github.run_attempt }}');
        // descriptor unretrievable => fail-loud (no empty-state publish)
        expect(persistJob).toContain('Handoff descriptor');
        expect(persistJob).toMatch(/exit 1/);
    });

    it('#25 GHA fast path uses EXACT key only — NO restore-keys fused prefix anywhere', () => {
        // A fused restore-keys prefix is the dangling `intra-4-4-fused-<upstream>-` form
        // (a line that is the bare prefix WITHOUT a trailing run_id). Assert none remain.
        const lines = yml.split('\n').map((l) => l.trim());
        const barePrefix = 'intra-4-4-fused-${{ needs.check-upstream.outputs.upstream-run-id }}-';
        const dangling = lines.filter((l) => l === barePrefix);
        expect(dangling.length).toBe(0);
        // and no `restore-keys:` immediately introducing a fused prefix block
        expect(yml).not.toMatch(/restore-keys:\s*\|\s*\n\s*intra-4-4-fused-/);
    });

    it('#16 GHA hit but manifest mismatch => discard + recover from EXACT staging', () => {
        expect(persistJob).toContain('Verify or Recover Fused from Exact Staging');
        expect(persistJob).toContain('restore-dir "$STAGING_PREFIX" output/cache/fused/ --strict');
        expect(persistJob).toContain('rm -rf output/cache/fused/');
        // recovered set hash must equal the descriptor set hash, else fail-loud
        expect(persistJob).toContain('EXPECT_SET_SHA');
        expect(persistJob).toMatch(/!= descriptor \$EXPECT_SET_SHA[\s\S]*exit 1/);
    });

    it('#15 + #21 GHA miss recovers exact staging; recovery verification failure is fail-loud', () => {
        expect(persistJob).toContain('recover from exact staging');
        expect(persistJob).toMatch(/recovery failed verification[\s\S]*exit 1/);
    });

    it('#17 the fixed compatibility copy is written ONLY after VERIFIED (never before)', () => {
        const verifyIdx = persistJob.indexOf('VERIFIED_FUSED_HANDOFF=1');
        const publishIdx = persistJob.indexOf('backup-dir output/cache/fused/ state/fused-entities/');
        expect(verifyIdx).toBeGreaterThan(0);
        expect(publishIdx).toBeGreaterThan(verifyIdx);
        // it is a COMPATIBILITY PUBLICATION COPY, not an atomic promotion / recovery input
        expect(persistJob).toContain('COMPATIBILITY PUBLICATION COPY');
        expect(persistJob).toContain('not an atomic promotion');
    });

    it('Persist exposes the verified identity as job outputs for downstream consumers', () => {
        for (const out of ['verified_fused_manifest_sha', 'verified_fused_set_sha', 'verified_fused_staging_prefix', 'verified_fused_producer_attempt']) {
            expect(persistJob).toContain(`${out}:`);
        }
    });
});

describe('S1-BR consumers (VFS + Upload) — identity equals Persist, no fixed fallback', () => {
    for (const [label, job] of [['VFS', vfsJob], ['Upload', uploadJob]] as const) {
        it(`#18/#19 ${label} accepts only the set hash == Persist verified output`, () => {
            expect(job).toContain('needs.master-fusion-persist.outputs.verified_fused_set_sha');
            expect(job).toContain('needs.master-fusion-persist.outputs.verified_fused_staging_prefix');
            expect(job).toContain('EXPECT_SET_SHA');
        });

        it(`#20 ${label} cache mismatch recovers EXACT staging and never reads the fixed prefix`, () => {
            expect(job).toContain('restore-dir "$STAGING_PREFIX" output/cache/fused/ --strict');
            // The consumer fused path must NOT restore from the fixed state/fused-entities/ copy.
            expect(job).not.toContain('restore-dir state/fused-entities/ output/cache/fused/');
        });
    }

    it('#27 NEGATIVE: reverting a consumer to the fixed state/fused-entities/ fused fallback fails this gate', () => {
        // If any consumer (vfs/upload) restored fused from the fixed compatibility copy
        // into output/cache/fused/, that exact string would re-appear and trip this assert.
        expect(vfsJob).not.toContain('restore-dir state/fused-entities/ output/cache/fused/');
        expect(uploadJob).not.toContain('restore-dir state/fused-entities/ output/cache/fused/');
    });

    it('#28 NEGATIVE: changing exact staging to a prefix/latest lookup fails this gate', () => {
        // The consumers + persist derive the staging prefix from the verified descriptor;
        // no list-latest / no `attempt-*` glob / no prefix-walk for the fused carrier.
        for (const job of [persistJob, vfsJob, uploadJob]) {
            expect(job).not.toMatch(/list-prefix[^\n]*attempt-/);
            expect(job).not.toMatch(/attempt-\*/);
        }
    });
});

describe('S1-BR staging lifecycle (cleanup + bounded GC)', () => {
    it('#22 Final Upload success => delete the CURRENT run staging prefix + descriptor', () => {
        expect(uploadJob).toContain('Cleanup + GC Fused Handoff Staging');
        const step = uploadJob.slice(uploadJob.indexOf('Cleanup + GC Fused Handoff Staging'));
        expect(step).toContain("if: success()");
        expect(step).toContain('CUR_RUN_PREFIX="state/_handoff/fused/${UP}/${RUN}/"');
        expect(step).toContain('delete-prefix "${CUR_RUN_PREFIX}"');
    });

    it('#23 downstream failure retains staging (cleanup gated on success only)', () => {
        // The cleanup step is success()-gated, so a failed cycle never cleans up ->
        // the exact staging is RETAINED for the evidence-based failed-job recovery.
        const nameIdx = uploadJob.indexOf('name: Cleanup + GC Fused Handoff Staging');
        const step = uploadJob.slice(nameIdx, nameIdx + 600);
        expect(step).toContain("if: success()");
        // The retention rationale is documented in the step's preceding comment block.
        expect(uploadJob).toContain('is RETAINED for the');
    });

    it('#24 GC is age-bounded and refuses the current run / non-_handoff carriers', () => {
        const step = uploadJob.slice(uploadJob.indexOf('Cleanup + GC Fused Handoff Staging'));
        expect(step).toContain("RETENTION_DAYS: '7'");
        // never the current run
        expect(step).toContain('[ "$rid" = "$GC_CUR_RUN" ] && continue');
        // GC only walks under state/_handoff/fused/ (delete-prefix itself also refuses outside)
        expect(step).toContain('list-prefix state/_handoff/fused/');
        // age comparison gates the delete (created < keep_after)
        expect(step).toContain('"$created" -lt "$keep_after"');
    });
});

describe('S1-BR SCOPE GUARD — forbidden surfaces unchanged (#26)', () => {
    it('master-fusion.js algorithm + the .complete/>=400 gates are untouched', () => {
        // The producer algorithm + sentinel + shard-count gate prose are unchanged.
        expect(yml).toContain('Verify Master Fusion Sentinel');
        expect(yml).toContain('Verify Master Fusion Shard Count');
        expect(yml).toContain('THRESHOLD=400');
        // master-fusion.js is invoked, never re-pathed
        expect(yml).toContain('node scripts/factory/master-fusion.js');
    });

    it('no job timeout value was changed by this PR (the known set is intact)', () => {
        // master-fusion-persist 30, vfs-pack-db 330, upload 330, vfs-derived 30 etc.
        expect(persistJob).toContain('timeout-minutes: 30');
        expect(vfsJob).toContain('timeout-minutes: 330');
        expect(uploadJob).toContain('timeout-minutes: 330');
    });

    it('floor / health-threshold / adapter / production-asset-uploader steps remain', () => {
        // The production asset uploader + CDN warm path are not touched.
        expect(uploadJob).toContain('node scripts/factory/r2-upload-s3.js');
        expect(uploadJob).toContain('Purge & Warm CDN');
    });

    it('delete-prefix is restricted to the handoff staging tree (safety lock in CLI)', () => {
        const cli = fs.readFileSync(path.resolve(__dirname, '../../scripts/factory/r2-workflow-cli.js'), 'utf8');
        expect(cli).toContain("const HANDOFF_STAGING_ROOT = 'state/_handoff/'");
        expect(cli).toContain('assertHandoffStagingPrefix');
        // refusal references the staging root + a fatal exit
        expect(cli).toMatch(/not under '\$\{HANDOFF_STAGING_ROOT\}'[\s\S]*process\.exit\(1\)/);
    });
});
