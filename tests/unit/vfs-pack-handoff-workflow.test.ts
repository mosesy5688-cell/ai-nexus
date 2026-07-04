// tests/unit/vfs-pack-handoff-workflow.test.ts
// D-245 VFS PACK -> VFS DERIVED (PRIMARY) + VFS DERIVED -> UPLOAD sitemap/RSS
// (SECONDARY) EXACT-PRODUCER R2 HANDOFF — STATIC workflow invariants. Reads
// .github/workflows/factory-upload.yml as TEXT (CRLF-normalized; no execution, no
// network, no YAML eval) and locks the durable, attempt-scoped, manifest-last DAG:
// vfs-pack-db produces a run+attempt staging set (data -> manifest LAST -> descriptor
// LAST-of-all) + exports the verified identity; vfs-derived consumes ONLY that
// identity, uses GHA as an exact-key fast path (NO restore-keys authority), recovers
// from the EXACT staging on miss/mismatch BEFORE the PRESERVED META>=1 guard, then
// produces its own sitemap/RSS authority; Upload verifies + recovers that current-cycle
// identity before publication; success-only cleanup + bounded handoff-prefix GC.
// ROOT CAUSE: a workflow_run GHA cache write-auth denial starved VFS Derived (empty
// meta-NN.db -> guard abort -> publish skipped). Durable R2 authority is the fix.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const WF = path.resolve(__dirname, '../../.github/workflows/factory-upload.yml');
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

function jobBlock(name: string): string {
    const start = yml.indexOf(`\n  ${name}:`);
    if (start < 0) return '';
    const rest = yml.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next);
}
const packJob = jobBlock('vfs-pack-db');
const derivedJob = jobBlock('vfs-derived');
const uploadJob = jobBlock('upload');
const MOD = 'scripts/factory/vfs-derived-handoff-manifest.mjs';

describe('D-245 PRIMARY producer (vfs-pack-db) — durable manifest-last R2 authority', () => {
    it('exports the VERIFIED vfs-pack identity as job outputs', () => {
        for (const out of ['verified_vfs_pack_staging_prefix', 'verified_vfs_pack_set_sha', 'verified_vfs_pack_producer_attempt']) {
            expect(packJob).toContain(`${out}:`);
        }
    });
    it('#1 attempt-scoped staging prefix bound to upstream + 4/4 run + PRODUCER attempt + head-SHA + version', () => {
        expect(packJob).toContain('RUN_PREFIX="state/_handoff/vfs-pack/${UP}/${RUN}"');
        expect(packJob).toContain('export STAGING="${RUN_PREFIX}/attempt-${ATT}/"');
        expect(packJob).toContain('HANDOFF_PRODUCER_ATTEMPT: ${{ github.run_attempt }}');
        expect(packJob).toContain('HANDOFF_HEAD_SHA: ${{ github.sha }}');
        expect(packJob).toContain('HANDOFF_VFS_PACK_CODE_VERSION: ${{ env.VFS_PACK_CODE_VERSION }}');
        expect(packJob).not.toMatch(/attempt-(latest|LATEST)/);
        expect(packJob).not.toMatch(/attempt-\*/);
    });
    it('#3 data uploaded FIRST, manifest.json LAST, descriptor handoff.json LAST-of-all (set -e)', () => {
        expect(packJob).toContain('set -euo pipefail');
        expect(packJob).toContain(`${MOD} generate output/data/ /tmp/vfs-pack-manifest.json --carrier=vfs-pack-authority --ext=.db`);
        const dataIdx = packJob.indexOf('backup-dir output/data/ "${STAGING}" --extensions=.db');
        const manIdx = packJob.indexOf('upload-file /tmp/vfs-pack-manifest.json "${STAGING}manifest.json"');
        const descIdx = packJob.indexOf('upload-file /tmp/vfs-pack-handoff.json "${RUN_PREFIX}/handoff.json"');
        expect(dataIdx).toBeGreaterThan(0);
        expect(manIdx).toBeGreaterThan(dataIdx);
        expect(descIdx).toBeGreaterThan(manIdx);
    });
    it('read-back verifies the descriptor provenance before exporting the identity', () => {
        expect(packJob).toContain(`${MOD} verify-descriptor /tmp/vfs-pack-handoff-rb.json --carrier=vfs-pack-authority`);
        expect(packJob).toContain('HANDOFF_RUN_ATTEMPT="${ATT}"');
    });
    it('the producer NEVER writes the manifest/descriptor into the public output/data/ tree', () => {
        expect(packJob).not.toContain('generate output/data/ output/data/manifest.json');
        expect(packJob).toContain('/tmp/vfs-pack-manifest.json');
    });
});

describe('D-245 PRIMARY consumer (vfs-derived) — GHA acceleration-only, R2 authority, guard preserved', () => {
    it('#8 consumes ONLY the vfs-pack-db VERIFIED identity (staging prefix + set hash) from job outputs', () => {
        expect(derivedJob).toContain('STAGING_PREFIX: ${{ needs.vfs-pack-db.outputs.verified_vfs_pack_staging_prefix }}');
        expect(derivedJob).toContain('EXPECT_SET_SHA: ${{ needs.vfs-pack-db.outputs.verified_vfs_pack_set_sha }}');
    });
    it('#2 GHA fast path is EXACT-KEY only — NO restore-keys vfs-pack prefix authority remains', () => {
        expect(derivedJob).not.toMatch(/restore-keys:\s*\|\s*\n\s*intra-4-4-vfs-pack-/);
        // the exact key (with run_id) survives as the acceleration key
        expect(derivedJob).toContain('key: intra-4-4-vfs-pack-${{ env.VFS_PACK_CODE_VERSION }}-${{ needs.check-upstream.outputs.upstream-run-id }}-${{ github.run_id }}');
    });
    it('#7 verify-or-recover: GHA miss/mismatch => wipe + restore EXACT staging + re-verify fail-closed', () => {
        expect(derivedJob).toContain('rm -rf output/data/');
        expect(derivedJob).toContain('restore-dir "$STAGING_PREFIX" output/data/ --strict');
        expect(derivedJob).toContain(`${MOD} verify output/data/ /tmp/vfs-pack-manifest.json --carrier=vfs-pack-authority --ext=.db`);
        expect(derivedJob).toMatch(/!= producer \$EXPECT_SET_SHA[\s\S]*exit 1/);
    });
    it('#12 no fixed-prefix (state/vfs-data/) is ever a vfs-pack recovery INPUT into output/data/', () => {
        expect(derivedJob).not.toContain('restore-dir state/vfs-data/ output/data/');
    });
    it('#7b the PRESERVED META>=1 defensive guard remains fail-closed and runs AFTER verify-or-recover', () => {
        const recoverIdx = derivedJob.indexOf('Verify or Recover VFS Pack from Exact Staging (D-245)');
        const guardIdx = derivedJob.indexOf('Verify VFS Pack Files Present (defensive)');
        expect(recoverIdx).toBeGreaterThan(0);
        expect(guardIdx).toBeGreaterThan(recoverIdx);
        const guard = derivedJob.slice(guardIdx);
        expect(guard).toMatch(/META_COUNT[\s\S]*-lt 1[\s\S]*exit 1/);
    });
});

describe('D-246 RSS INPUT recovery — reports/knowledge index durably captured + recovered', () => {
    it('producer probes the RSS inputs (--rss-base) + stages DECLARED-PRESENT ones BEFORE manifest LAST', () => {
        expect(packJob).toContain('--carrier=vfs-pack-authority --ext=.db --rss-base=.');
        expect(packJob).toContain(`${MOD} rss-recovery-plan /tmp/vfs-pack-manifest.json --carrier=vfs-pack-authority`);
        const rssUploadIdx = packJob.indexOf('upload-file "$RSS_LOCAL" "${STAGING}${RSS_STAGED}"');
        const manIdx = packJob.indexOf('upload-file /tmp/vfs-pack-manifest.json "${STAGING}manifest.json"');
        expect(rssUploadIdx).toBeGreaterThan(0);
        expect(manIdx).toBeGreaterThan(rssUploadIdx); // manifest still LAST, after RSS inputs
    });
    it('the descriptor RECORDS per-RSS-input presence (paused/absent distinguishable from unrecovered)', () => {
        expect(packJob).toContain('rss_inputs:(m.rss_inputs||[]).map(e=>({name:e.name,present:e.present}))');
    });
    it('#10 consumer recovers every declared-present RSS input from EXACT staging BEFORE rss-generator, fail-closed', () => {
        const recIdx = derivedJob.indexOf('Recover VFS-Pack RSS Inputs from Exact Staging (D-246)');
        const rssGenIdx = derivedJob.indexOf('node scripts/factory/lib/rss-generator.js ./output');
        expect(recIdx).toBeGreaterThan(0);
        expect(rssGenIdx).toBeGreaterThan(recIdx); // recovery strictly precedes RSS generation
        expect(derivedJob).toContain('restore-file "${STAGING_PREFIX}${RSS_STAGED}" "$RSS_LOCAL" --strict');
        expect(derivedJob).toContain(`${MOD} verify-rss-inputs /tmp/vfs-pack-manifest.json . --carrier=vfs-pack-authority`);
        // a present-input recovery failure is fail-closed (states 3/6 => exit 1)
        expect(derivedJob).toMatch(/RSS input recovery failed[\s\S]*exit 1/);
    });
    it('#10-antivacuity deleting the RSS recovery/verify reds this gate (the step + verify-rss-inputs must exist)', () => {
        expect(derivedJob).toContain('rss-recovery-plan /tmp/vfs-pack-manifest.json --carrier=vfs-pack-authority');
        expect(derivedJob).toContain('verify-rss-inputs /tmp/vfs-pack-manifest.json . --carrier=vfs-pack-authority');
    });
});

describe('D-245 SECONDARY producer (vfs-derived) — sitemap/RSS durable authority', () => {
    it('exports the VERIFIED vfs-derived identity as job outputs', () => {
        for (const out of ['verified_vfs_derived_staging_prefix', 'verified_vfs_derived_set_sha', 'verified_vfs_derived_producer_attempt']) {
            expect(derivedJob).toContain(`${out}:`);
        }
    });
    it('binds the parent vfs-pack set-sha; attempt-scoped vfs-derived staging; manifest LAST, descriptor LAST-of-all', () => {
        expect(derivedJob).toContain('HANDOFF_PARENT_SET_SHA: ${{ needs.vfs-pack-db.outputs.verified_vfs_pack_set_sha }}');
        expect(derivedJob).toContain('RUN_PREFIX="state/_handoff/vfs-derived/${UP}/${RUN}"');
        expect(derivedJob).toContain(`${MOD} generate "$STAGE_LOCAL" /tmp/vfs-derived-manifest.json --carrier=vfs-derived-authority`);
        const dataIdx = derivedJob.indexOf('backup-dir "$STAGE_LOCAL" "${STAGING}"');
        const manIdx = derivedJob.indexOf('upload-file /tmp/vfs-derived-manifest.json "${STAGING}manifest.json"');
        const descIdx = derivedJob.indexOf('upload-file /tmp/vfs-derived-handoff.json "${RUN_PREFIX}/handoff.json"');
        expect(dataIdx).toBeGreaterThan(0);
        expect(manIdx).toBeGreaterThan(dataIdx);
        expect(descIdx).toBeGreaterThan(manIdx);
    });
});

describe('D-245 SECONDARY consumer (Final Upload) — verify current-cycle sitemap/RSS before publication', () => {
    it('#6 consumes ONLY the vfs-derived VERIFIED identity + recovers EXACT staging, BEFORE Upload to R2', () => {
        expect(uploadJob).toContain('STAGING_PREFIX: ${{ needs.vfs-derived.outputs.verified_vfs_derived_staging_prefix }}');
        expect(uploadJob).toContain('EXPECT_SET_SHA: ${{ needs.vfs-derived.outputs.verified_vfs_derived_set_sha }}');
        expect(uploadJob).toContain('restore-dir "$STAGING_PREFIX" /tmp/vfs-derived-recover --strict');
        expect(uploadJob).toContain(`${MOD} verify /tmp/vfs-derived-verify /tmp/vfs-derived-manifest.json --carrier=vfs-derived-authority`);
        expect(uploadJob).toMatch(/!= producer \$EXPECT_SET_SHA[\s\S]*exit 1/);
        const verifyIdx = uploadJob.indexOf('Verify or Recover VFS-Derived Sitemaps/RSS from Exact Staging (D-245)');
        const publishIdx = uploadJob.indexOf('node scripts/factory/r2-upload-s3.js');
        expect(verifyIdx).toBeGreaterThan(0);
        expect(publishIdx).toBeGreaterThan(verifyIdx);
    });
});

describe('D-245 staging lifecycle (cleanup + bounded GC)', () => {
    const stepIdx = uploadJob.indexOf('Cleanup + GC VFS Handoff Staging (D-245)');
    // Bound the slice to THIS step only (up to the next `- name:`) so negative asserts
    // do not catch a later always()-gated step (e.g. Upload Dedup Ledger).
    const after = stepIdx < 0 ? '' : uploadJob.slice(stepIdx);
    const nextName = after.indexOf('\n      - name:');
    const step = nextName < 0 ? after : after.slice(0, nextName);
    it('#11 Final Upload SUCCESS => delete BOTH current-run staging prefixes (success-gated)', () => {
        expect(stepIdx).toBeGreaterThan(0);
        expect(step).toContain('if: success()');
        expect(step).toContain('for CARRIER in vfs-pack vfs-derived');
        expect(step).toContain('CUR_RUN_PREFIX="state/_handoff/${CARRIER}/${UP}/${RUN}/"');
        expect(step).toContain('delete-prefix "${CUR_RUN_PREFIX}"');
    });
    it('#11b downstream FAILURE retains staging (cleanup is success()-gated, not always())', () => {
        expect(step).toContain('if: success()');
        expect(step).not.toContain('if: always()');
    });
    it('#12b GC is 7-day bounded, refuses the current run, walks ONLY the two handoff roots', () => {
        expect(step).toContain("RETENTION_DAYS: '7'");
        expect(step).toContain('[ "$rid" = "$GC_CUR_RUN" ] && continue');
        expect(step).toContain('for root in state/_handoff/vfs-pack/ state/_handoff/vfs-derived/');
        expect(step).toContain('"$created" -lt "$keep_after"');
    });
    it('delete-prefix is CLI-locked to the handoff staging tree (GC cannot touch non-_handoff carriers)', () => {
        const cli = fs.readFileSync(path.resolve(__dirname, '../../scripts/factory/r2-workflow-cli.js'), 'utf8');
        expect(cli).toContain("const HANDOFF_STAGING_ROOT = 'state/_handoff/'");
        expect(cli).toContain('assertHandoffStagingPrefix');
    });
});

describe('D-245 SCOPE GUARD — forbidden surfaces unchanged', () => {
    it('pack-db.js / sitemap-gen / rss-generator business logic invoked, never re-pathed', () => {
        expect(packJob).toContain('node scripts/factory/pack-db.js');
        expect(derivedJob).toContain('node scripts/factory/vfs-sitemap-gen.js --db=output/data/meta-00.db --out=output');
        expect(derivedJob).toContain('node scripts/factory/lib/rss-generator.js ./output');
    });
    it('workflow permissions are UNCHANGED (single top-level actions:write, no per-job override)', () => {
        expect(yml).toContain('permissions:\n  actions: write\n  contents: read\n  id-token: write');
        // no per-job `permissions:` block was introduced by this PR
        expect(yml).not.toMatch(/\n {4}permissions:/);
    });
    it('job timeouts are intact (vfs-pack-db 330, vfs-derived 30, upload 330)', () => {
        expect(packJob).toContain('timeout-minutes: 330');
        expect(derivedJob).toContain('timeout-minutes: 30');
        expect(uploadJob).toContain('timeout-minutes: 330');
    });
    it('#NEG reverting the consumer to a restore-keys prefix or fixed-prefix recovery reds this gate', () => {
        expect(derivedJob).not.toMatch(/restore-keys:\s*\|\s*\n\s*intra-4-4-vfs-pack-/);
        expect(derivedJob).not.toContain('restore-dir state/vfs-data/ output/data/');
        for (const job of [packJob, derivedJob, uploadJob]) {
            expect(job).not.toMatch(/list-prefix[^\n]*attempt-/);
            expect(job).not.toMatch(/attempt-\*/);
        }
    });
});
