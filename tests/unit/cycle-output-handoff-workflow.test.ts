// tests/unit/cycle-output-handoff-workflow.test.ts
// FIX-2 / GAP-2 / C12 (D-2026-0704-264): Factory 3/4 finalize -> 4/4 consumers
// CYCLE-OUTPUT attempt-scoped R2 authority STATIC workflow invariants. Reads
// .github/workflows/factory-aggregate.yml (PRODUCER finalize) + factory-upload.yml
// (the FOUR consumers mesh-baking / master-fusion-compute / vfs-pack-db / upload) as
// TEXT (CRLF-normalized; no execution, no network, no YAML eval) and locks the durable,
// attempt-scoped, manifest-last DAG: finalize establishes a finalize-run + attempt
// staging over the EXACT cycle-output set (output/cache/**; data -> manifest LAST ->
// descriptor LAST-of-all -> read-back); every consumer consumes ONLY that authority, uses
// the GHA exact key as verified acceleration (NO restore-keys), recovers from the EXACT
// staging on miss/mismatch, wipes ONLY output/cache/** (NEVER output/data/), and FAILS
// CLOSED on missing authority / residual mismatch. ROOT CAUSE: the 3/4->4/4 cycle-output
// handoff was a mutable fixed-prefix R2 copy (state/cycle-output/) + a prefix GHA
// restore-key consumed UNVERIFIED -- a stale/foreign/predecessor-cycle overwrite could
// suppress the true current-cycle output.
//
// ANTI-VACUITY MAP (removing/weakening a guard reds >=1 named test below):
//   * producer read-back gates emit  -> (P-READBACK) delete the read-back verify/emit order => red.
//   * data->manifest->descriptor last-> (P-ORDER) reorder the three uploads => red.
//   * relocation (no fixed prefix)   -> (P-RELOCATE) re-add backup-dir output/ state/cycle-output/ => red.
//   * consumer verify-before-accept  -> (C-VERIFY) drop the set_sha equality on the GHA fast path => red.
//   * consumer recover-from-staging  -> (C-RECOVER) drop the recover restore-dir "${STAGING_PREFIX}cache/" => red.
//   * wipe excludes output/data/     -> (C-WIPE) change wipe to rm -rf output/data => red.
//   * fixed-prefix removed (all 4)   -> (C-NOFIXED) re-add restore-dir state/cycle-output/ output/ => red.
//   * restore-keys prefix removed    -> (C-NOLOOSE) re-add restore-keys: cycle-<id>- => red.
//   * fail-closed branches           -> (C-FAILCLOSED) drop any exit 1 branch => red.
//   * SAME set_sha across 4 consumers-> (C-SAMESHA) diverge one consumer's descriptor path => red.
//   * forbidden regions untouched    -> (SCOPE) touch FIX-4 meta-db / registry / shards / check-upstream => red.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const AGG = path.resolve(__dirname, '../../.github/workflows/factory-aggregate.yml');
const UP = path.resolve(__dirname, '../../.github/workflows/factory-upload.yml');
const aggYml = fs.readFileSync(AGG, 'utf8').replace(/\r\n/g, '\n');
const upYml = fs.readFileSync(UP, 'utf8').replace(/\r\n/g, '\n');

function jobBlock(yml: string, name: string): string {
    const start = yml.indexOf(`\n  ${name}:`);
    if (start < 0) return '';
    const rest = yml.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next);
}
const finalizeJob = jobBlock(aggYml, 'finalize');
const CONSUMERS: Record<string, string> = {
    'mesh-baking': jobBlock(upYml, 'mesh-baking'),
    'master-fusion-compute': jobBlock(upYml, 'master-fusion-compute'),
    'vfs-pack-db': jobBlock(upYml, 'vfs-pack-db'),
    'upload': jobBlock(upYml, 'upload'),
};
const MOD = 'scripts/factory/cycle-output-handoff-manifest.mjs';
const CARRIER = '--carrier=cycle-output-authority';
// The verify-or-recover region within a consumer job (drops the unrelated later steps).
function vorRegion(job: string): string {
    const s = job.indexOf('Verify or Recover Cycle Output from R2 Authority (FIX-2 / D-264)');
    if (s < 0) return '';
    const rest = job.slice(s);
    const e = rest.indexOf('recovered + verified cycle-output from exact staging');
    return e < 0 ? rest : rest.slice(0, e + 60);
}

describe('FIX-2 PRODUCER (finalize) -- durable manifest-last cycle-output R2 authority', () => {
    it('establishes an attempt-scoped staging bound to finalize-run + PRODUCER attempt + head-SHA', () => {
        expect(finalizeJob).toContain('HANDOFF_FINALIZE_RUN_ID: ${{ github.run_id }}');
        expect(finalizeJob).toContain('HANDOFF_PRODUCER_ATTEMPT: ${{ github.run_attempt }}');
        expect(finalizeJob).toContain('HANDOFF_HEAD_SHA: ${{ github.sha }}');
        expect(finalizeJob).toContain('RUN_PREFIX="state/_handoff/cycle-output/${PID}"');
        expect(finalizeJob).toContain('export STAGING="${RUN_PREFIX}/attempt-${ATT}/"');
        expect(finalizeJob).not.toMatch(/attempt-(latest|LATEST)/);
        expect(finalizeJob).not.toMatch(/attempt-\*/);
        // single-level prefix: the upstream/cycle id is provenance only, NEVER in the path.
        expect(finalizeJob).toContain('HANDOFF_UPSTREAM_RUN_ID: ${{ needs.check-upstream.outputs.process-id }}');
        expect(finalizeJob).not.toMatch(/RUN_PREFIX="state\/_handoff\/cycle-output\/\$\{PID\}\/\$\{/);
    });
    it('generates over `output` with the cycle-output-authority carrier (output/cache/** set)', () => {
        expect(finalizeJob).toContain('set -euo pipefail');
        expect(finalizeJob).toContain(`${MOD} generate output /tmp/cycle-output-manifest.json ${CARRIER}`);
    });
    it('P-ORDER: cache data FIRST, manifest.json LAST, descriptor handoff.json LAST-of-all', () => {
        const dataIdx = finalizeJob.indexOf('backup-dir output/cache/ "${STAGING}cache/"');
        const manIdx = finalizeJob.indexOf('upload-file /tmp/cycle-output-manifest.json "${STAGING}manifest.json"');
        const descIdx = finalizeJob.indexOf('upload-file /tmp/cycle-output-handoff.json "${RUN_PREFIX}/handoff.json"');
        expect(dataIdx).toBeGreaterThan(0);
        expect(manIdx).toBeGreaterThan(dataIdx);
        expect(descIdx).toBeGreaterThan(manIdx);
    });
    it('P-READBACK: descriptor read-back + FULL-SET read-back precede the "authority established" emit (READ-ONLY, no new write)', () => {
        const descRbIdx = finalizeJob.indexOf(`verify-descriptor /tmp/cycle-output-handoff-rb.json ${CARRIER}`);
        // STRICT-TOPOLOGY: cache was staged under ${STAGING}cache/ (its own _manifest.json) and
        // there is NO ${STAGING}_manifest.json, so the read-back restores the EXACT cache/ sub-prefix.
        const rbRestoreIdx = finalizeJob.indexOf('restore-dir "${STAGING}cache/" "${RB_DIR}/cache/" --strict');
        expect(finalizeJob).not.toContain('restore-dir "${STAGING}" "${RB_DIR}" --strict');
        const rbVerifyIdx = finalizeJob.indexOf(`verify "${'${RB_DIR}'}" /tmp/cycle-output-manifest.json ${CARRIER}`);
        const emitIdx = finalizeJob.indexOf('authority established (read-back verified)');
        expect(descRbIdx).toBeGreaterThan(0);
        expect(rbRestoreIdx).toBeGreaterThan(descRbIdx);
        expect(rbVerifyIdx).toBeGreaterThan(rbRestoreIdx);
        expect(emitIdx).toBeGreaterThan(rbVerifyIdx);
        // fail-closed: a read-back set-hash mismatch (partial upload) hard-fails before the emit.
        expect(finalizeJob.slice(rbVerifyIdx, emitIdx)).toMatch(/producer read-back set hash != \$\{SET_SHA\}[\s\S]*exit 1/);
        // Class-A: the read-back segment is restore-dir ONLY -- ZERO new PUT/COPY/DELETE.
        const seg = finalizeJob.slice(rbRestoreIdx, emitIdx);
        expect(seg).not.toContain('backup-dir');
        expect(seg).not.toContain('upload-file');
        expect(seg).not.toContain('upload-buffer');
        expect(seg).not.toContain('delete-prefix');
    });
    it('P-RELOCATE: the mutable fixed-prefix state/cycle-output/ backup is REMOVED (data relocated, +2 PUT budget)', () => {
        // no state/cycle-output/ as an executable backup/restore argument (comments may reference it).
        expect(finalizeJob).not.toMatch(/backup-dir\s+\S+\s+state\/cycle-output\//);
        expect(finalizeJob).not.toMatch(/(backup|restore)-dir[^\n]*state\/cycle-output\//);
        // Class-A: exactly the two authority PUTs (manifest + descriptor) beyond the relocated data backup-dir.
        const puts = finalizeJob.match(/upload-file \/tmp\/cycle-output-(manifest|handoff)\.json/g) || [];
        expect(puts.length).toBe(2);
        expect(finalizeJob).not.toContain('upload-buffer');
        expect(finalizeJob).not.toMatch(/delete-prefix/);
    });
    it('emits the read-back-verified authority identity as finalize job outputs', () => {
        expect(finalizeJob).toContain('id: establish-cycle-output');
        expect(finalizeJob).toContain('cycle_output_staging_prefix: ${{ steps.establish-cycle-output.outputs.staging_prefix }}');
        expect(finalizeJob).toContain('cycle_output_set_sha: ${{ steps.establish-cycle-output.outputs.set_sha }}');
    });
});

describe('FIX-2 CONSUMERS (all four) -- GHA acceleration-only, R2 authority, wipe-scoped, fail-closed', () => {
    for (const [name, job] of Object.entries(CONSUMERS)) {
        it(`${name}: job block resolves and the verify-or-recover step is present`, () => {
            expect(job.length).toBeGreaterThan(0);
            expect(job).toContain('Verify or Recover Cycle Output from R2 Authority (FIX-2 / D-264)');
        });
        it(`${name}: C-SAMESHA -- resolves the SAME current-cycle descriptor via the upstream-run-id + verify-descriptor`, () => {
            const v = vorRegion(job);
            expect(v).toContain('HANDOFF_FINALIZE_RUN_ID: ${{ needs.check-upstream.outputs.upstream-run-id }}');
            expect(v).toContain('DESC="state/_handoff/cycle-output/${PID}/handoff.json"');
            expect(v).toContain(`verify-descriptor /tmp/cycle-output-handoff-rb.json ${CARRIER}`);
            expect(v).toContain('restore-file "${STAGING_PREFIX}manifest.json" /tmp/cycle-output-manifest.json --strict');
            expect(v).toContain('EXPECT_SET_SHA=$(printf \'%s\' "$OUT" | cut -f2)');
        });
        it(`${name}: C-VERIFY -- the GHA-restored output/cache/** is VERIFIED against the manifest before use (set_sha equality, never count-only)`, () => {
            const v = vorRegion(job);
            expect(v).toContain(`verify_cycle_output() { node scripts/factory/cycle-output-handoff-manifest.mjs verify output /tmp/cycle-output-manifest.json ${CARRIER}; }`);
            expect(v).toMatch(/if OUT2=\$\(verify_cycle_output\) && \[ "\$\(printf '%s' "\$OUT2" \| tail -n1\)" = "\$EXPECT_SET_SHA" \]/);
        });
        it(`${name}: C-RECOVER + C-WIPE -- GHA miss/mismatch wipes ONLY output/cache/** (NEVER output/data/) + recovers from the EXACT staging + re-verifies`, () => {
            const v = vorRegion(job);
            expect(v).toContain('rm -rf output/cache; mkdir -p output/cache');
            // STRICT-TOPOLOGY: recover from the EXACT ${STAGING_PREFIX}cache/ sub-prefix into output/cache/
            // (the producer staged only ${STAGING_PREFIX}cache/_manifest.json, never a bare-root manifest).
            expect(v).toContain('restore-dir "${STAGING_PREFIX}cache/" output/cache/ --strict');
            expect(v).not.toContain('restore-dir "$STAGING_PREFIX" output/ --strict');
            // wipe discipline: output/data/ (FIX-4 meta-NN.db territory) is NEVER wiped or recovered here.
            expect(v).not.toMatch(/rm -rf output\/data/);
            expect(v).not.toContain('restore-dir "$STAGING_PREFIX" output/data');
        });
        it(`${name}: C-FAILCLOSED -- missing authority / recovery-verify failure / residual mismatch each FAIL CLOSED (exit 1)`, () => {
            const v = vorRegion(job);
            expect(v).toMatch(/no current-cycle cycle-output authority descriptor[\s\S]*Fail-closed[\s\S]*exit 1/);
            expect(v).toMatch(/exact-staging cycle-output recovery failed verification[\s\S]*exit 1/);
            expect(v).toMatch(/recovered cycle-output set hash != producer \$EXPECT_SET_SHA[\s\S]*exit 1/);
            // no warning-only mismatch path: the ONLY non-recover branch is the exact-match accept.
            expect(v).not.toMatch(/mismatch[^\n]*continue-on-error/);
        });
        it(`${name}: C-NOFIXED -- the fixed prefix state/cycle-output/ is NOT a recovery input`, () => {
            const v = vorRegion(job);
            expect(v).not.toContain('restore-dir state/cycle-output/');
        });
        it(`${name}: C-NOLOOSE -- the GHA cycle-output restore is EXACT-KEY only (restore-keys prefix authority REMOVED)`, () => {
            // Scope to the cycle-output cache-restore step only (other restores keep their own keys).
            const s = job.indexOf('key: cycle-${{ needs.check-upstream.outputs.upstream-run-id }}-output');
            expect(s).toBeGreaterThan(0);
            const region = job.slice(s, s + 400);
            expect(region).not.toMatch(/restore-keys:\s*cycle-\$\{\{ needs\.check-upstream\.outputs\.upstream-run-id \}\}-/);
            expect(region).not.toMatch(/restore-keys:\s*\|\s*\n\s*cycle-/);
        });
    }
    it('all four consumers use the IDENTICAL descriptor path + carrier (bind the SAME finalize authority set_sha)', () => {
        const sigs = Object.values(CONSUMERS).map((job) => {
            const v = vorRegion(job);
            return [
                v.includes('DESC="state/_handoff/cycle-output/${PID}/handoff.json"'),
                v.includes(`verify-descriptor /tmp/cycle-output-handoff-rb.json ${CARRIER}`),
                v.includes('HANDOFF_FINALIZE_RUN_ID: ${{ needs.check-upstream.outputs.upstream-run-id }}'),
            ].join('|');
        });
        expect(new Set(sigs).size).toBe(1);
        expect(sigs[0]).toBe('true|true|true');
    });
});

describe('FIX-2 SCOPE GUARD -- forbidden surfaces untouched', () => {
    it('the R2 authority is carried by GENERIC r2-workflow-cli ops (no new subcommand added)', () => {
        const cli = fs.readFileSync(path.resolve(__dirname, '../../scripts/factory/r2-workflow-cli.js'), 'utf8');
        expect(cli).not.toContain('cycle-output-handoff');
        expect(cli).not.toContain('cycle-output-establish');
        for (const job of [finalizeJob, ...Object.values(CONSUMERS)]) {
            expect(job).not.toMatch(/list-prefix[^\n]*attempt-/);
            expect(job).not.toMatch(/attempt-\*/);
        }
    });
    it('FIX-4 meta-NN.db publish binding (upload) is UNCHANGED (vfs-pack authority, output/data/ owner)', () => {
        const uploadJob = CONSUMERS['upload'];
        expect(uploadJob).toContain('Verify or Recover Published meta-NN.db from VFS Pack Authority (FIX-4 / D-252)');
        expect(uploadJob).toContain('STAGING_PREFIX: ${{ needs.vfs-pack-db.outputs.verified_vfs_pack_staging_prefix }}');
        expect(uploadJob).toContain('rm -rf output/data/; mkdir -p output/data/');
        // FIX-4 owns output/data/; the FIX-2 cycle-output consumer must not have touched it.
        expect(uploadJob).toContain(`vfs-derived-handoff-manifest.mjs verify output/data/ /tmp/vfs-pack-publish-manifest.json --carrier=vfs-pack-authority --ext=.db`);
    });
    it('FIX-3 shards carrier + FIX-1 registry carrier (factory-aggregate) are UNCHANGED', () => {
        const mergeJob = jobBlock(aggYml, 'merge-core-compute');
        expect(mergeJob).toContain('DESC="state/_handoff/shards/${PID}/handoff.json"');
        expect(mergeJob).toContain('restore-dir "$STAGING_PREFIX" artifacts/ --strict');
        // registry carrier restore (cache/registry) stays independent of cycle-output.
        expect(mergeJob).toContain('cache/registry');
        expect(finalizeJob).not.toContain('cache/registry');
        expect(finalizeJob).not.toContain('state/registry/');
        expect(finalizeJob).not.toContain('global-registry');
    });
    it('check-upstream upstream-run-id resolution is the resolver of record (not re-derived by the fix)', () => {
        expect(upYml).toContain('upstream-run-id: ${{ steps.get-id.outputs.id }}');
        for (const job of Object.values(CONSUMERS)) {
            expect(vorRegion(job)).not.toMatch(/gh run list --workflow factory-aggregate/);
        }
    });
    it('no GAP-6/H11 satellite-authority work is folded in (DEFERRED)', () => {
        expect(finalizeJob).not.toContain('satellite-authority');
        for (const job of Object.values(CONSUMERS)) expect(vorRegion(job)).not.toContain('satellite-authority');
    });
    it('workflow permissions are UNCHANGED (single top-level actions:write + contents:read)', () => {
        expect(aggYml).toContain('permissions:\n  actions: write\n  contents: read');
        expect(upYml).toMatch(/permissions:\n {2}actions: write\n {2}contents: read/);
    });
});
