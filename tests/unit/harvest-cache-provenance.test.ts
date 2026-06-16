// tests/unit/harvest-cache-provenance.test.ts
// WO-3-B1 PR-B1A — Attempt-Scoped Cache Provenance Gate invariant (Founder
// D-2026-0616-70 PART II). HERMETIC/STATIC: reads .github/workflows/factory-harvest.yml
// as TEXT (no workflow execution, no network, no YAML dep) and locks the
// run_attempt-scoped cache keys + the fail-closed complete-set gate.
//
// ROOT CAUSE (run 27604921700): the 4 harvest-group caches used a RUN-SCOPED
// IMMUTABLE key (github.run_id only). A rerun-failed-jobs attempt-2 could not
// overwrite the partial attempt-1 cache ("another job may be creating this
// cache"); Merge restored the stale attempt-1 -> partial arxiv + missing HF
// papers/datasets -> HARVEST_HEALTH=red. Fix = attempt-scoped EXACT keys (run_id
// + run_attempt) + a pre-merge 4/4-cache-hit gate that fail-louds on any miss
// BEFORE R2 fallback / NDJSON bridge / merge / health publication.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const WF = path.resolve(__dirname, '../../.github/workflows/factory-harvest.yml');
// Normalize CRLF -> LF so all text/line assertions are line-ending agnostic.
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');
const lines = yml.split('\n');

const GROUPS = ['huggingface', 'github', 'academic', 'ecosystem'] as const;

// The exact attempt-scoped current-run key per group (the contract this WO sets).
function currentKey(group: string): string {
    return `key: harvest-raw-${group}-\${{ github.run_id }}-attempt-\${{ github.run_attempt }}`;
}
// The exact source-attempt key per group (skip_harvest recovery path).
function sourceKey(group: string): string {
    return `key: harvest-raw-${group}-\${{ github.event.inputs.source_run_id }}-attempt-\${{ github.event.inputs.source_run_attempt }}`;
}

// All literal `key:` lines that reference a harvest-raw cache (save OR restore).
function harvestRawKeyLines(): string[] {
    return lines
        .map((l) => l.trim())
        .filter((l) => l.startsWith('key: harvest-raw-'));
}

// Helper: index of the FIRST line whose trimmed text contains `name: <stepName>`.
function stepLineIdx(stepName: string): number {
    return lines.findIndex((l) => l.includes(`name: ${stepName}`));
}

describe('WO-3-B1 PR-B1A — attempt-scoped cache keys', () => {
    // #1 — all 4 SAVE keys carry BOTH run_id and run_attempt.
    it('#1 all 4 Solidify save keys carry both run_id AND run_attempt', () => {
        for (const g of GROUPS) {
            // The save step lives under "Solidify <Group> Batches (Cache)".
            expect(yml).toContain(currentKey(g));
        }
        // Save context: each appears in/after an actions/cache/save@ block.
        expect(yml).toContain('actions/cache/save@v5');
    });

    // #11 NEGATIVE — the assertion is provably tied to run_attempt presence:
    // strip `-attempt-${{ github.run_attempt }}` from any current key and the
    // exact-key contract no longer holds. We model this by asserting the bare
    // run-id-only form is ABSENT and that removing the attempt segment from the
    // checked string fails the contains() check.
    it('#11 NEGATIVE: no current harvest-raw key uses the run-id-only (no run_attempt) form', () => {
        // CRLF-robust, line-level: a current-run key line trimmed must EQUAL the
        // full attempt-scoped form and NEVER the bare run-id-only form. Stripping
        // `-attempt-${{ github.run_attempt }}` from any of the 4 keys leaves a line
        // whose trimmed text == the bare form, which this assertion rejects.
        for (const g of GROUPS) {
            const bare = `key: harvest-raw-${g}-\${{ github.run_id }}`;
            const full = currentKey(g);
            // No key LINE may be the bare run-id-only form.
            const bareLineExists = lines.some((l) => l.trim() === bare);
            expect(bareLineExists).toBe(false);
            // The full attempt-scoped form IS present as a key line (positive tie:
            // removing run_attempt makes this assertion fail).
            const fullLineExists = lines.some((l) => l.trim() === full);
            expect(fullLineExists).toBe(true);
        }
    });

    // #2 / #13 — the Solidify/save steps retain `if: always()` (H2c: failed-class
    // terminal sidecars must still be saved even on a failed-loud harvest).
    it('#2/#13 all 4 Solidify save steps retain if: always() (failed-harvest sidecar still saved)', () => {
        const guard = "if: always() && github.event.inputs.skip_harvest != 'true'";
        const count = lines.filter((l) => l.trim() === guard).length;
        expect(count).toBe(4);
    });
});

describe('WO-3-B1 PR-B1A — exact-only current-run restores', () => {
    // #3 — the 4 Merge current restore keys are byte-identical to the 4 save keys.
    it('#3 the 4 Merge current-run restore keys equal the 4 save keys (byte-identical, attempt-scoped)', () => {
        for (const g of GROUPS) {
            // Both the save AND the restore use the identical attempt-scoped key
            // string. There must be >= 2 occurrences (1 save + 1 restore).
            const occurrences = yml.split(currentKey(g)).length - 1;
            expect(occurrences).toBeGreaterThanOrEqual(2);
        }
    });

    // #4 / #12 NEGATIVE — the current restore steps have NO restore-keys prefix;
    // converting any to a prefix restore would reintroduce stale-cache substitution.
    it('#4/#12 NEGATIVE: no harvest-raw restore uses a restore-keys: prefix (exact-only)', () => {
        // The legacy stale-substitution vector: `restore-keys: harvest-raw-...`.
        expect(/restore-keys:\s*harvest-raw-/.test(yml)).toBe(false);
        // Belt-and-braces: no harvest-raw key line is followed by a restore-keys line.
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith('key: harvest-raw-')) {
                const next = (lines[i + 1] || '').trim();
                expect(next.startsWith('restore-keys')).toBe(false);
            }
        }
    });

    // #7/#8 (model) — the key encodes run_attempt, which is precisely what makes a
    // rerun-failed-jobs attempt unable to consume an attempt-1 cache while a
    // rerun-all attempt (new run_id) gets its own clean set.
    it('#7/#8 every harvest-raw key encodes run_attempt (current) or source_run_attempt (skip)', () => {
        const keys = harvestRawKeyLines();
        expect(keys.length).toBeGreaterThanOrEqual(12); // 4 save + 4 current restore + 4 source recover
        for (const k of keys) {
            const hasCurrentAttempt = k.includes('attempt-${{ github.run_attempt }}');
            const hasSourceAttempt = k.includes('attempt-${{ github.event.inputs.source_run_attempt }}');
            expect(hasCurrentAttempt || hasSourceAttempt).toBe(true);
        }
    });
});

describe('WO-3-B1 PR-B1A — complete-set gate (fail-closed, before merge)', () => {
    const gateName = 'Attempt Cache Provenance Gate (4/4 exact hits required)';

    // #5 — a complete-set gate requiring 4/4 cache-hit exists with the
    // ATTEMPT_CACHE_SET_INCOMPLETE token + exit 1, and PRECEDES merge/bridge/R2.
    it('#5 a 4/4 complete-set gate exists with ATTEMPT_CACHE_SET_INCOMPLETE + exit 1', () => {
        expect(yml).toContain(gateName);
        expect(yml).toContain('ATTEMPT_CACHE_SET_INCOMPLETE');
        const gateIdx = stepLineIdx(gateName);
        expect(gateIdx).toBeGreaterThan(0);
        // The gate block must contain an `exit 1` (fail-loud short-circuit).
        const gateBlock = yml.slice(yml.indexOf(gateName), yml.indexOf(gateName) + 2000);
        expect(gateBlock).toContain('exit 1');
    });

    // #6 (model) — the gate logic references ALL FOUR group hits and fails if any
    // is not 'true' (3/4 -> ATTEMPT_CACHE_SET_INCOMPLETE).
    it('#6 the gate logic references all 4 group cache-hit outputs and any non-true fails it', () => {
        const gateBlock = yml.slice(yml.indexOf(gateName), yml.indexOf(gateName) + 1500);
        // All 4 restore step outputs are consumed.
        expect(gateBlock).toContain('steps.restore_hf.outputs.cache-hit');
        expect(gateBlock).toContain('steps.restore_github.outputs.cache-hit');
        expect(gateBlock).toContain('steps.restore_academic.outputs.cache-hit');
        expect(gateBlock).toContain('steps.restore_ecosystem.outputs.cache-hit');
        // Each group is checked == 'true' and any miss accumulates into MISSED then exit 1.
        expect((gateBlock.match(/= "true" \]/g) || []).length).toBe(4);
        expect(gateBlock).toContain('exit 1');
    });

    // #9 — the normal-path R2 fallback (and the bridge + merge) are gated BEHIND
    // the complete-set gate: the gate step is positioned before them, and its
    // exit 1 short-circuits the job so they never run on an incomplete set.
    it('#9 R2 fallback + NDJSON bridge + merge all come AFTER the complete-set gate', () => {
        const gateIdx = stepLineIdx(gateName);
        const r2Idx = stepLineIdx('R2 Batch Recovery (Fallback)');
        const bridgeIdx = stepLineIdx('List Batches (Current or Recovered)');
        const mergeIdx = stepLineIdx('Merge Batches');
        expect(gateIdx).toBeGreaterThan(0);
        expect(r2Idx).toBeGreaterThan(gateIdx);
        expect(bridgeIdx).toBeGreaterThan(gateIdx);
        expect(mergeIdx).toBeGreaterThan(gateIdx);
    });

    // The current-run gate must also come AFTER all 4 current restore steps.
    it('#5b the gate is placed after all 4 current-run restore steps', () => {
        const gateIdx = stepLineIdx(gateName);
        for (const id of ['restore_hf', 'restore_github', 'restore_academic', 'restore_ecosystem']) {
            const idIdx = lines.findIndex((l) => l.trim() === `id: ${id}`);
            expect(idIdx).toBeGreaterThan(0);
            expect(idIdx).toBeLessThan(gateIdx);
        }
    });
});

describe('WO-3-B1 PR-B1A — skip_harvest source-attempt provenance', () => {
    // #10 — skip_harvest requires source_run_attempt and recovers via the EXACT
    // source-attempt key (no prefix), with its own fail-closed 4/4 gate.
    it('#10 skip_harvest declares a source_run_attempt input and uses exact source-attempt keys', () => {
        // The new input is declared.
        expect(yml).toContain('source_run_attempt:');
        // The 4 recovery restores use the exact source-attempt key (no prefix).
        for (const g of GROUPS) {
            expect(yml).toContain(sourceKey(g));
        }
    });

    it('#10b skip_harvest hard-requires BOTH inputs + a 4/4 source-attempt gate (fail-loud)', () => {
        expect(yml).toContain('SOURCE_ATTEMPT_PROVENANCE_INCOMPLETE');
        // Pre-check: both inputs required.
        const preIdx = stepLineIdx('Source Attempt Provenance Pre-Check (skip_harvest)');
        expect(preIdx).toBeGreaterThan(0);
        const preBlock = yml.slice(yml.indexOf('Source Attempt Provenance Pre-Check'), yml.indexOf('Source Attempt Provenance Pre-Check') + 900);
        expect(preBlock).toContain('source_run_id');
        expect(preBlock).toContain('source_run_attempt');
        expect(preBlock).toContain('exit 1');
        // Source gate: 4/4 exact hits.
        const sgate = 'Source Attempt Provenance Gate (4/4 exact hits required)';
        expect(yml).toContain(sgate);
        const sBlock = yml.slice(yml.indexOf(sgate), yml.indexOf(sgate) + 1300);
        for (const id of ['recover_hf', 'recover_github', 'recover_academic', 'recover_ecosystem']) {
            expect(sBlock).toContain(`steps.${id}.outputs.cache-hit`);
        }
        expect(sBlock).toContain('exit 1');
    });
});

describe('WO-3-B1 PR-B1A — scope guard (#14: no floor/health/adapter/timeout/R2-object change)', () => {
    // #14 — the WO is narrow: it does NOT touch the merge entity floor, the health
    // threshold, adapter code, job timeouts, or the R2 object hierarchy. This is a
    // SCOPE assertion over the workflow: those load-bearing strings are unchanged
    // and PRESENT exactly as before (this test introduces no edits to them).
    it('#14 merge floor 85000 + health summary + per-job timeouts + R2 object paths unchanged', () => {
        // Merge entity floor (untouched).
        expect(yml).toContain('-lt 85000');
        // Harvest health summary step (untouched observation layer).
        expect(yml).toContain('Harvest Health Summary');
        // Per-job timeout-minutes unchanged (the 4 harvest jobs + merge).
        expect(yml).toContain('timeout-minutes: 330');
        expect(yml).toContain('timeout-minutes: 300');
        expect(yml).toContain('timeout-minutes: 120');
        // R2 fixed-key object hierarchy unchanged (no attempt-scoped R2 — PR-B1B).
        expect(yml).toContain('ingestion/raw/');
        expect(yml).toContain('state/harvest-health/latest.json');
        // This test asserts ONLY the workflow text; it does not import or touch any
        // adapter / floor / health module (hermetic, no product logic re-implemented).
    });
});
