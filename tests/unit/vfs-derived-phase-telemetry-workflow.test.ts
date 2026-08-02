// tests/unit/vfs-derived-phase-telemetry-workflow.test.ts
// T-3 (2026-08-01 VFS Derived timeout repair). Phase marks, the path line, and the budget
// reporter — plus the TRUTHFUL execution boundary.
//
// THE BOUNDARY THIS FILE ENFORCES (a mandatory correction to the original proposal):
//   reporter execution is REQUIRED after an ordinary step failure and after a STEP-level
//   timeout where the runner remains available;
//   JOB-LEVEL CANCELLATION REPORTING IS BEST-EFFORT.
// After a job-level `timeout-minutes` expiry, an external cancellation, or runner loss,
// GitHub may cancel the whole job and no subsequent `if: always()` step is guaranteed an
// execution slot. The two new STEP-level timeouts (30 min D-245 recovery, 25 min SQL health)
// are valuable because they convert the main hang paths into `failure` BEFORE the 60-minute
// job ceiling, which RAISES THE PROBABILITY the reporter runs — a probability improvement,
// NOT a guarantee. This file asserts that boundary is stated and that the overclaim is absent.
//
// Erosion context: on the 2026-07-28/29/30 successes this reporter would have printed
// used_pct 88.2 / 85.4 / 85.5 and raised the CRITICAL warning EVERY TIME. The erosion was
// fully measurable and simply was not measured.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WF = path.resolve(__dirname, '../../.github/workflows/factory-upload.yml');
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

function block(src: string, header: string, indent: number): string {
    const lines = src.split('\n');
    const start = lines.indexOf(' '.repeat(indent) + header);
    expect(start, `block header not found: "${header}"`).toBeGreaterThan(-1);
    const shallower = new RegExp(`^ {0,${indent}}[^\\s#]`);
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim() && shallower.test(lines[i])) return lines.slice(start, i).join('\n');
    }
    return lines.slice(start).join('\n');
}
function step(job: string, name: string): string {
    const lines = job.split('\n');
    const start = lines.indexOf(`      - name: ${name}`);
    expect(start, `step not found: ${name}`).toBeGreaterThan(-1);
    for (let i = start + 1; i < lines.length; i++) {
        if (/^ {6}- /.test(lines[i])) return lines.slice(start, i).join('\n');
    }
    return lines.slice(start).join('\n');
}
/** The contiguous comment lines IMMEDIATELY above a line (a job's or a step's doc block). */
function precedingComments(src: string, header: string, indent: number): string {
    const lines = src.split('\n');
    const start = lines.indexOf(' '.repeat(indent) + header);
    expect(start, `header not found: "${header}"`).toBeGreaterThan(-1);
    let i = start;
    while (i > 0 && lines[i - 1].startsWith(`${' '.repeat(indent)}#`)) i--;
    return lines.slice(i, start).join('\n');
}
/** Strip `#` prefixes and collapse whitespace so wrapped prose can be asserted as one line. */
function flat(text: string): string {
    return text.replace(/^[ \t]*#[ \t]?/gm, '').replace(/\s+/g, ' ').trim();
}
/** A step's `run:` body reduced to EXECUTABLE shell lines: blank lines and lines whose first
 *  non-space character is `#` are dropped. Commenting a guard out therefore REMOVES it from
 *  this text — which is precisely what makes the guard pins below comment-proof (F-1 / F-2).
 *  Guard TEXT existing somewhere in the step is NOT evidence that the guard still runs. */
function executableShell(stepText: string): string {
    const marker = '\n        run: |\n';
    const i = stepText.indexOf(marker);
    expect(i, 'step has no `run: |` body').toBeGreaterThan(-1);
    return stepText.slice(i + marker.length).split('\n')
        .filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).join('\n');
}

const derived = block(yml, 'vfs-derived:', 2);
const derivedDoc = precedingComments(yml, 'vfs-derived:', 2);
const reporter = step(derived, 'VFS Derived Phase + Budget Report');
const reporterDoc = precedingComments(derived, '- name: VFS Derived Phase + Budget Report', 6);
const reporterExec = executableShell(reporter);
const MARKS = '"$RUNNER_TEMP/vfs-derived-phases.tsv"';
const PHASES = ['setup', 'restore', 'sitemap', 'rss', 'mesh-profiles', 'sql-health', 'handoff', 'cache-persist'] as const;

describe('T-3 all eight declared phases emit a mark', () => {
    it.each(PHASES)('phase "%s" appends its mark to the shared TSV', (phase) => {
        expect(derived).toContain(`printf '%s\\t%s\\n' '${phase}' "$(date -u +%s)" >> ${MARKS}`);
    });

    it('there are EXACTLY eight marks — no phase declared twice, none missing', () => {
        const emitted = [...derived.matchAll(/printf '%s\\t%s\\n' '([a-z-]+)' "\$\(date -u \+%s\)" >> "\$RUNNER_TEMP\/vfs-derived-phases\.tsv"/g)]
            .map((m) => m[1]);
        expect(emitted.length).toBe(8);
        expect([...emitted].sort()).toEqual([...PHASES].sort());
        expect(new Set(emitted).size).toBe(8);
    });

    it('the reporter recognises exactly the same eight phase names (producer/consumer tie)', () => {
        expect(reporter).toContain('split("setup restore sitemap rss mesh-profiles sql-health handoff cache-persist", k, " ")');
        expect(reporter).toContain('MARK_UNKNOWN_PHASE');
    });

    it('the six inline marks are the FIRST executable line of their own run: body', () => {
        // A phase that executes therefore CANNOT omit its mark.
        for (const [stepName, phase] of [
            ['Generate VFS-Parity Sitemaps', 'sitemap'],
            ['V23.1 SQL Health Check', 'sql-health'],
        ] as const) {
            const body = step(derived, stepName).split('\n        run: |\n')[1];
            const exec = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
            expect(exec[0]).toMatch(/^set -/);
            expect(exec[1], `${stepName} does not mark ${phase} first`).toContain(`'${phase}'`);
        }
    });

    it('the two uses:-based phases get an adjacent run: mark step immediately before them', () => {
        expect(derived).toMatch(/- name: Phase Mark \(restore\)[\s\S]{0,260}- name: Restore VFS Pack Output from intra-cache/);
        expect(derived).toMatch(/- name: Phase Mark \(cache-persist\)[\s\S]{0,300}- name: Save VFS Assets to Cache/);
        expect(derived).toMatch(/steps:\n {6}# PHASE TELEMETRY \(1\/8\)[\s\S]{0,300}- name: Phase Mark \(setup\)/);
    });
});

describe('T-3 path telemetry — which restore path the cycle actually took is greppable', () => {
    it('both branches emit a machine-readable [VFS-DERIVED-PATH] line, unconditionally', () => {
        const recovery = step(derived, 'Verify or Recover VFS Pack from Exact Staging (D-245)');
        expect(recovery).toContain('[VFS-DERIVED-PATH] vfs_pack_source=r2-exact-staging-recovery');
        expect(recovery).toContain('[VFS-DERIVED-PATH] vfs_pack_source=gha-cache-fastpath');
        // emitted AFTER the verify/recover decision is final, so it reports the path taken
        expect(recovery.indexOf('[VFS-DERIVED-PATH]')).toBeGreaterThan(recovery.indexOf('NEED_RECOVER=1'));
    });
});

describe('T-3 the budget reporter exists, is always(), and warns on erosion', () => {
    it('the reporter is the LAST step of the job and carries if: always()', () => {
        expect(reporter).toContain('if: always()');
        const names = [...derived.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);
        expect(names[names.length - 1]).toBe('VFS Derived Phase + Budget Report');
    });

    it('it prints the budget line and both erosion thresholds as ::warning::', () => {
        expect(reporter).toContain('[VFS-DERIVED-BUDGET] total_elapsed_s=%d budget_s=%d used_pct=%.1f phases_marked=%d');
        expect(reporter).toContain('if (pct >= 85) printf "::warning::VFS Derived budget erosion CRITICAL:');
        expect(reporter).toContain('else if (pct >= 70) printf "::warning::VFS Derived budget erosion:');
        expect(reporter).toContain('budget = budget_min * 60;');
    });

    it('it divides by the TIED job env budget, not a second hardcoded literal', () => {
        expect(reporter).toContain('BUDGET_MIN="${VFS_DERIVED_TIMEOUT_MIN:-}"');
        expect(reporter).not.toMatch(/budget(_s)?\s*=\s*3600/);
        expect(reporter).not.toMatch(/budget_min\s*=\s*60\b/);
    });

    it('it writes to the step summary as well as stdout', () => {
        expect(reporter).toContain('"$GITHUB_STEP_SUMMARY"');
    });
});

describe('T-3 missing reporter inputs FAIL CLOSED where the reporter executes', () => {
    // F-1 / F-2 (Founder BLOCKING). The previous assertions matched guard text ANYWHERE in the
    // step, so COMMENTING a guard out kept them green while the guard stopped executing; and the
    // shared BUDGET_INPUT_INVALID code let EITHER budget guard be deleted unnoticed. Both are now
    // pinned as COMPLETE PREDICATES against the EXECUTABLE-ONLY body, independently of each other.
    const MARKS_GUARD = '[ -s "$MARKS" ] || { echo "::error::VFS-DERIVED-BUDGET MARKS_ABSENT: the phase-marks file is missing or empty ($MARKS). Missing telemetry is an ERROR, never a silent skip. Fail-closed."; exit 1; }';
    const BUDGET_TYPE_GUARD = `''|*[!0-9]*) echo "::error::VFS-DERIVED-BUDGET BUDGET_INPUT_INVALID: VFS_DERIVED_TIMEOUT_MIN is missing or non-numeric ('$BUDGET_MIN'). Fail-closed."; exit 1;;`;
    const BUDGET_RANGE_GUARD = '[ "$BUDGET_MIN" -gt 0 ] || { echo "::error::VFS-DERIVED-BUDGET BUDGET_INPUT_INVALID: VFS_DERIVED_TIMEOUT_MIN must be greater than 0. Fail-closed."; exit 1; }';

    it('the MARKS_ABSENT guard is an EXECUTABLE line, not merely text that exists', () => {
        expect(reporterExec).toContain(MARKS_GUARD);  // commenting it out drops it from reporterExec
        expect(reporterExec).toContain('Missing telemetry is an ERROR, never a silent skip.');
        expect(reporterExec.split('MARKS_ABSENT').length - 1).toBe(1);  // never prose-only
        expect(MARKS_GUARD).toContain('exit 1');
        // reader anti-vacuity: the filter really does drop a commented-out guard
        expect(executableShell(`\n        run: |\n          # ${MARKS_GUARD}`)).not.toContain(MARKS_GUARD);
    });

    it('BOTH budget guards pinned by COMPLETE PREDICATE — the shared error code is not enough', () => {
        expect(reporterExec).toContain('case "$BUDGET_MIN" in');
        expect(reporterExec).toContain(BUDGET_TYPE_GUARD);   // empty / non-numeric / negative
        expect(reporterExec).toContain(BUDGET_RANGE_GUARD);  // zero: all-digits, so it clears the case
        expect(reporterExec.split('BUDGET_INPUT_INVALID').length - 1).toBe(2);  // delete either => reds
        for (const g of [BUDGET_TYPE_GUARD, BUDGET_RANGE_GUARD]) expect(g).toContain('exit 1');
    });

    it('every input guard executes BEFORE the value it protects is consumed', () => {
        const t = reporterExec.indexOf(BUDGET_TYPE_GUARD);
        const r = reporterExec.indexOf(BUDGET_RANGE_GUARD);
        const m = reporterExec.indexOf(MARKS_GUARD);
        const consume = reporterExec.indexOf('awk -F');
        for (const i of [t, r, m, consume]) expect(i).toBeGreaterThan(-1);
        expect(r).toBeGreaterThan(t);       // type check precedes the range check
        expect(consume).toBeGreaterThan(r); // both budget guards precede the computation
        expect(consume).toBeGreaterThan(m); // the marks guard precedes the read
    });

    it('malformed, unknown, duplicated, and setup-less mark sets all fail closed', () => {
        for (const code of ['MARK_MALFORMED', 'MARK_UNKNOWN_PHASE', 'MARK_DUPLICATE', 'MARK_SETUP_ABSENT', 'MARKS_EMPTY']) {
            expect(reporter, `missing fail-closed code ${code}`).toContain(code);
        }
        // the awk failures must actually propagate through the `| tee` pipeline
        expect(reporter).toContain('set -euo pipefail');
        expect(reporter).toContain('`set -o pipefail` propagates the awk fail-closed exits through the tee pipeline.');
        expect(reporter).toContain('if (bad) { exit 1 }');
    });

    it('#NEG the reporter contains no swallow behaviour', () => {
        expect(reporter).not.toContain('|| true');
        expect(reporter).not.toContain('continue-on-error');
    });

    it('phases that legitimately did not run are NOT treated as missing telemetry', () => {
        // e.g. handoff/cache-persist after a health failure. Over-strictness here would turn
        // an honest failure into a second, misleading failure.
        expect(flat(reporterDoc)).toContain('Phases that legitimately did not run');
        expect(reporter).not.toMatch(/n != 8|phases_marked != 8|n < 8/);
    });
});

describe('T-3 TELEMETRY BOUNDARY — job-level cancellation is BEST-EFFORT, never guaranteed', () => {
    const jobBoundary = flat(derivedDoc);
    const stepBoundary = flat(reporterDoc);

    it('the truthful boundary is stated in the job doc AND on the reporter step', () => {
        for (const [label, text] of [['job doc', jobBoundary], ['reporter step doc', stepBoundary]] as const) {
            expect(text, label).toContain('BEST-EFFORT');
            expect(text, label).toMatch(/(NOT guaranteed|does NOT guarantee execution) after (a )?JOB-level/);
            expect(text, label).toMatch(/REQUIRED to (execute|run) after an ordinary step failure/);
            expect(text, label).toContain('STEP-level timeout where the runner remains available');
        }
    });

    it('the step-level timeouts are described as a PROBABILITY improvement, not a guarantee', () => {
        const boundary = `${jobBoundary} ${stepBoundary}`;
        expect(boundary).toContain('RAISES THE PROBABILITY');
        expect(boundary).toMatch(/probability improvement, (NOT|never) a guarantee/);
        expect(boundary).toContain('external cancellation');
        expect(boundary).toContain('runner loss');
        expect(boundary).toContain('30 min');
        expect(boundary).toContain('25 min');
    });

    it('#NEG the workflow makes NO claim that job-level cancellation guarantees execution', () => {
        // The rejected wording was: "the budget reporter is `if: always()`, so it prints on
        // success, failure, AND job cancellation". That overclaim must not exist anywhere.
        expect(yml).not.toMatch(/prints on success, failure, AND job cancellation/i);
        expect(yml).not.toMatch(/guaranteed[^.\n]{0,80}cancel/i);
        expect(yml).not.toMatch(/cancel[^.\n]{0,80}guaranteed to (run|execute)/i);
        expect(yml).not.toMatch(/always\(\)[^.\n]{0,80}guarantee[sd]?[^.\n]{0,40}cancel/i);
        expect(yml).not.toMatch(/will (always )?run after (a )?job(-| )level (timeout|cancellation)/i);
    });

    it('#NEG the boundary text is non-trivial (an emptied doc block cannot pass vacuously)', () => {
        expect(derivedDoc.split('\n').length).toBeGreaterThan(20);
        expect(reporterDoc.split('\n').length).toBeGreaterThan(10);
        expect(stepBoundary).toContain('EXECUTION BOUNDARY (truthful, do not overstate)');
        expect(jobBoundary).toContain('TELEMETRY BOUNDARY (truthful, do not overstate)');
    });
});
