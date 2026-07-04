// tests/unit/meta-db-publish-binding-workflow.test.ts
// FIX-4 / D-252 §D/§E (GAP-4 / C11) — META-DB PUBLICATION BINDING. STATIC
// workflow invariants: reads .github/workflows/factory-upload.yml as TEXT
// (CRLF-normalized; no execution, no network, no YAML eval) and locks the seam that
// binds the PUBLISHED meta-NN.db set (the SQLite backing every entity/search API) to
// the CURRENT-CYCLE VFS Pack R2 authority (H17/PR#2265) before Final Upload. Until
// FIX-4 the DB reached Upload via the fixed-prefix state/vfs-data/ restore (META-count
// floor ONLY) OR a STAGE-B fresh re-pack — NEVER set-SHA verified — while sitemap/RSS
// WERE identity-verified (D-245). That asymmetry let a stale/foreign-cycle DB publish
// under a verified sitemap: the site would describe entities the served DB does not
// hold. FIX-4 (mirror of the D-245 verify-or-recover pattern) verifies output/data/*.db
// EQUALS vfs-pack-db's exported authority set-SHA via the H17 verifier of record,
// recovers from the EXACT vfs-pack staging on miss/mismatch, and fails CLOSED if the
// current-cycle DB identity cannot be established. The V23.1/L2 SQL canaries stay
// QUALITY checks, NOT identity authority.
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
const uploadJob = jobBlock('upload');
const packJob = jobBlock('vfs-pack-db');
const MOD = 'scripts/factory/vfs-derived-handoff-manifest.mjs';

// Slice ONLY the FIX-4 gate step body (its `- name:` up to the next `- name:`), so the
// negative asserts below cannot borrow evidence from an adjacent step.
const GATE_NAME = 'Verify or Recover Published meta-NN.db from VFS Pack Authority (FIX-4 / D-252)';
const gateStart = uploadJob.indexOf(GATE_NAME);
const gateAfter = gateStart < 0 ? '' : uploadJob.slice(gateStart);
const gateNextName = gateAfter.indexOf('\n      - name:');
const gateStep = gateNextName < 0 ? gateAfter : gateAfter.slice(0, gateNextName);

const PUBLISH = 'node scripts/factory/r2-upload-s3.js';

describe('FIX-4 / D-252 — meta-NN.db publication bound to the VFS Pack authority', () => {
    it('#1 upload declares vfs-pack-db in needs (exposes verified_vfs_pack_* to the publish job)', () => {
        // exact array — removing vfs-pack-db reds this (anti-vacuity #9 twin)
        expect(uploadJob).toContain('needs: [mesh-baking, master-fusion-persist, vfs-derived, vfs-pack-db, check-upstream]');
    });

    it('#2 the DB identity gate step precedes "Upload to R2 via S3 API" (publish unreachable before verification)', () => {
        const gateIdx = uploadJob.indexOf(GATE_NAME);
        const publishIdx = uploadJob.indexOf(PUBLISH);
        expect(gateIdx).toBeGreaterThan(0);
        expect(publishIdx).toBeGreaterThan(gateIdx);
    });

    it('#3 consumes the VERIFIED VFS Pack identity + requires published set-SHA == authority set-SHA', () => {
        expect(gateStep).toContain('STAGING_PREFIX: ${{ needs.vfs-pack-db.outputs.verified_vfs_pack_staging_prefix }}');
        expect(gateStep).toContain('EXPECT_SET_SHA: ${{ needs.vfs-pack-db.outputs.verified_vfs_pack_set_sha }}');
        // EXACT-set verify of the to-be-published .db set via the H17 verifier of record
        expect(gateStep).toContain(`${MOD} verify output/data/ /tmp/vfs-pack-publish-manifest.json --carrier=vfs-pack-authority --ext=.db`);
        // fast-path acceptance is GATED on set-SHA equality, not mere presence
        expect(gateStep).toContain('= "$EXPECT_SET_SHA"');
    });

    it('#4 gate runs AFTER the fixed-prefix state/vfs-data/ restore + BEFORE publish — every arrival path is re-bound to set-SHA equality', () => {
        const fixedPrefixIdx = uploadJob.indexOf('restore-dir state/vfs-data/ output/data/');
        const gateIdx = uploadJob.indexOf(GATE_NAME);
        const publishIdx = uploadJob.indexOf(PUBLISH);
        expect(fixedPrefixIdx).toBeGreaterThan(0); // the META-count-only fixed prefix still exists as a data path
        expect(gateIdx).toBeGreaterThan(fixedPrefixIdx);
        expect(publishIdx).toBeGreaterThan(gateIdx);
    });

    it('#5 a stale state/vfs-data/ (fixed-prefix, META-count-only) mismatch is NOT published — wipe + recover from the EXACT vfs-pack staging, never re-trust the fixed prefix', () => {
        expect(gateStep).toContain('rm -rf output/data/');
        expect(gateStep).toContain('restore-dir "$STAGING_PREFIX" output/data/ --strict');
        // state/vfs-data/ is a DATA path, never the recovery INPUT of this gate
        expect(gateStep).not.toContain('restore-dir state/vfs-data/ output/data/');
    });

    it('#6 miss/mismatch recovers from the EXACT vfs-pack staging then RE-VERIFIES set-SHA equality, fail-closed', () => {
        expect(gateStep).toContain('restore-dir "$STAGING_PREFIX" output/data/ --strict');
        expect(gateStep).toMatch(/recovery failed verification[\s\S]*exit 1/);
        expect(gateStep).toMatch(/!= vfs-pack authority \$EXPECT_SET_SHA[\s\S]*exit 1/);
    });

    it('#7 a missing/empty VFS Pack authority identity fails CLOSED (no publish of an unverifiable DB)', () => {
        expect(gateStep).toMatch(/if \[ -z "\$\{STAGING_PREFIX\}" \] \|\| \[ -z "\$\{EXPECT_SET_SHA\}" \]; then[\s\S]*exit 1/);
    });

    it('#8 identity is inherited from the descriptor-verified job output — the gate NEVER re-derives/guesses a staging prefix or lists attempts', () => {
        expect(gateStep).toContain('needs.vfs-pack-db.outputs.verified_vfs_pack_staging_prefix');
        expect(gateStep).toContain('needs.vfs-pack-db.outputs.verified_vfs_pack_set_sha');
        // manifest is read from that EXACT staging prefix; no list-latest / attempt glob
        expect(gateStep).toContain('restore-file "${STAGING_PREFIX}manifest.json"');
        expect(gateStep).not.toMatch(/list-prefix[^\n]*attempt-/);
        expect(gateStep).not.toMatch(/attempt-(\*|latest|LATEST)/);
    });

    it('#8b the consumed authority IS descriptor-verified at the producer (run + attempt + head + version bound before export)', () => {
        // wrong run/attempt/head can never become the exported set-SHA the gate trusts
        expect(packJob).toContain(`${MOD} verify-descriptor /tmp/vfs-pack-handoff-rb.json --carrier=vfs-pack-authority`);
        expect(packJob).toContain('HANDOFF_HEAD_SHA: ${{ github.sha }}');
        expect(packJob).toContain('verified_vfs_pack_set_sha: ${{ steps.vfs-pack-handoff.outputs.set_sha }}');
    });
});

describe('FIX-4 — same current-cycle identity for meta-NN.db + sitemap/RSS; SQL canary demoted; ordering', () => {
    it('#9req meta-NN.db AND sitemap/RSS both verify their current-cycle identity BEFORE publish — the two identities cannot diverge', () => {
        const sitemapIdx = uploadJob.indexOf('Verify or Recover VFS-Derived Sitemaps/RSS from Exact Staging (D-245)');
        const metaIdx = uploadJob.indexOf(GATE_NAME);
        const publishIdx = uploadJob.indexOf(PUBLISH);
        expect(sitemapIdx).toBeGreaterThan(0);
        expect(metaIdx).toBeGreaterThan(0);
        expect(publishIdx).toBeGreaterThan(sitemapIdx);
        expect(publishIdx).toBeGreaterThan(metaIdx);
    });

    it('the DB identity gate runs BEFORE the dedup restore (output/data/ matches the producer meta+rankings .db shape; dedup .db land after)', () => {
        const metaIdx = uploadJob.indexOf(GATE_NAME);
        const dedupIdx = uploadJob.indexOf('restore-dir state/dedup/ output/data/dedup/');
        expect(metaIdx).toBeGreaterThan(0);
        expect(dedupIdx).toBeGreaterThan(metaIdx);
    });

    it('#10req the V23.1 SQL Health Check is PRESERVED as a QUALITY canary (verify-db), NOT the identity authority', () => {
        expect(uploadJob).toContain('node scripts/factory/verify-db.js');
        expect(uploadJob).toContain('V23.1 SQL Health Check');
        // the QUALITY canary carries no set-SHA authority comparison
        const sqlIdx = uploadJob.indexOf('V23.1 SQL Health Check');
        const sqlAfter = uploadJob.slice(sqlIdx);
        const sqlNext = sqlAfter.indexOf('\n      - name:');
        const sqlStep = sqlNext < 0 ? sqlAfter : sqlAfter.slice(0, sqlNext);
        expect(sqlStep).not.toContain('EXPECT_SET_SHA');
    });
});

describe('FIX-4 — anti-vacuity + scope', () => {
    it('#9 anti-vacuity: removing vfs-pack-db from upload.needs reds the binding (needs.vfs-pack-db.* unresolvable)', () => {
        expect(uploadJob).toMatch(/needs:\s*\[[^\]]*\bvfs-pack-db\b[^\]]*\]/);
        expect(gateStep).toContain('needs.vfs-pack-db.outputs.verified_vfs_pack_set_sha');
    });

    it('#10 anti-vacuity: the set-SHA equality gate exists on BOTH the fast path AND the post-recovery re-verify', () => {
        const eq = gateStep.match(/= "\$EXPECT_SET_SHA"/g) || [];
        expect(eq.length).toBeGreaterThanOrEqual(2);
        expect(gateStep).toMatch(/!= vfs-pack authority \$EXPECT_SET_SHA/);
    });

    it('#11 anti-vacuity: every failure branch is fail-CLOSED (>=3 `exit 1`: missing identity, recovery-verify failure, residual mismatch)', () => {
        const exits = gateStep.match(/exit 1/g) || [];
        expect(exits.length).toBeGreaterThanOrEqual(3);
    });

    it('#SCOPE the gate introduces NO R2 write/delete/list (LOW-Class-A: 0 new PUT on success) and reuses the H17 verifier — no new module', () => {
        expect(gateStep).not.toContain('backup-dir');
        expect(gateStep).not.toContain('upload-file');
        expect(gateStep).not.toContain('delete-prefix');
        expect(gateStep).not.toContain('list-prefix');
        expect(gateStep).toContain(MOD); // reuse of the H17 verifier of record
    });

    it('#SCOPE workflow permissions UNCHANGED (single top-level actions:write, no per-job override)', () => {
        expect(yml).toContain('permissions:\n  actions: write\n  contents: read\n  id-token: write');
        expect(yml).not.toMatch(/\n {4}permissions:/);
    });

    it('#SCOPE the FIX-4 gate touches NO producer/business logic (pack-db / sitemap-gen / rss-generator / master-fusion unchanged)', () => {
        expect(gateStep).not.toContain('pack-db.js');
        expect(gateStep).not.toContain('vfs-sitemap-gen.js');
        expect(gateStep).not.toContain('rss-generator.js');
        // the production uploader invocation itself is unchanged (single occurrence)
        expect((uploadJob.match(/node scripts\/factory\/r2-upload-s3\.js/g) || []).length).toBe(1);
    });
});
