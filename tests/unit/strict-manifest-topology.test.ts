// tests/unit/strict-manifest-topology.test.ts
// STRICT-MANIFEST-TOPOLOGY — consumer-side reconciliation of PR #2295's hardened
// `restore-dir ... --strict`. #2295 made restore-dir --strict REQUIRE an exact-prefix
// `<prefix>_manifest.json` and fail closed with NO LIST fallback when absent. Several
// Factory callsites restored a ROOT staging prefix whose producer wrote only SUB-PREFIX
// manifests (e.g. `<root>cache/_manifest.json`) with NO `<root>_manifest.json`, so they
// 404'd fail-closed. This suite locks the 24 `restore-dir ... --strict` callsites across
// the 4 factory-*.yml workflows to the manifest TOPOLOGY each producer actually wrote:
//   (a) 13 LEGAL   — exact sub-prefix restore, OR bare-root restore of a bare-root
//                    backup-dir producer (its own `${STAGING}_manifest.json` exists).
//   (b) 3  BLOCKER — GAP-5 prep read-back, save-shards-cache, cycle-output read-back:
//                    were bare-root restores of sub-prefix-manifest producers => 404.
//   (c) 7  RECOVERY— 4 cycle-output consumers + 3 mesh-profile consumers: same defect
//                    on the R2 recovery path.
//   (d) 1  LEGACY  — harvest ingestion/raw/ has NO directory manifest (manifest-impossible).
// Reads the YAMLs as TEXT (CRLF-normalized; no execution/network/YAML eval). Every
// assertion is an anti-vacuity tie: reverting a callsite to its bare-root form reds it.
// RED on the pre-fix YAML, GREEN after the reconciliation. Strict semantics in
// scripts/factory/lib/r2-handoff.js + r2-workflow-cli.js are UNCHANGED (out of scope).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const wf = (n: string) => fs.readFileSync(path.resolve(__dirname, `../../.github/workflows/${n}`), 'utf8').replace(/\r\n/g, '\n');
const harvestYml = wf('factory-harvest.yml');
const processYml = wf('factory-process.yml');
const aggYml = wf('factory-aggregate.yml');
const uploadYml = wf('factory-upload.yml');
const ALL: Record<string, string> = { 'factory-harvest.yml': harvestYml, 'factory-process.yml': processYml, 'factory-aggregate.yml': aggYml, 'factory-upload.yml': uploadYml };

const count = (hay: string, needle: string) => hay.split(needle).length - 1;
function jobBlock(yml: string, name: string): string {
    const start = yml.indexOf(`\n  ${name}:`);
    if (start < 0) return '';
    const rest = yml.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next);
}
// A restore-dir --strict COMMAND line (excludes comment prose that mentions the flag).
function strictRestoreDirLines(yml: string): string[] {
    return yml.split('\n').filter((l) => /r2-workflow-cli\.js restore-dir\b/.test(l) && l.includes('--strict'));
}

describe('STRICT-TOPOLOGY census — the 24 restore-dir --strict callsites', () => {
    it('exactly 24 restore-dir --strict command callsites across the 4 workflows (0/5/2/17)', () => {
        expect(strictRestoreDirLines(harvestYml).length).toBe(0);
        expect(strictRestoreDirLines(processYml).length).toBe(5);
        expect(strictRestoreDirLines(aggYml).length).toBe(2);
        expect(strictRestoreDirLines(uploadYml).length).toBe(17);
        const total = Object.values(ALL).reduce((n, y) => n + strictRestoreDirLines(y).length, 0);
        expect(total).toBe(24);
    });
    it('REQ-3: NO bare-root restore of a sub-prefix-manifest producer remains (each forbidden form is absent)', () => {
        // Discriminated by the fail-closed message so the LEGAL FIX-3 shards bare-root read-back
        // (backup-dir wrote ${STAGING}_manifest.json) is NOT swept up.
        const forbidden = [
            'restore-dir "${STAGING}" "${RB_DIR}" --strict || { echo "::error::GAP-5:', // (b) prep read-back
            'restore-dir state/shards/ artifacts/ --strict',                            // (b) save-shards-cache
            'restore-dir "${STAGING}" "${RB_DIR}" --strict || { echo "::error::FIX-2:', // (b) cycle-output read-back
            'restore-dir "$STAGING_PREFIX" output/ --strict',                           // (c) cycle-output consumers
            'restore-dir "$STAGING_PREFIX" output/cache/mesh/ --strict',                // (c) mesh consumers
            'restore-dir ingestion/raw/ data/ --strict',                                // (d) legacy
        ];
        for (const f of forbidden) for (const [name, y] of Object.entries(ALL)) expect(count(y, f), `${f} @ ${name}`).toBe(0);
    });
    it('13 LEGAL callsites intact (exact sub-prefix, or bare-root of a bare-root backup-dir producer)', () => {
        expect(count(processYml, 'restore-dir "${STAGING_PREFIX}data/" data/ --strict')).toBe(1);   // GAP-5 consumer recover
        expect(count(processYml, 'restore-dir "${STAGING}" "${RB_DIR}" --strict || { echo "::error::FIX-3:')).toBe(1); // shards read-back
        expect(count(aggYml, 'restore-dir "$STAGING_PREFIX" artifacts/ --strict')).toBe(1);          // shards consumer recover
        expect(count(uploadYml, 'restore-dir "$STAGING_PREFIX" output/cache/fused/ --strict')).toBe(3); // fused (bare-root producer)
        expect(count(uploadYml, 'restore-dir "${STAGING_PREFIX}meta/" output/data/ --strict')).toBe(2);
        expect(count(uploadYml, 'restore-dir "${STAGING_PREFIX}warm/" output/data/ --strict')).toBe(2);
        expect(count(uploadYml, 'restore-dir "${STAGING_PREFIX}term_index/" output/data/term_index/ --strict')).toBe(2);
        expect(count(uploadYml, 'restore-dir "$STAGING_PREFIX" /tmp/vfs-derived-recover --strict')).toBe(1); // vfs-derived (bare-root producer)
        // 1 + 1 + 1 + 3 + 2 + 2 + 2 + 1 = 13
    });
});

describe('STRICT-TOPOLOGY (b) GAP-5 prep read-back — bare-root split into exact data/ + cache/ (factory-process.yml)', () => {
    const prep = jobBlock(processYml, 'prepare-data');
    it('REQ-4/5: reads back EACH exact sub-prefix (both fail-closed), never the bare ${STAGING} root', () => {
        expect(count(prep, 'restore-dir "${STAGING}data/" "${RB_DIR}/data/" --strict')).toBe(1);
        expect(count(prep, 'restore-dir "${STAGING}cache/" "${RB_DIR}/cache/" --strict')).toBe(1);
        expect(prep).toContain('restore-dir "${STAGING}data/" "${RB_DIR}/data/" --strict || { echo "::error::GAP-5:');
        expect(prep).toContain('restore-dir "${STAGING}cache/" "${RB_DIR}/cache/" --strict || { echo "::error::GAP-5:');
        expect(prep).not.toContain('restore-dir "${STAGING}" "${RB_DIR}" --strict');
    });
});

describe('STRICT-TOPOLOGY (b) shards transport — exact run/attempt prefix + manifest-last (factory-process.yml)', () => {
    const matrix = jobBlock(processYml, 'matrix-shards');
    const save = jobBlock(processYml, 'save-shards-cache');
    it('REQ-7: the 20 matrix jobs stream each shard into the EXACT run/attempt transport prefix', () => {
        expect(matrix).toContain('STAGING="state/_handoff/shards/${HANDOFF_PROCESS_RUN_ID}/attempt-${HANDOFF_PRODUCER_ATTEMPT}/"');
        expect(matrix).toContain('upload-buffer "$SHARD_FILE" "${STAGING}shard-${{ matrix.shard }}.json.zst"');
        expect(matrix).toContain('HANDOFF_PROCESS_RUN_ID: ${{ github.run_id }}');
        expect(matrix).toContain('HANDOFF_PRODUCER_ATTEMPT: ${{ github.run_attempt }}');
    });
    it('REQ-7: save-shards-cache publishes the exact-20 _manifest.json MANIFEST-LAST, then strict-restores from the exact prefix', () => {
        expect(save).toContain("Array.from({length:20},(_,i)=>'shard-'+i+'.json.zst')");
        expect(save).toContain('count:files.length');
        const manIdx = save.indexOf('upload-file /tmp/shards-transport-manifest.json "${STAGING}_manifest.json"');
        const restoreIdx = save.indexOf('restore-dir "${STAGING}" artifacts/ --strict');
        expect(manIdx).toBeGreaterThan(0);
        expect(restoreIdx).toBeGreaterThan(manIdx); // manifest committed BEFORE the strict restore
        expect(save).toContain('STAGING="state/_handoff/shards/${HANDOFF_PROCESS_RUN_ID}/attempt-${HANDOFF_PRODUCER_ATTEMPT}/"');
        // manifest-before-DATA guard: the shard objects are produced by the needs-gated matrix job.
        expect(save).toContain('needs: [check-upstream, matrix-shards]');
    });
    it('REQ-7: mutable state/shards/ is NO LONGER a recovery input (a diagnostic copy may remain)', () => {
        expect(save).not.toContain('restore-dir state/shards/');
        expect(count(matrix, 'state/shards/shard-${{ matrix.shard }}.json.zst')).toBe(1); // diagnostic copy kept
    });
    it('REQ-7: a missing/extra shard member or a manifest not built from the exact 0..19 range reds this', () => {
        // exact 20-range literal — length!=20 (missing/extra) or a hand-listed set changes this string.
        expect(save).toContain("const files=Array.from({length:20},(_,i)=>'shard-'+i+'.json.zst')");
        const noteLine = strictRestoreDirLines(save).find((l) => l.includes('"${STAGING}" artifacts/'));
        expect(noteLine, 'exact-prefix strict restore present').toBeTruthy();
    });
});

describe('STRICT-TOPOLOGY (b/c) cycle-output — producer read-back + 4 consumers to exact cache/ (aggregate + upload)', () => {
    const finalize = jobBlock(aggYml, 'finalize');
    it('REQ-4/5: the 3/4 producer read-back restores the EXACT cache/ sub-prefix, never the bare root', () => {
        expect(count(finalize, 'restore-dir "${STAGING}cache/" "${RB_DIR}/cache/" --strict')).toBe(1);
        expect(finalize).not.toContain('restore-dir "${STAGING}" "${RB_DIR}" --strict');
    });
    it('REQ-4/8: all FOUR 4/4 consumers recover the EXACT cache/ sub-prefix into output/cache/, wipe-scoped', () => {
        expect(count(uploadYml, 'restore-dir "${STAGING_PREFIX}cache/" output/cache/ --strict')).toBe(4);
        expect(uploadYml).not.toContain('restore-dir "$STAGING_PREFIX" output/ --strict');
        for (const name of ['mesh-baking', 'master-fusion-compute', 'vfs-pack-db', 'upload']) {
            const job = jobBlock(uploadYml, name);
            const s = job.indexOf('Verify or Recover Cycle Output from R2 Authority (FIX-2 / D-264)');
            const rest = job.slice(s);
            const e = rest.indexOf('recovered + verified cycle-output from exact staging');
            const region = e < 0 ? rest : rest.slice(0, e + 60);
            expect(region, `${name} recovers cache/`).toContain('restore-dir "${STAGING_PREFIX}cache/" output/cache/ --strict');
            // REQ-8: cycle-output recovery wipes ONLY output/cache/, NEVER output/data/.
            expect(region).toContain('rm -rf output/cache; mkdir -p output/cache');
            expect(region).not.toMatch(/rm -rf output\/data/);
            expect(region).not.toContain('restore-dir "${STAGING_PREFIX}cache/" output/data');
        }
    });
});

describe('STRICT-TOPOLOGY (c) mesh-profile — 3 consumers to exact profile-shards/ + dict (factory-upload.yml)', () => {
    it('REQ-4: each of the 3 consumers restores the EXACT profile-shards/ sub-prefix (never the bare mesh root)', () => {
        expect(count(uploadYml, 'restore-dir "${STAGING_PREFIX}profile-shards/" output/cache/mesh/profile-shards/ --strict')).toBe(3);
        expect(uploadYml).not.toContain('restore-dir "$STAGING_PREFIX" output/cache/mesh/ --strict');
    });
    it('REQ-6: each of the 3 consumers restores the evidence dict EXPLICITLY + exactly (deleting one reds this)', () => {
        expect(count(uploadYml, 'restore-file "${STAGING_PREFIX}profile-evidence-dict.json.zst" output/cache/mesh/profile-evidence-dict.json.zst --strict')).toBe(3);
    });
    it('REQ-4/6: BOTH mesh recover restores at each of the 3 sites are EXPLICITLY fail-closed (|| { … exit 1 }); deleting a guard reds this', () => {
        // parity with the cycle-output consumers — an explicit AUTH-M fail-closed guard, never inherited -e / || true.
        expect(count(uploadYml, 'restore-dir "${STAGING_PREFIX}profile-shards/" output/cache/mesh/profile-shards/ --strict || { echo "::error::AUTH-M: mesh recovery restore failed')).toBe(3);
        expect(count(uploadYml, 'restore-file "${STAGING_PREFIX}profile-evidence-dict.json.zst" output/cache/mesh/profile-evidence-dict.json.zst --strict || { echo "::error::AUTH-M: mesh recovery restore failed')).toBe(3);
        expect(count(uploadYml, 'AUTH-M: mesh recovery restore failed')).toBe(6); // 3 sites x (restore-dir + restore-file)
    });
});

describe('STRICT-TOPOLOGY (d) harvest legacy ingestion/raw/ — manifest-impossible strict recovery removed', () => {
    it('REQ-5: the ingestion/raw/ strict recovery is GONE; an empty authority output fails closed', () => {
        expect(harvestYml).not.toContain('restore-dir ingestion/raw/ data/ --strict');
        expect(harvestYml).toContain('authority-output inconsistency');
        // the fail-closed replacement lives in the else-branch of the four-source resolver's read-back.
        const step = harvestYml.slice(harvestYml.indexOf('name: R2 Batch Recovery (Fallback)'), harvestYml.indexOf('name: List Batches'));
        expect(step).toContain('exit 1');
        expect(step).not.toContain('restore-dir ingestion/raw/');
    });
    it('the ingestion/raw/ WRITE stream (producer uploads) is untouched', () => {
        expect(harvestYml).toContain('ingestion/raw/huggingface_master.ndjson');
    });
});

describe('STRICT-TOPOLOGY scope guard — strict semantics + forbidden surfaces unchanged', () => {
    it('r2-handoff.js keeps the exact-prefix _manifest.json contract + strict fail-closed (no LIST bypass)', () => {
        const lib = fs.readFileSync(path.resolve(__dirname, '../../scripts/factory/lib/r2-handoff.js'), 'utf8');
        expect(lib).toContain("r2Prefix + '_manifest.json'");
        expect(lib).toContain("reason: 'manifest_required_strict'");
    });
    it('r2-workflow-cli.js restore-dir strict exit is decided by result.success (no re-added LIST fallback)', () => {
        const cli = fs.readFileSync(path.resolve(__dirname, '../../scripts/factory/r2-workflow-cli.js'), 'utf8');
        expect(cli).toContain('if (strict && !result?.success) { console.error');
        expect(cli).not.toContain('recursively');
    });
});
