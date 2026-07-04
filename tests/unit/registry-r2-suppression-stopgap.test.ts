// tests/unit/registry-r2-suppression-stopgap.test.ts
// D-2026-0704-250 (GAP-1, P0 stop-gap) — Factory 4/4 `master-fusion-compute`
// REGISTRY-R2-FRESHNESS static workflow invariant. Reads
// .github/workflows/factory-upload.yml as TEXT (CRLF-normalized; NO execution, NO
// network, NO YAML eval) and locks the durable comparison: the FRESH current-cycle
// R2 `state/registry/` restore (which 3/4 wrote for THIS upstream cycle) WINS; a
// stale or `restore-keys`-prefix-restored GitHub Actions cache can NEVER
// prevent/suppress it. ROOT CAUSE: under the normal cron cascade 3/4 is a
// `workflow_run` whose exact `global-registry-<upstream>` cache SAVE is write-denied
// (GitHub 2026-06-26 read-only-cache policy), so the exact current-cycle key always
// misses; the bare `restore-keys: global-registry-` then pulled the newest SURVIVING
// registry from a prior/FOREIGN cycle and a `BIN_COUNT >= 100` gate SUPPRESSED the
// fresh current-cycle R2 restore -> silent stale/mixed-cycle Master Fusion
// publication (valid-id set + FNI percentiles computed over a foreign registry).
// FIX: the GHA cache is demoted to EXACT-KEY verified acceleration only (trusted iff
// `steps.cache-global-registry.outputs.cache-hit == 'true'`); every non-exact case
// WIPES the possibly-prefix-restored cache and performs the MANDATORY fresh R2
// restore, preserving the legit fallback chain (state/registry/ -> monolith ->
// bootstrap) and failing CLOSED when no current-cycle registry can be established.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const WF = path.resolve(__dirname, '../../.github/workflows/factory-upload.yml');
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

// Extract a top-level job block (2-space indent) up to the next top-level job.
function jobBlock(name: string): string {
    const start = yml.indexOf(`\n  ${name}:`);
    if (start < 0) return '';
    const rest = yml.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next);
}
// Extract a single step block (`      - name: <stepName>`) up to the next 6-space step.
function stepBlock(job: string, stepName: string): string {
    const marker = `      - name: ${stepName}`;
    const start = job.indexOf(marker);
    if (start < 0) return '';
    const rest = job.slice(start + marker.length);
    const next = rest.indexOf('\n      - ');
    return next < 0 ? rest : rest.slice(0, next);
}

const fusionJob = jobBlock('master-fusion-compute');
const restoreStep = stepBlock(fusionJob, 'Restore Global Registry Cache');
const ensureStep = stepBlock(fusionJob, 'Ensure Current-Cycle Registry (D-250, fail-closed)');

const R2_RESTORE = 'node scripts/factory/r2-workflow-cli.js restore-dir state/registry/ cache/registry/';
const WIPE = 'rm -rf cache/registry cache/global-registry.json.zst';

describe('D-250 REGISTRY-R2-FRESHNESS — fixtures present (non-vacuity of extraction)', () => {
    it('the master-fusion-compute job + both registry steps are located', () => {
        expect(fusionJob).toContain('name: Master Fusion (Compute)');
        expect(restoreStep.length).toBeGreaterThan(0);
        expect(ensureStep.length).toBeGreaterThan(0);
        // the job block must NOT bleed into the next job
        expect(fusionJob).not.toContain('master-fusion-persist:');
    });
});

describe('D-250 GHA cache demoted to EXACT-KEY verified acceleration', () => {
    it('#2 exact current-cycle key is the ONLY trusted GHA fast path (cache-hit == true gate present)', () => {
        // the restore step carries the id + the exact upstream-cycle-scoped key
        expect(restoreStep).toContain('id: cache-global-registry');
        expect(restoreStep).toContain('key: global-registry-${{ needs.check-upstream.outputs.upstream-run-id }}');
        // the ensure step wires the EXACT-hit output and gates trust on it
        expect(ensureStep).toContain('CACHE_EXACT_HIT: ${{ steps.cache-global-registry.outputs.cache-hit }}');
        expect(ensureStep).toContain('[ "$CACHE_EXACT_HIT" = "true" ]');
    });
    it('#3/#10 bare `restore-keys: global-registry-` authority is REMOVED (re-adding it reds this lock)', () => {
        expect(restoreStep).not.toContain('restore-keys:');
        // job-wide: no registry restore-keys prefix authority survives anywhere in this job
        expect(fusionJob).not.toMatch(/restore-keys:\s*global-registry-/);
    });
});

describe('D-250 stale BIN_COUNT>=100 suppression removed / inverted', () => {
    it('#4/#9 the shard-floor >=100 check is NESTED UNDER the exact-hit trust gate, not a top-level R2 suppressor', () => {
        const gate = ensureStep.indexOf('[ "$CACHE_EXACT_HIT" = "true" ]');
        const floor = ensureStep.indexOf('-ge 100');
        expect(gate).toBeGreaterThanOrEqual(0);
        expect(floor).toBeGreaterThan(gate); // exact-hit gate strictly precedes the only -ge 100
        // there is EXACTLY one `-ge 100` (the trusted-fast-path floor); the old code's
        // top-level `-ge 100 -> skip R2` suppression cannot coexist with this.
        expect(ensureStep.match(/-ge 100/g)?.length).toBe(1);
    });
    it('#1/#9 the mandatory R2 restore is on the fall-through path (after the exact-hit early exit), NEVER suppressed by shard count', () => {
        const early = ensureStep.indexOf('exit 0');
        const wipe = ensureStep.indexOf(WIPE);
        const r2 = ensureStep.indexOf(R2_RESTORE);
        const floor = ensureStep.indexOf('-ge 100');
        expect(early).toBeGreaterThan(0);
        // the ONLY -ge 100 is before the exact-hit exit; the wipe + R2 restore come AFTER it
        expect(floor).toBeLessThan(early);
        expect(wipe).toBeGreaterThan(early);
        expect(r2).toBeGreaterThan(wipe);
    });
});

describe('D-250 fresh current-cycle R2 WINS (mandatory restore + stale-cache wipe)', () => {
    it('#4 a non-exact cache is WIPED before the R2 restore so a prefix-restored/foreign registry is never consumed as authority', () => {
        expect(ensureStep).toContain(WIPE);
    });
    it('#5/#8 the fresh R2 state/registry/ current-cycle restore is MANDATORY on the untrusted-cache path (removing it reds this lock)', () => {
        expect(ensureStep).toContain(R2_RESTORE);
    });
    it('#6-chain the legit R2 fallback chain (state/registry/ -> monolith -> bootstrap) is preserved as recovery', () => {
        expect(ensureStep).toContain('restore-file state/global-registry.json.zst cache/global-registry.json.zst');
        expect(ensureStep).toContain('node scripts/factory/lib/r2-registry-restore.js');
        // ordering: fresh state/registry/ is tried FIRST, bootstrap is last-resort
        expect(ensureStep.indexOf(R2_RESTORE))
            .toBeLessThan(ensureStep.indexOf('node scripts/factory/lib/r2-registry-restore.js'));
    });
});

describe('D-250 fail CLOSED on no current-cycle registry', () => {
    it('#6 a sub-floor registry after all recovery paths fails closed (exit 1) as the TERMINAL gate', () => {
        // the fail-closed check comes AFTER the R2 restore + bootstrap
        expect(ensureStep.indexOf(R2_RESTORE)).toBeLessThan(ensureStep.lastIndexOf('-lt 100'));
        expect(ensureStep).toMatch(/-lt 100[\s\S]*exit 1/);
        expect(ensureStep).toContain('::error::');
        // the error is the D-250 stale/mixed-cycle guard, not a generic 0-entities note
        expect(ensureStep).toMatch(/Failing CLOSED to prevent stale\/mixed-cycle Master Fusion publication/);
    });
});

describe('D-250 no stale registry proceeds into Master Fusion (ordering) + SCOPE guard', () => {
    it('#7 the current-cycle registry is established BEFORE it is aligned into output/cache and consumed by fusion', () => {
        const ensureIdx = fusionJob.indexOf('Ensure Current-Cycle Registry (D-250, fail-closed)');
        const alignIdx = fusionJob.indexOf('Align Registry Cache for Fusion');
        const fusionIdx = fusionJob.indexOf('Execute Master Fusion');
        expect(ensureIdx).toBeGreaterThan(0);
        expect(alignIdx).toBeGreaterThan(ensureIdx);
        expect(fusionIdx).toBeGreaterThan(alignIdx);
    });
    it('SCOPE: Master Fusion business logic + fused-cache exact-key are UNCHANGED by this stop-gap', () => {
        // fusion still reads the aligned registry as ARTIFACT_DIR and runs the same script
        expect(fusionJob).toContain('ARTIFACT_DIR: ./output/cache/registry');
        expect(fusionJob).toContain('node scripts/factory/master-fusion.js');
        // the fused-cache restore stayed EXACT-key (S1-BR); this PR touched only the registry seam
        expect(fusionJob).toContain('key: intra-4-4-fused-${{ needs.check-upstream.outputs.upstream-run-id }}-${{ github.run_id }}');
    });
    it('workflow permissions are UNCHANGED (single top-level actions:write, no per-job override)', () => {
        expect(yml).toContain('permissions:\n  actions: write\n  contents: read\n  id-token: write');
        expect(yml).not.toMatch(/\n {4}permissions:/);
    });
});
