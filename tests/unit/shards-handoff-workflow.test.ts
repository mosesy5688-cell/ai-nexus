// tests/unit/shards-handoff-workflow.test.ts
// FIX-3 / C10 (D-2026-0704-262): Factory 2/4 -> 3/4 SHARDS attempt-scoped R2
// authority + the intra-2/4 prepared-entity-data predecessor (GAP-5) STATIC
// workflow invariants. Reads .github/workflows/factory-process.yml (PRODUCER) +
// factory-aggregate.yml (CONSUMER) as TEXT (CRLF-normalized; no execution, no
// network, no YAML eval) and locks the durable, attempt-scoped, manifest-last DAG:
// save-shards-cache establishes a process-run + attempt staging set over the EXACT
// 20 shards (data -> manifest LAST -> descriptor LAST-of-all); merge-core-compute
// consumes ONLY that authority, uses GHA as an exact-key fast path (NO restore-keys),
// recovers from the EXACT staging on miss/mismatch, and FAILS CLOSED on a missing
// authority / residual mismatch / non-20 set. Same shape for prepared-entity-data.
// ROOT CAUSE: the 2/4->3/4 shards handoff authority was a fixed-prefix per-file R2
// copy + a prefix GHA restore-key + count/magic-only guards -- a stale/foreign/
// predecessor-cycle set could suppress the true current-cycle shards.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const PROC = path.resolve(__dirname, '../../.github/workflows/factory-process.yml');
const AGG = path.resolve(__dirname, '../../.github/workflows/factory-aggregate.yml');
const procYml = fs.readFileSync(PROC, 'utf8').replace(/\r\n/g, '\n');
const aggYml = fs.readFileSync(AGG, 'utf8').replace(/\r\n/g, '\n');

function jobBlock(yml: string, name: string): string {
    const start = yml.indexOf(`\n  ${name}:`);
    if (start < 0) return '';
    const rest = yml.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next);
}
const prepareJob = jobBlock(procYml, 'prepare-data');
const matrixJob = jobBlock(procYml, 'matrix-shards');
const saveJob = jobBlock(procYml, 'save-shards-cache');
const mergeJob = jobBlock(aggYml, 'merge-core-compute');
const MOD = 'scripts/factory/shards-handoff-manifest.mjs';

describe('FIX-3 PRODUCER (save-shards-cache) -- durable manifest-last shards R2 authority', () => {
    it('establishes an attempt-scoped staging bound to process-run + PRODUCER attempt + head-SHA', () => {
        expect(saveJob).toContain('HANDOFF_PROCESS_RUN_ID: ${{ github.run_id }}');
        expect(saveJob).toContain('HANDOFF_PRODUCER_ATTEMPT: ${{ github.run_attempt }}');
        expect(saveJob).toContain('HANDOFF_HEAD_SHA: ${{ github.sha }}');
        expect(saveJob).toContain('RUN_PREFIX="state/_handoff/shards/${PID}"');
        expect(saveJob).toContain('export STAGING="${RUN_PREFIX}/attempt-${ATT}/"');
        expect(saveJob).not.toMatch(/attempt-(latest|LATEST)/);
        expect(saveJob).not.toMatch(/attempt-\*/);
    });
    it('E6/exact-20: generates over output/shards with the shards-authority carrier (exact-20 set)', () => {
        expect(saveJob).toContain('set -euo pipefail');
        expect(saveJob).toContain(`${MOD} generate output/shards /tmp/shards-manifest.json --carrier=shards-authority`);
    });
    it('data FIRST, manifest.json LAST, descriptor handoff.json LAST-of-all', () => {
        const dataIdx = saveJob.indexOf('backup-dir output/shards "${STAGING}" --extensions=.json.zst');
        const manIdx = saveJob.indexOf('upload-file /tmp/shards-manifest.json "${STAGING}manifest.json"');
        const descIdx = saveJob.indexOf('upload-file /tmp/shards-handoff.json "${RUN_PREFIX}/handoff.json"');
        expect(dataIdx).toBeGreaterThan(0);
        expect(manIdx).toBeGreaterThan(dataIdx);
        expect(descIdx).toBeGreaterThan(manIdx);
    });
    it('read-back verifies the descriptor provenance before the cross-workflow handoff', () => {
        expect(saveJob).toContain(`${MOD} verify-descriptor /tmp/shards-handoff-rb.json --carrier=shards-authority`);
        expect(saveJob).toContain('HANDOFF_RUN_ATTEMPT="${ATT}"');
    });
    it('E5: the matrix stream to fixed state/shards/ is DEMOTED to a compat transport (not authority)', () => {
        expect(matrixJob).toContain('Stream Shard to R2 (compat transport, non-authoritative)');
        expect(matrixJob).toContain('state/shards/shard-${{ matrix.shard }}.json.zst');
    });
});

describe('FIX-3 CONSUMER (merge-core-compute) -- GHA acceleration-only, R2 authority, fail-closed', () => {
    it('E1/E2: resolves ONLY the current-cycle attempt-scoped authority via the process-id descriptor', () => {
        expect(mergeJob).toContain('HANDOFF_PROCESS_RUN_ID: ${{ needs.check-upstream.outputs.process-id }}');
        expect(mergeJob).toContain('DESC="state/_handoff/shards/${PID}/handoff.json"');
        expect(mergeJob).toContain(`${MOD} verify-descriptor /tmp/shards-handoff-rb.json --carrier=shards-authority`);
        expect(mergeJob).toContain('restore-file "${STAGING_PREFIX}manifest.json" /tmp/shards-manifest.json --strict');
    });
    it('E2: GHA fast path is EXACT-KEY only -- the restore-keys cycle-prefix authority is REMOVED', () => {
        // Scope to the shards-restore step only (the harvest-context restore below keeps its
        // own restore-keys, which is out of scope for this fix).
        const s = mergeJob.indexOf('Restore Shards from Cache');
        const e = mergeJob.indexOf('Clean Environment Residue');
        const shardsRestore = mergeJob.slice(s, e > s ? e : undefined);
        expect(shardsRestore).toContain('key: cycle-${{ needs.check-upstream.outputs.process-id }}-shards');
        expect(shardsRestore).not.toMatch(/restore-keys:\s*\|\s*\n\s*cycle-/);
    });
    it('E1: the GHA-restored shards are VERIFIED against the R2 manifest before use (never count-only)', () => {
        expect(mergeJob).toContain('verify_shards() { node scripts/factory/shards-handoff-manifest.mjs verify artifacts /tmp/shards-manifest.json --carrier=shards-authority; }');
        expect(mergeJob).toMatch(/if OUT2=\$\(verify_shards\) && \[ "\$\(printf '%s' "\$OUT2" \| tail -n1\)" = "\$EXPECT_SET_SHA" \]/);
    });
    it('E3: GHA miss/mismatch => wipe + restore EXACT staging + re-verify', () => {
        expect(mergeJob).toContain('rm -rf artifacts; mkdir -p artifacts');
        expect(mergeJob).toContain('restore-dir "$STAGING_PREFIX" artifacts/ --strict');
    });
    it('E4: missing authority / recovery-verify failure / residual mismatch each FAIL CLOSED (exit 1)', () => {
        expect(mergeJob).toMatch(/no current-cycle shards authority descriptor[\s\S]*Fail-closed[\s\S]*exit 1/);
        expect(mergeJob).toMatch(/exact-staging shard recovery failed verification[\s\S]*exit 1/);
        expect(mergeJob).toMatch(/recovered shard set hash != producer \$EXPECT_SET_SHA[\s\S]*exit 1/);
        // no warning-only mismatch path: the ONLY non-recover branch is the exact-match accept.
        expect(mergeJob).not.toMatch(/mismatch[^\n]*continue-on-error/);
    });
    it('E5/E6: fixed-prefix state/shards/ is NOT a recovery input; the final gate is EXACTLY 20', () => {
        expect(mergeJob).not.toContain('restore-file "state/shards/shard-');
        expect(mergeJob).not.toContain('restore-dir state/shards/');
        expect(mergeJob).toMatch(/FINAL_COUNT" -ne 20[\s\S]*exit 1/);
    });
});

describe('GAP-5 PRODUCER (prepare-data) -- prepared-entity-data durable authority', () => {
    it('establishes a process-run + attempt prepared-entity-data authority (manifest LAST, descriptor LAST)', () => {
        expect(prepareJob).toContain('HANDOFF_PROCESS_RUN_ID: ${{ github.run_id }}');
        expect(prepareJob).toContain('RUN_PREFIX="state/_handoff/prepared-entity-data/${PID}"');
        expect(prepareJob).toContain(`${MOD} generate . /tmp/prep-manifest.json --carrier=prepared-entity-data-authority`);
        const dataIdx = prepareJob.indexOf('backup-dir data/ "${STAGING}data/" --extensions=.json,.json.zst');
        const cacheIdx = prepareJob.indexOf('backup-dir cache/ "${STAGING}cache/"');
        const manIdx = prepareJob.indexOf('upload-file /tmp/prep-manifest.json "${STAGING}manifest.json"');
        const descIdx = prepareJob.indexOf('upload-file /tmp/prep-handoff.json "${RUN_PREFIX}/handoff.json"');
        expect(dataIdx).toBeGreaterThan(0);
        expect(cacheIdx).toBeGreaterThan(0);
        expect(manIdx).toBeGreaterThan(dataIdx);
        expect(manIdx).toBeGreaterThan(cacheIdx);
        expect(descIdx).toBeGreaterThan(manIdx);
    });
    it('E5: the fixed-prefix state/prepared-entity-data/ backup is DEMOTED to a compat copy', () => {
        expect(prepareJob).toContain('Backup Prepared Data to R2 (compat copy, non-authoritative)');
        expect(prepareJob).toContain('backup-dir data/ state/prepared-entity-data/data/');
    });
});

describe('GAP-5 CONSUMER (matrix-shards) -- verify-or-recover prepared-entity-data', () => {
    it('E1/E3/E4: verify-or-recover the prepared set from the attempt-scoped authority, fail-closed', () => {
        expect(matrixJob).toContain('DESC="state/_handoff/prepared-entity-data/${PID}/handoff.json"');
        expect(matrixJob).toContain(`${MOD} verify-descriptor /tmp/prep-handoff-rb.json --carrier=prepared-entity-data-authority`);
        expect(matrixJob).toContain('verify_prep() { node scripts/factory/shards-handoff-manifest.mjs verify . /tmp/prep-manifest.json --carrier=prepared-entity-data-authority; }');
        expect(matrixJob).toContain('restore-dir "${STAGING_PREFIX}data/" data/ --strict');
        expect(matrixJob).toMatch(/no current-cycle prepared-entity-data authority descriptor[\s\S]*exit 1/);
        expect(matrixJob).toMatch(/recovered set hash != producer \$EXPECT_SET_SHA[\s\S]*exit 1/);
    });
    it('E5: fixed-prefix state/prepared-entity-data/ is NO LONGER a recovery input for the matrix', () => {
        expect(matrixJob).not.toContain('restore-dir state/prepared-entity-data/data/ data/ --strict');
        expect(matrixJob).not.toContain('restore-dir state/prepared-entity-data/cache/ cache/');
    });
});

describe('FIX-3 / GAP-5 SCOPE GUARD -- forbidden surfaces unchanged', () => {
    it('the R2 authority is carried by GENERIC r2-workflow-cli ops (no new subcommand added)', () => {
        const cli = fs.readFileSync(path.resolve(__dirname, '../../scripts/factory/r2-workflow-cli.js'), 'utf8');
        // The shards seam reuses the existing generic ops; no shards-specific subcommand.
        expect(cli).not.toContain('shards-handoff');
        for (const job of [saveJob, mergeJob, prepareJob, matrixJob]) {
            expect(job).not.toMatch(/list-prefix[^\n]*attempt-/);
            expect(job).not.toMatch(/attempt-\*/);
        }
    });
    it('business logic (split-registry / shard-processor / aggregator) is invoked, never re-pathed', () => {
        expect(prepareJob).toContain('node scripts/factory/split-registry.js');
        expect(matrixJob).toContain('node scripts/factory/shard-processor.js --shard=${{ matrix.shard }} --total=20');
        expect(mergeJob).toContain('node scripts/factory/aggregator.js --task=core');
    });
    it('FIX-2 finalize / cycle-output region and FIX-5 process-id resolution are NOT referenced by this fix', () => {
        // process-id resolution (check-upstream get-ids) stays the resolver of record.
        expect(aggYml).toContain('process-id=$PROCESS_RUN_ID');
        // the shards consumer never re-derives process-id or touches the finalize cycle-output.
        expect(mergeJob).not.toContain('cycle-output');
        expect(mergeJob).not.toMatch(/gh run list --workflow factory-process/);
    });
    it('workflow permissions are UNCHANGED (single top-level actions:write + contents:read)', () => {
        expect(procYml).toContain('permissions:\n  actions: write\n  contents: read');
        expect(aggYml).toContain('permissions:\n  actions: write\n  contents: read');
    });
});

describe('D-262 amendment F2 -- producer FULL-SET read-back gates the authority (fail-closed on partial upload)', () => {
    // STRICT-TOPOLOGY: the read-back reads back EACH exact sub-prefix a producer actually staged.
    // shards were staged with backup-dir to the bare ${STAGING} root (its own _manifest.json), so
    // the shards read-back is a single bare-root restore. prepared-entity-data was staged into the
    // data/ + cache/ sub-prefixes (per-role _manifest.json, NO ${STAGING}_manifest.json), so it
    // reads back EACH sub-prefix -- a bare ${STAGING} root restore there is manifest-impossible.
    for (const [label, job, rbAnchors, manifestTmp, tag] of [
        ['shards', saveJob, ['restore-dir "${STAGING}" "${RB_DIR}" --strict'], '/tmp/shards-manifest.json', 'shards-authority'],
        ['prepared-entity-data', prepareJob, ['restore-dir "${STAGING}data/" "${RB_DIR}/data/" --strict', 'restore-dir "${STAGING}cache/" "${RB_DIR}/cache/" --strict'], '/tmp/prep-manifest.json', 'prepared-entity-data-authority'],
    ] as const) {
        it(`${label}: read-back restore(s) + verify precede the "authority established" emit (READ-ONLY, no new write)`, () => {
            const rbRestoreIdx = job.indexOf(rbAnchors[0]);
            const rbVerifyIdx = job.indexOf(`verify "${'${RB_DIR}'}" ${manifestTmp} --carrier=${tag}`);
            const emitIdx = job.indexOf('authority established (read-back verified)');
            expect(rbRestoreIdx).toBeGreaterThan(0);
            // every required sub-prefix read-back is present AND precedes the set-hash verify.
            for (const anchor of rbAnchors) {
                const idx = job.indexOf(anchor);
                expect(idx).toBeGreaterThan(0);
                expect(idx).toBeLessThan(rbVerifyIdx);
            }
            // no bare ${STAGING} root restore when the producer only staged sub-prefix manifests.
            if (label === 'prepared-entity-data') expect(job).not.toContain('restore-dir "${STAGING}" "${RB_DIR}" --strict');
            expect(rbVerifyIdx).toBeGreaterThan(rbRestoreIdx);
            expect(emitIdx).toBeGreaterThan(rbVerifyIdx);
            // fail-closed: a read-back set-hash mismatch (partial upload) hard-fails before the emit.
            expect(job.slice(rbVerifyIdx, emitIdx)).toMatch(/producer read-back set hash != \$\{SET_SHA\}[\s\S]*exit 1/);
            // Class-A: the read-back segment is restore-dir ONLY -- ZERO new PUT/COPY/DELETE.
            const seg = job.slice(rbRestoreIdx, emitIdx);
            expect(seg).not.toContain('backup-dir');
            expect(seg).not.toContain('upload-file');
            expect(seg).not.toContain('upload-buffer');
            expect(seg).not.toContain('delete-prefix');
        });
    }
});

describe('D-262 amendment F3 -- consumer recover restore hard-fails directly (not only via trailing verify)', () => {
    it('shards consumer: the recover restore-dir --strict has an explicit fail-closed', () => {
        expect(mergeJob).toMatch(/restore-dir "\$STAGING_PREFIX" artifacts\/ --strict \|\| \{ echo "::error::FIX-3: recover restore failed[\s\S]*exit 1; \}/);
    });
    it('GAP-5 matrix consumer: the recover restore-dir --strict has an explicit fail-closed', () => {
        expect(matrixJob).toMatch(/restore-dir "\$\{STAGING_PREFIX\}data\/" data\/ --strict \|\| \{ echo "::error::GAP-5: recover restore failed[\s\S]*exit 1; \}/);
    });
});
