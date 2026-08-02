// tests/unit/vfs-derived-timeout-budget-workflow.test.ts
// T-1 (2026-08-01 VFS Derived timeout repair). STATIC workflow invariants pinning the
// MEASURED 60-minute job budget, the tied VFS_DERIVED_TIMEOUT_MIN telemetry value, the two
// new STEP-level ceilings, and the ABSENCE of the two obsolete runtime claims.
//
// Evidence anchor: run 30630342243 (2026-07-31) — VFS Derived cancelled at 30m09s with only
// 81 of 98 databases health-verified. The three preceding successes measured 25m38s / 25m39s
// / 26m27s = 85.4% / 85.5% / 88.2% of the OLD 30-minute ceiling.
//
// Reader design: INDENTATION-ANCHORED, following the precedent in
// tests/unit/harvest-arxiv-slow-tail-boundaries.test.ts. No YAML library is imported (`yaml`
// and `js-yaml` are transitive-only and absent from package.json, so importing one here would
// smuggle in an undeclared dependency). Anchoring is strictly STRONGER than substring
// matching: a value inside a COMMENT can never satisfy `^ {n}key:`, and a value belonging to a
// LATER step is outside the sliced block entirely. That matters acutely here — the repaired
// job legitimately contains a STEP-level `timeout-minutes: 30`, so a naive
// `toContain('timeout-minutes: 30')` would pass for the WRONG REASON.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WF = path.resolve(__dirname, '../../.github/workflows/factory-upload.yml');
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n'); // checkout is CRLF; anchor on LF

/** Slice the block introduced by `header` at `indent`, ending at the next equal-or-shallower line. */
function block(src: string, header: string, indent: number): string {
    const lines = src.split('\n');
    const start = lines.indexOf(' '.repeat(indent) + header);
    expect(start, `block header not found: "${header}" at indent ${indent}`).toBeGreaterThan(-1);
    const shallower = new RegExp(`^ {0,${indent}}[^\\s#]`);
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim() && shallower.test(lines[i])) return lines.slice(start, i).join('\n');
    }
    return lines.slice(start).join('\n');
}

/** Read a numeric key the block OWNS at exactly `indent` (never a comment, never a nested key). */
function ownNumber(src: string, key: string, indent: number): number | null {
    const m = src.match(new RegExp(`^ {${indent}}${key}: *(\\d+) *(#.*)?$`, 'm'));
    return m ? Number(m[1]) : null;
}

/** The `- name: X` step block inside a job's steps list (6-space list indent). */
function step(job: string, name: string): string {
    const lines = job.split('\n');
    const start = lines.indexOf(`      - name: ${name}`);
    expect(start, `step not found: ${name}`).toBeGreaterThan(-1);
    for (let i = start + 1; i < lines.length; i++) {
        if (/^ {6}- /.test(lines[i])) return lines.slice(start, i).join('\n');
    }
    return lines.slice(start).join('\n');
}

/** The contiguous comment lines IMMEDIATELY above a block header (the job's doc block). */
function precedingComments(src: string, header: string, indent: number): string {
    const lines = src.split('\n');
    const start = lines.indexOf(' '.repeat(indent) + header);
    expect(start, `block header not found: "${header}"`).toBeGreaterThan(-1);
    let i = start;
    while (i > 0 && lines[i - 1].startsWith(`${' '.repeat(indent)}#`)) i--;
    return lines.slice(i, start).join('\n');
}

const derived = block(yml, 'vfs-derived:', 2);
// The JOB's OWN region, read from ABOVE `steps:` so no step can supply a job-level key.
const derivedHead = derived.slice(0, derived.indexOf('\n    steps:'));
// The job's documentation block lives ABOVE the `vfs-derived:` key, so it is NOT part of
// `derived`. The evidence anchor is asserted against this slice specifically.
const derivedDoc = precedingComments(yml, 'vfs-derived:', 2);

describe('T-1 VFS Derived job budget — the 60-minute ceiling is OWNED, not merely present', () => {
    it('the vfs-derived JOB owns timeout-minutes 60 (not 30, not a step-level value)', () => {
        expect(ownNumber(derivedHead, 'timeout-minutes', 4)).toBe(60);
        // The stale value must not survive at JOB level. This is the assertion a naive
        // whole-job `toContain('timeout-minutes: 30')` cannot make, because the repaired job
        // deliberately carries a STEP-level 30 on the D-245 recovery step.
        expect(ownNumber(derivedHead, 'timeout-minutes', 4)).not.toBe(30);
        expect(derivedHead).not.toMatch(/^ {4}timeout-minutes: 30 *$/m);
    });

    it('the tied telemetry budget VFS_DERIVED_TIMEOUT_MIN exists and is NUMERICALLY EQUAL to the literal', () => {
        // ANTI-DRIFT TIE. GitHub does not expose the `env` context to a job-level
        // `timeout-minutes:` key, so the duplicate is deliberate; this test is the only thing
        // preventing the two from silently diverging.
        const m = derivedHead.match(/^ {6}VFS_DERIVED_TIMEOUT_MIN: '(\d+)'$/m);
        expect(m, 'job env VFS_DERIVED_TIMEOUT_MIN not found at 6-space indent').not.toBeNull();
        expect(Number(m![1])).toBe(60);
        expect(Number(m![1])).toBe(ownNumber(derivedHead, 'timeout-minutes', 4));
    });

    it('the env value lives in the JOB block, above steps: (a step env cannot satisfy the budget reporter)', () => {
        expect(derivedHead).toMatch(/^ {4}env:$/m);
        expect(derivedHead).toContain("VFS_DERIVED_TIMEOUT_MIN: '60'");
    });
});

describe('T-1 STEP-level ceilings — the two hang paths fail BEFORE the job ceiling', () => {
    it('the D-245 R2 recovery step OWNS timeout-minutes 30 (worst observed 17m02s -> 1.76x)', () => {
        const s = step(derived, 'Verify or Recover VFS Pack from Exact Staging (D-245)');
        // right step: the R2 exact-staging role restores are its body
        expect(s).toContain('restore-dir "${STAGING_PREFIX}meta/" output/data/ --strict');
        expect(ownNumber(s, 'timeout-minutes', 8)).toBe(30);
    });

    it('the V23.1 SQL Health Check step OWNS timeout-minutes 25 (full-set projection 13m06s -> 1.91x)', () => {
        const s = step(derived, 'V23.1 SQL Health Check');
        expect(s).toContain('node scripts/factory/verify-db.js'); // right step
        expect(ownNumber(s, 'timeout-minutes', 25 - 17)).toBe(25); // indent 8
    });

    it('both step ceilings sit strictly below the job ceiling (otherwise they are unreachable)', () => {
        const job = ownNumber(derivedHead, 'timeout-minutes', 4)!;
        const rec = ownNumber(step(derived, 'Verify or Recover VFS Pack from Exact Staging (D-245)'), 'timeout-minutes', 8)!;
        const sql = ownNumber(step(derived, 'V23.1 SQL Health Check'), 'timeout-minutes', 8)!;
        expect(rec).toBeLessThan(job);
        expect(sql).toBeLessThan(job);
        // and their SUM must not exceed the job ceiling, or a slow-but-not-hung pair of phases
        // would still be cancelled at job level rather than failing at step level.
        expect(rec + sql).toBeLessThanOrEqual(job);
    });
});

describe('T-1 obsolete runtime claims are GONE and replaced by a re-derivable evidence anchor', () => {
    it('the "~2m" runtime claim is ABSENT from the whole workflow', () => {
        // It was wrong by a factor of ~13 and is the documentation defect that let the budget
        // erosion (85-88% of ceiling on every success) go unobserved for four cycles.
        expect(yml).not.toContain('~2m');
    });

    it('the obsolete "vfs-pack cache hits within ~5min window" claim is ABSENT', () => {
        // The intra-4-4 vfs-pack GHA cache has been write-denied for at least four consecutive
        // cycles and never hits; R2 exact-staging recovery is the PERMANENT path.
        expect(yml).not.toContain('vfs-pack cache hits within ~5min window');
        expect(derivedDoc).toContain('cache-hit recovery claim is WITHDRAWN as obsolete');
        expect(derivedDoc).toContain('cache write denied: token has no writable scopes');
    });

    it('the replacement comment carries the evidence anchor so the number is RE-DERIVABLE', () => {
        // DOCUMENTATION-DRIFT TIE: changing the budget without updating the evidence reds this.
        expect(derivedDoc).toContain('30630342243');       // the timeout incident run
        expect(derivedDoc).toContain('81 of 98');          // the measured coverage shortfall
        expect(derivedDoc).toContain('25m38s');            // measured successes
        expect(derivedDoc).toContain('26m27s');
        expect(derivedDoc).toContain('34m32s');            // worst-observed component sum
        expect(derivedDoc).toContain('44m51s');            // variance + growth model
        expect(derivedDoc).toContain('1.74x');             // margin vs worst observed
        expect(derivedDoc).toContain('1.34x');             // margin vs growth model
        expect(derivedDoc).toContain('90 minutes has');
        expect(derivedDoc).toContain('NO measurement behind it');
    });

    it('#NEG the rejected alternatives are never adopted as the literal ceiling', () => {
        expect(derived).not.toMatch(/^ {4}timeout-minutes: 90 *$/m);
        expect(derived).not.toMatch(/^ {4}timeout-minutes: 35 *$/m);
        expect(derived).not.toMatch(/^ {4}timeout-minutes: 45 *$/m);
    });
});

describe('T-1 READER anti-vacuity — the anchored reader rejects the two weakenings', () => {
    it('a commented value and a later-step value can never satisfy ownNumber', () => {
        const fake = [
            '  vfs-derived:', '    name: VFS Derived', '    timeout-minutes: 60',
            '    # timeout-minutes: 30', '    env:', "      VFS_DERIVED_TIMEOUT_MIN: '60'",
            '    steps:',
            '      - name: Verify or Recover VFS Pack from Exact Staging (D-245)',
            '        timeout-minutes: 30',
            '      - name: V23.1 SQL Health Check', '        timeout-minutes: 25', '',
        ].join('\n');
        const job = block(fake, 'vfs-derived:', 2);
        const head = job.slice(0, job.indexOf('\n    steps:'));
        expect(ownNumber(head, 'timeout-minutes', 4)).toBe(60);      // NOT the commented 30
        expect(head).toContain('# timeout-minutes: 30');             // the comment IS present...
        expect(ownNumber(head, 'timeout-minutes', 4)).not.toBe(30);  // ...and still does not count
        // and the STEP-level 30 does not leak upward into the job-level read
        expect(ownNumber(step(job, 'Verify or Recover VFS Pack from Exact Staging (D-245)'), 'timeout-minutes', 8)).toBe(30);
        expect(ownNumber(step(job, 'V23.1 SQL Health Check'), 'timeout-minutes', 8)).toBe(25);
    });

    it('#NEG a job that reverted to 30 reds the job-level assertion (mutation proof)', () => {
        const reverted = derivedHead.replace(/^ {4}timeout-minutes: 60 *$/m, '    timeout-minutes: 30');
        expect(reverted).not.toBe(derivedHead); // the mutation actually applied
        expect(ownNumber(reverted, 'timeout-minutes', 4)).toBe(30);
        expect(ownNumber(reverted, 'timeout-minutes', 4)).not.toBe(60);
    });

    it('#NEG a drifted VFS_DERIVED_TIMEOUT_MIN reds the numeric tie (mutation proof)', () => {
        const drifted = derivedHead.replace("VFS_DERIVED_TIMEOUT_MIN: '60'", "VFS_DERIVED_TIMEOUT_MIN: '30'");
        expect(drifted).not.toBe(derivedHead);
        const m = drifted.match(/^ {6}VFS_DERIVED_TIMEOUT_MIN: '(\d+)'$/m);
        expect(Number(m![1])).not.toBe(ownNumber(derivedHead, 'timeout-minutes', 4));
    });
});
