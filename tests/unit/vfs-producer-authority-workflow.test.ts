// tests/unit/vfs-producer-authority-workflow.test.ts
// VFS_PRODUCER_ARTIFACT_EXACT_CYCLE_AUTHORITY_4_OF_4 — STATIC workflow invariants.
// Reads .github/workflows/factory-upload.yml as TEXT (CRLF-normalized; no execution,
// no YAML eval) and locks the AUTHORITY-W (warm_read sibling) + AUTHORITY-M
// (mesh-profile) durable, attempt-scoped, manifest-last DAG + the publication-family
// closure gate + the self-strip kill + fixed-prefix demotion. Module-level
// generate/verify/reject logic lives in the .mjs node:test suites; this file locks the
// wiring shape. Each assertion is an anti-vacuity tie — reverting the wiring reds it.
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
const meshJob = jobBlock('mesh-baking');
const packJob = jobBlock('vfs-pack-db');
const derivedJob = jobBlock('vfs-derived');
const uploadJob = jobBlock('upload');
const VMOD = 'scripts/factory/vfs-derived-handoff-manifest.mjs';
const MMOD = 'scripts/factory/mesh-profile-handoff-manifest.mjs';

describe('AUTHORITY-W producer (vfs-pack-db) — sibling warm-read manifest, meta byte-identical', () => {
    it('exports the VERIFIED warm_read set-sha as a job output', () => {
        expect(packJob).toContain('verified_vfs_pack_warm_read_set_sha: ${{ steps.vfs-pack-handoff.outputs.warm_read_set_sha }}');
    });
    it('generates a SIBLING warm-read-manifest.json (never touches the meta manifest generate)', () => {
        expect(packJob).toContain(`${VMOD} generate-warm-read output/data/ /tmp/vfs-warm-read-manifest.json --carrier=vfs-pack-authority`);
        // meta manifest generate (ext=.db) is UNCHANGED — proves the sibling variant.
        expect(packJob).toContain(`${VMOD} generate output/data/ /tmp/vfs-pack-manifest.json --carrier=vfs-pack-authority --ext=.db`);
    });
    it('stages the warm bins into the warm/ role sub-prefix + term_index into its own sub-prefix (D-302/D-303)', () => {
        // D-302/D-303: warm bins -> ${STAGING}warm/ (its OWN _manifest.json); term_index ->
        // ${STAGING}term_index/ — never the bare ${STAGING} the .db meta uses (manifest-overwrite bug).
        expect(packJob).toContain('backup-dir output/data/ "${STAGING}warm/" --extensions=.bin');
        expect(packJob).toContain('backup-dir output/data/term_index/ "${STAGING}term_index/"');
        expect(packJob).not.toContain('backup-dir output/data/ "${STAGING}" --extensions=.bin');
    });
    it('warm manifest + meta manifest LAST, then handoff.json LAST-OF-ALL (ordering preserved)', () => {
        const warmMan = packJob.indexOf('upload-file /tmp/vfs-warm-read-manifest.json "${STAGING}warm-read-manifest.json"');
        const metaMan = packJob.indexOf('upload-file /tmp/vfs-pack-manifest.json "${STAGING}manifest.json"');
        const desc = packJob.indexOf('upload-file /tmp/vfs-pack-handoff.json "${RUN_PREFIX}/handoff.json"');
        expect(warmMan).toBeGreaterThan(0);
        expect(metaMan).toBeGreaterThan(warmMan);
        expect(desc).toBeGreaterThan(metaMan);
    });
    it('descriptor gains ONLY additive warm_read fields; read-back verifies the warm authority', () => {
        expect(packJob).toContain('warm_read_set_sha256:String(process.env.WARM_SET_SHA)');
        expect(packJob).toContain('warm_read_member_count:Number(process.env.WARM_MEMBER_COUNT)');
        expect(packJob).toContain('restore-file "${STAGING}warm-read-manifest.json" /tmp/vfs-warm-read-manifest-rb.json --strict');
        expect(packJob).toMatch(/RB_WARM_SET[\s\S]*WARM_SET_SHA[\s\S]*exit 1/);
        expect(packJob).toContain('warm_read_set_sha=${WARM_SET_SHA}');
    });
    it('#NEG removing warm_read producer staging reds this gate (T1/T2 tie)', () => {
        // The producer MUST stage the warm data + emit the warm manifest; if a future edit
        // drops either, these anchors vanish and the suite reds.
        expect(packJob).toContain('generate-warm-read output/data/');
        expect(packJob).toContain('warm-read-manifest.json');
    });
});

describe('AUTHORITY-W consumers (vfs-derived + upload) — verify warm + self-strip KILL', () => {
    for (const [label, job, man] of [
        ['vfs-derived', derivedJob, '/tmp/vfs-warm-read-manifest.json'],
        ['upload (FIX-4)', uploadJob, '/tmp/vfs-warm-read-publish-manifest.json'],
    ] as const) {
        it(`${label}: consumes the warm_read authority set-sha + verifies (never --ext=.db-only)`, () => {
            expect(job).toContain('EXPECT_WARM_SET_SHA: ${{ needs.vfs-pack-db.outputs.verified_vfs_pack_warm_read_set_sha }}');
            expect(job).toContain(`${VMOD} verify-warm-read output/data/ ${man} --carrier=vfs-pack-authority`);
        });
        it(`${label}: self-strip KILL — rm -rf output/data + per-role restore (meta/warm/term_index) recovers meta+warm, warm fail-closed`, () => {
            const rm = job.indexOf('rm -rf output/data/');
            // D-302/D-303: recover EACH role from its OWN R2 sub-prefix — never the single bare-prefix
            // restore whose last-writer-wins _manifest.json dropped meta-00.db from the restore set.
            const meta = job.indexOf('restore-dir "${STAGING_PREFIX}meta/" output/data/ --strict');
            const warm = job.indexOf('restore-dir "${STAGING_PREFIX}warm/" output/data/ --strict');
            const term = job.indexOf('restore-dir "${STAGING_PREFIX}term_index/" output/data/term_index/ --strict');
            expect(rm).toBeGreaterThan(0);
            expect(meta).toBeGreaterThan(rm); // wipe then restore each role from its own sub-prefix
            expect(warm).toBeGreaterThan(rm);
            expect(term).toBeGreaterThan(rm);
            expect(job).not.toContain('restore-dir "$STAGING_PREFIX" output/data/ --strict');
            expect(job).toMatch(/warm_read set hash != [\s\S]*exit 1/);
        });
    }
    it('#NEG a self-strip that cannot restore warm reds (T13 tie): each consumer restores the warm role sub-prefix', () => {
        // D-302/D-303: each consumer restores the warm role from ${STAGING_PREFIX}warm/ (bins) +
        // term_index/ — never a bare/.db-only restore that would leave the bins/term_index stripped.
        expect(derivedJob).toContain('restore-dir "${STAGING_PREFIX}warm/" output/data/ --strict');
        expect(uploadJob).toContain('restore-dir "${STAGING_PREFIX}warm/" output/data/ --strict');
        expect(derivedJob).not.toMatch(/restore-dir "\$STAGING_PREFIX" output\/data\/ --strict --extensions=\.db/);
        expect(uploadJob).not.toMatch(/restore-dir "\$STAGING_PREFIX" output\/data\/ --strict --extensions=\.db/);
    });
});

describe('AUTHORITY-M producer (mesh-baking) — durable attempt-scoped mesh-profile authority', () => {
    it('attempt-scoped mesh-profile staging prefix bound to upstream + 4/4 run + attempt', () => {
        expect(meshJob).toContain('RUN_PREFIX="state/_handoff/mesh-profile/${UP}/${RUN}"');
        expect(meshJob).toContain('export STAGING="${RUN_PREFIX}/attempt-${ATT}/"');
        expect(meshJob).toContain('HANDOFF_PRODUCER_ATTEMPT: ${{ github.run_attempt }}');
        expect(meshJob).toContain('HANDOFF_MESH_CODE_VERSION: ${{ env.MESH_PROFILE_CODE_VERSION }}');
        expect(meshJob).not.toMatch(/attempt-(latest|LATEST)/);
    });
    it('data FIRST (shards + dict), manifest.json LAST, descriptor handoff.json LAST-OF-ALL', () => {
        expect(meshJob).toContain(`${MMOD} generate output/cache/mesh /tmp/mesh-profile-manifest.json --carrier=mesh-profile-authority`);
        const shards = meshJob.indexOf('backup-dir output/cache/mesh/profile-shards/ "${STAGING}profile-shards/"');
        const dict = meshJob.indexOf('upload-file output/cache/mesh/profile-evidence-dict.json.zst "${STAGING}profile-evidence-dict.json.zst"');
        const man = meshJob.indexOf('upload-file /tmp/mesh-profile-manifest.json "${STAGING}manifest.json"');
        const desc = meshJob.indexOf('upload-file /tmp/mesh-profile-handoff.json "${RUN_PREFIX}/handoff.json"');
        expect(shards).toBeGreaterThan(0);
        expect(man).toBeGreaterThan(shards);
        expect(man).toBeGreaterThan(dict);
        expect(desc).toBeGreaterThan(man);
    });
    it('descriptor binds dict_sha256 + expected_shard_count; read-back verifies provenance', () => {
        expect(meshJob).toContain('dict_sha256:process.env.DICT_SHA');
        expect(meshJob).toContain('expected_shard_count:Number(process.env.SHARD_COUNT)');
        expect(meshJob).toContain(`${MMOD} verify-descriptor /tmp/mesh-profile-handoff-rb.json --carrier=mesh-profile-authority`);
    });
    it('runs on success() (incl. the cache-hit skip path) so the current cycle ALWAYS has AUTH-M', () => {
        const stepIdx = meshJob.indexOf('Produce Exact-Producer R2 Handoff (MESH-PROFILE, AUTH-M)');
        expect(stepIdx).toBeGreaterThan(0);
        const step = meshJob.slice(stepIdx, stepIdx + 400);
        expect(step).toContain('if: success()');
    });
});

describe('AUTHORITY-M consumers (vfs-pack-db + vfs-derived + upload) — verify-or-recover, fixed-prefix demoted', () => {
    for (const [label, job] of [['vfs-pack-db', packJob], ['vfs-derived', derivedJob], ['upload', uploadJob]] as const) {
        it(`${label}: resolves the descriptor by (upstream, run_id) + verifies + recovers fail-closed`, () => {
            expect(job).toContain('DESC="state/_handoff/mesh-profile/${UP}/${RUN}/handoff.json"');
            expect(job).toContain(`${MMOD} verify-descriptor /tmp/mesh-profile-handoff-rb.json --carrier=mesh-profile-authority`);
            expect(job).toContain(`${MMOD} verify output/cache/mesh /tmp/mesh-profile-manifest.json --carrier=mesh-profile-authority`);
            expect(job).toMatch(/AUTH-M: recovered set hash != producer \$EXPECT_SET_SHA[\s\S]*exit 1/);
        });
        it(`${label}: fixed-prefix state/mesh-profile-* is NO LONGER a recovery INPUT (T11 tie)`, () => {
            expect(job).not.toContain('restore-dir state/mesh-profile-shards/ output/cache/mesh/profile-shards/');
            expect(job).not.toContain('restore-file state/mesh-profile-dict/profile-evidence-dict.json.zst output/cache/mesh/profile-evidence-dict.json.zst');
        });
    }
    it('the AUTH-M consumer descriptor + manifest restores are --strict + exit 1 (no warning-only)', () => {
        for (const job of [packJob, derivedJob, uploadJob]) {
            expect(job).toMatch(/restore-file "\$DESC" \/tmp\/mesh-profile-handoff-rb\.json --strict[\s\S]*exit 1/);
            expect(job).toMatch(/restore-file "\$\{STAGING_PREFIX\}manifest\.json" \/tmp\/mesh-profile-manifest\.json --strict[\s\S]*exit 1/);
        }
    });
});

describe('PUBLICATION-FAMILY closure gate (upload) — one cycle-family before R2 publish', () => {
    it('resolves the three descriptors + runs family-gate BEFORE Upload to R2, fail-closed', () => {
        expect(uploadJob).toContain('VP="state/_handoff/vfs-pack/${UP}/${RUN}/handoff.json"');
        expect(uploadJob).toContain('MP="state/_handoff/mesh-profile/${UP}/${RUN}/handoff.json"');
        expect(uploadJob).toContain('VD="state/_handoff/vfs-derived/${UP}/${RUN}/handoff.json"');
        expect(uploadJob).toContain(`${VMOD} family-gate /tmp/fam-vfs-pack.json /tmp/fam-mesh-profile.json /tmp/fam-vfs-derived.json`);
        const gate = uploadJob.indexOf('Publication-Family Closure Gate (BEFORE R2 publish)');
        const publish = uploadJob.indexOf('node scripts/factory/r2-upload-s3.js');
        expect(gate).toBeGreaterThan(0);
        expect(publish).toBeGreaterThan(gate);
        expect(uploadJob).toMatch(/cross-descriptor closure gate FAILED[\s\S]*exit 1/);
    });
    it('#NEG skipping the family gate reds this gate (T6/T10/T14 tie)', () => {
        expect(uploadJob).toContain('family-gate /tmp/fam-vfs-pack.json');
        // each descriptor restore is --strict fail-closed (a missing descriptor cannot pass)
        expect(uploadJob).toMatch(/restore-file "\$VP"[\s\S]*--strict[\s\S]*exit 1/);
    });
});

describe('SCOPE GUARD — no meta-set regression, permissions + timeouts intact', () => {
    it('the meta_db manifest.json + descriptor set_sha256 wiring is UNCHANGED (byte-identical)', () => {
        expect(packJob).toContain('upload-file /tmp/vfs-pack-manifest.json "${STAGING}manifest.json"');
        // the meta verify (ext=.db) in the consumers is UNCHANGED — warm is a separate manifest.
        expect(derivedJob).toContain(`${VMOD} verify output/data/ /tmp/vfs-pack-manifest.json --carrier=vfs-pack-authority --ext=.db`);
    });
    it('workflow permissions UNCHANGED (single top-level, no per-job override)', () => {
        expect(yml).toContain('permissions:\n  actions: write\n  contents: read\n  id-token: write');
        expect(yml).not.toMatch(/\n {4}permissions:/);
    });
    it('job timeouts intact (mesh-baking 330, vfs-pack-db 330, vfs-derived 30, upload 330)', () => {
        expect(meshJob).toContain('timeout-minutes: 330');
        expect(packJob).toContain('timeout-minutes: 330');
        expect(derivedJob).toContain('timeout-minutes: 30');
        expect(uploadJob).toContain('timeout-minutes: 330');
    });
});
