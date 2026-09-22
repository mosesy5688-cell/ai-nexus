/**
 * Work order N -- the two places where the gate MACHINERY could be vacuous.
 *
 * WHY A SEPARATE FILE: isolation-launcher-hygiene.test.ts reached the CES
 * monolith limit (MAX_LINES=250, and IGNORE_DIRS does not include tests/), so
 * this contract is split out rather than compressed away. It is the anti-vacuity
 * counterpart for the launcher's own fault and artifact plumbing, next to the
 * anti-vacuity file for the boundary precondition
 * (isolation-boundary-precondition.test.ts, ruling D d5).
 *
 * WHAT IT PROVES
 *   b4  the classified-masking counterexample has a variant that makes mount(8)
 *       REALLY fail, not only a bookkeeping flag that marks a failure without
 *       calling mount at all. Without it, "a masking failure aborts the run"
 *       would be tested only against a simulated failure -- the defect pattern
 *       ruling D names, one level down.
 *   c5  attribution.txt is emitted on EVERY terminal path, including the gates
 *       that stop before establishment, and generating it cannot change the
 *       outcome.
 *   N   the establish stage's TWO controlled-ns readiness failures keep two
 *       DISTINCT strings. Nothing pinned them, so a later edit could converge
 *       them and lose the difference between "no live child was ever seen"
 *       and "seen, but its unshare(2) never took".
 *
 * WHAT IT DOES NOT PROVE: that any of it executes. These are static checks;
 * the runtime proof needs a Linux runner (ruling B1).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'scripts', 'ci', 'isolation');
const read = (f: string): string =>
    fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n');

describe('b4: the masking counterexample is not only a flag', () => {
    it('a variant drives a REAL mount(8) failure through the ordinary path', () => {
        const mask = read('mask-channels.sh');
        expect(mask).toContain('mask-real');
        // tmpfs over a REGULAR FILE: the kernel refuses, so the rc comes from
        // mount itself and travels the same code path a genuine failure would.
        expect(mask).toContain('_f2ai_mask_one TMPFS_DIR "$bait"');
        expect(mask).toContain("printf 'b4 real-mount-failure bait");
        expect(read('counterexamples.sh')).toContain('F2AI_ISO_FAULT=mask-real');
    });

    it('both knobs can only ADD a failure, never let a run continue', () => {
        const mask = read('mask-channels.sh');
        // Even the case where the bait mount unexpectedly SUCCEEDS counts as a
        // failure, and says so in the report, so the knob can never be the
        // reason establishment is allowed to proceed.
        expect(mask).toContain('REAL_FAULT_DID_NOT_FAIL');
        const body = mask.slice(mask.indexOf('= mask-real'));
        expect(body).toContain('failures=$((failures + 1))');
        expect(body).not.toMatch(/failures=0|return 0/);
        // And neither knob may skip a masking and carry on.
        expect(mask).not.toMatch(/fault.*=.*skip/i);
    });

    it('the real variant asserts the same outcome as the flag variant', () => {
        const src = read('counterexamples.sh');
        const b4r = src.slice(src.indexOf('new_case b4r'));
        expect(b4r).toContain('F2AI_ISO_RC_ESTABLISH');
        expect(b4r).toContain('MASK_FAILED');
        expect(b4r).toContain("expect_no_grep 'REAL_FAULT_DID_NOT_FAIL'");
        // The audit must not have started: asserted from the file phase C
        // creates the moment it runs, not from a missing log line.
        expect(b4r).toContain('selftest.stdout.txt');
        expect(b4r).toContain('phaseC.rc');
    });
});

describe('c5: the attribution artifact exists for every terminal outcome', () => {
    it('fail() emits it too, not only the normal tail', () => {
        // Emitting it only on the tail would leave the file CI reads missing
        // exactly when the run failed earliest, and the classification would
        // fall back to the exit code -- which c1 rules out.
        const src = read('netns-launch.sh');
        expect(src).toMatch(/^fail\(\) \{.*f2ai_finalize "\$2".*exit "\$2"; \}$/m);
        expect(src).toMatch(/^f2ai_finalize "\$CHILD_RC"$/m);
    });

    it('generating it cannot change the outcome', () => {
        const fin = read('finalize.sh');
        expect(fin).toContain('return 0');
        expect(fin).not.toMatch(/^\s*exit\b/m);
        // The generator's status is discarded, never propagated.
        expect(fin).toMatch(/attribute\.mjs" "\$EVID" >>"\$LOG" 2>&1 \|\| rec /);
        const src = read('netns-launch.sh');
        expect(src.indexOf('f2ai_finalize "$CHILD_RC"'))
            .toBeLessThan(src.lastIndexOf('exit "$CHILD_RC"'));
    });

    it('the earliest gate is covered by an executable expectation', () => {
        // F1 stops in the launcher itself, before establishment. It is the case
        // that would be missing the artifact, so it asserts the artifact.
        const src = read('counterexamples.sh');
        const f1 = src.slice(src.indexOf('new_case f1'), src.indexOf('new_case f2'));
        expect(f1).toContain('expect_present "$CASE_EVID/attribution.txt"');
    });
});

describe('WO-N: the two controlled-ns readiness failures stay distinguishable', () => {
    it('each timeout keeps its own string and the merged one is gone', () => {
        // "no live child was ever observed" and "observed, but its unshare(2)
        // never took" are DIFFERENT diagnoses. The pre-fix code could emit the
        // second for a child that was merely not scheduled yet, so the merged
        // wording must not come back either.
        const src = read('netns-establish.sh');
        expect(src).toContain('controlled test namespace did not come up');
        expect(src).toContain('controlled ns never diverged from subtree');
        expect(src).not.toContain('controlled ns equals subtree ns');
    });

    it('both abort at the ESTABLISH exit code, before the privilege drop', () => {
        const src = read('netns-establish.sh');
        expect(src).toMatch(
            /fail "controlled test namespace did not come up" "\$F2AI_ISO_RC_ESTABLISH"/);
        expect(src).toMatch(
            /fail "controlled ns never diverged from subtree" "\$F2AI_ISO_RC_ESTABLISH"/);
        // WO-N-P3 (7) M9. The ordering assertion is TWO-SIDED. Only the second
        // string's position used to be checked, so moving just the first guard
        // past the privilege drop -- where a failure can no longer abort at the
        // establish identity -- stayed green.
        const drop = src.indexOf('N2-1/N2-2 privilege drop');
        const seen = src.indexOf('controlled test namespace did not come up');
        const diverged = src.indexOf('controlled ns never diverged from subtree');
        expect(drop).toBeGreaterThan(0);
        expect(seen).toBeGreaterThan(0);
        expect(diverged).toBeGreaterThan(0);
        expect(seen).toBeLessThan(drop);
        expect(diverged).toBeLessThan(drop);
    });

    it('each string stays bound to ITS OWN condition', () => {
        // WO-N-P3 (7) M6. The two strings and the two guards used to be
        // asserted separately, so swapping the wordings between the guards --
        // which inverts both diagnoses -- kept every assertion satisfied. The
        // condition and its wording are now pinned as one unit.
        const src = read('netns-establish.sh');
        expect(src).toMatch(
            /\[ "\$CTRL_SEEN" -eq 1 \] \|\| \\\n\s*fail "controlled test namespace did not come up"/);
        expect(src).toMatch(
            /\[ "\$CTRL_NS" != "\$SUB_NETNS" \] \|\| \\\n\s*fail "controlled ns never diverged from subtree"/);
    });

    it('WO-N-P3 (6): the control namespace may not be the HOST namespace', () => {
        // The header comment claimed HOST_NETNS was deliberately not compared.
        // A control namespace that IS the host makes the escape check a live
        // attempt on the host, so the comment and the code now agree on one
        // enforced invariant, asserted here with its guard.
        const src = read('netns-establish.sh');
        expect(src).toMatch(
            /\[ "\$CTRL_NS" != "\$HOST_NETNS" \] \|\| \\\n\s*fail "controlled ns is the host netns" "\$F2AI_ISO_RC_ESTABLISH"/);
        expect(src.indexOf('controlled ns is the host netns'))
            .toBeLessThan(src.indexOf('N2-1/N2-2 privilege drop'));
    });
});
