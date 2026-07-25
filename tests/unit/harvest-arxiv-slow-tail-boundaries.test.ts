import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
// @ts-ignore — JS ESM module (no .d.ts); tested for its runtime contract.
import {
    ATTEMPT_TIMEOUTS_MS, TOKEN_BACKOFF_MS, MAX_REQUESTS_PER_TOKEN, RECOVERY_ENVELOPE_VERSION,
    TOTAL_BUDGET_MS, WORST_CASE_TOKEN_MS, HEALTHY_WALK_TRANSPORT_MS, WORST_CASE_WALL_CLOCK_MS,
    STEP_WALL_CLOCK_HEADROOM_MS, ARXIV_STEP_TIMEOUT_MS, ACADEMIC_JOB_TIMEOUT_MS,
    TERMINALIZATION_RESERVE_MS, ADMISSION_DEADLINE_MS, FLOOR_RESERVE_SHORTFALL_MS,
    MAX_THIRD_ATTEMPT_TOKENS_PER_RUN, MAX_RETRY_AFTER_MS, FORESEEABLE_TAIL_MS,
    EXPECTED_WALL_CLOCK_FLOOR_MS, WORST_CASE_STEP_OVERRUN_MS, AR5IV_PER_PAGE_WORST_MS,
    FORESEEABLE_TAIL_WORST_MS, HEALTHY_WALK_PAGES,
} from '../../scripts/ingestion/adapters/arxiv-recovery-envelope.js';

// 2026-07-25 arXiv P0 — OUTER TIME BOUNDARIES + run-level accounting + the literal
// envelope pin. Split out of the terminal suite so the workflow-boundary guards are
// one auditable file. Companions: -envelope (A/B/C/E/F), -terminal (D/G budget/meta).

const HARVEST_YML = '.github/workflows/factory-harvest.yml';

// Minimal INDENTATION-ANCHORED workflow reader. No YAML library is imported: `yaml`
// and `js-yaml` are transitive-only (absent from package.json), so depending on them
// here would smuggle in an undeclared dependency. Anchoring instead makes the guards
// strictly stronger than substring matching: a value living in a COMMENT can never
// satisfy `^ {n}key:` (a comment line starts with '#'), and a value belonging to a
// DIFFERENT job or a LATER step is outside the sliced block entirely.

/** Slice the block introduced by `header` at `indent`, ending at the next line of equal-or-shallower indent (comment lines ignored). */
function block(src: string, header: string, indent: number): string {
    const lines = src.replace(/\r\n/g, '\n').split('\n'); // checkout is CRLF; anchor on LF
    const start = lines.indexOf(' '.repeat(indent) + header);
    expect(start, `block header not found: "${header}" at indent ${indent}`).toBeGreaterThan(-1);
    const shallower = new RegExp(`^ {0,${indent}}[^\\s#]`);
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim() && shallower.test(lines[i])) return lines.slice(start, i).join('\n');
    }
    return lines.slice(start).join('\n');
}

/** Read a numeric key that the block OWNS at exactly `indent` (never a comment, never a nested block's key). */
function ownNumber(src: string, key: string, indent: number): number | null {
    const m = src.match(new RegExp(`^ {${indent}}${key}: *(\\d+) *(#.*)?$`, 'm'));
    return m ? Number(m[1]) : null;
}

/** The `- name: X` step block inside a job's steps list (6-space list indent). */
function step(job: string, name: string): string {
    const lines = job.replace(/\r\n/g, '\n').split('\n');
    const start = lines.indexOf(`      - name: ${name}`);
    expect(start, `step not found: ${name}`).toBeGreaterThan(-1);
    for (let i = start + 1; i < lines.length; i++) {
        if (/^ {6}- /.test(lines[i])) return lines.slice(start, i).join('\n');
    }
    return lines.slice(start).join('\n');
}

describe('arXiv P0 slow-tail — G3 outer deadlines are pinned, not merely present', () => {
    // BF-3: both deadlines are read as the OWN key of their own block. A 180 that
    // moved to a later step, or a 300 surviving only inside a comment, now reds.
    it('G3 the Academic job OWNS timeout-minutes 300 and the ArXiv step OWNS timeout-minutes 180', () => {
        const yml = fs.readFileSync(HARVEST_YML, 'utf8');
        const academic = block(yml, 'harvest-academic:', 2);
        // The JOB's own key, read from the region ABOVE `steps:` so no step can supply it.
        const jobHead = academic.slice(0, academic.indexOf('\n    steps:'));
        expect(ownNumber(jobHead, 'timeout-minutes', 4)).toBe(300);
        // The ArXiv step's OWN key, read from that step's own bounds only.
        const arxivStep = step(academic, 'Harvest ArXiv Papers');
        expect(arxivStep).toContain('harvest-single.js arxiv --limit 100000 --no-bridge'); // right step
        expect(ownNumber(arxivStep, 'timeout-minutes', 8)).toBe(180);
        // Fail-loud preserved: the arXiv line still has no `|| echo` swallow.
        expect(arxivStep).not.toMatch(/harvest-single\.js arxiv[^\n]*\|\| echo/);
        // The constants the derivation reasons about MUST equal the real workflow.
        expect(ARXIV_STEP_TIMEOUT_MS).toBe(180 * 60 * 1000);
        expect(ACADEMIC_JOB_TIMEOUT_MS).toBe(300 * 60 * 1000);
        // The job ceiling must stay above the transport budget, or TOTAL_BUDGET_EXHAUSTED
        // becomes structurally unreachable (the runner would kill the job first).
        expect(ACADEMIC_JOB_TIMEOUT_MS).toBeGreaterThan(TOTAL_BUDGET_MS);
        expect(ARXIV_STEP_TIMEOUT_MS).toBeGreaterThan(TOTAL_BUDGET_MS);
    });

    // Anti-vacuity for the reader itself: the helpers must actually reject the two
    // weakenings, proven against synthetic inputs rather than trusted by inspection.
    it('G3-READER the anchored reader rejects a comment-only value and a later-step value', () => {
        const fake = [
            '  harvest-academic:', '    name: Harvest Academic', '    timeout-minutes: 100',
            '    # timeout-minutes: 300', '    steps:',
            '      - name: Harvest ArXiv Papers', '        timeout-minutes: 30',
            '      - name: Harvest HuggingFace Papers', '        timeout-minutes: 180', '',
        ].join('\n');
        const job = block(fake, 'harvest-academic:', 2);
        const head = job.slice(0, job.indexOf('\n    steps:'));
        expect(ownNumber(head, 'timeout-minutes', 4)).toBe(100);   // NOT the commented 300
        expect(head).toContain('# timeout-minutes: 300');          // the comment IS present...
        expect(ownNumber(head, 'timeout-minutes', 4)).not.toBe(300); // ...and still does not count
        expect(ownNumber(step(job, 'Harvest ArXiv Papers'), 'timeout-minutes', 8)).toBe(30); // not the later 180
    });
});

describe('arXiv P0 slow-tail — envelope literal pin + run-level accounting', () => {
    // NBO-1: pin the Founder-locked numbers to LITERALS. Tests elsewhere compare
    // against the constants themselves, which cannot detect a change to those
    // constants; this one can.
    it('PIN the Founder-locked envelope values are exactly 120/300/300s and 60/300s', () => {
        expect(ATTEMPT_TIMEOUTS_MS).toEqual([120000, 300000, 300000]);
        expect(TOKEN_BACKOFF_MS).toEqual([60000, 300000]);
        expect(MAX_REQUESTS_PER_TOKEN).toBe(3);
        expect(TOTAL_BUDGET_MS).toBe(6300000);
        expect(RECOVERY_ENVELOPE_VERSION).toBe('arxiv-oai-slow-tail-v2-2026-07-25');
        // Frozen: a consumer cannot mutate the envelope out from under the arbiter.
        expect(Object.isFrozen(ATTEMPT_TIMEOUTS_MS)).toBe(true);
        expect(Object.isFrozen(TOKEN_BACKOFF_MS)).toBe(true);
        // Founder-ruled runtime controls, pinned to literals for the same reason.
        expect(MAX_THIRD_ATTEMPT_TOKENS_PER_RUN).toBe(1);
        expect(MAX_RETRY_AFTER_MS).toBe(300000);
        expect(TERMINALIZATION_RESERVE_MS).toBe(300000);
        // Two tails, both pinned. The EXPECTED one is for reporting only; the BOUND is
        // the one the admission gate is allowed to price.
        expect(FORESEEABLE_TAIL_MS).toBe(70250);        // 20000 pacing + 50000 ar5iv FLOOR + 250
        expect(FORESEEABLE_TAIL_WORST_MS).toBe(170250); // 20000 pacing + 150000 ar5iv BOUND + 250
        expect(FORESEEABLE_TAIL_WORST_MS - FORESEEABLE_TAIL_MS).toBe(100000);
    });

    // BF-1: the RUN-level arithmetic, pinned to literals and stated honestly —
    // including the part that is uncomfortable.
    it('RUN-LEVEL healthy walk + one worst-case token EXCEEDS the unraised budget (stated, not hidden)', () => {
        expect(HEALTHY_WALK_TRANSPORT_MS).toBe(5400000);  // 60 pages x 90s
        expect(WORST_CASE_TOKEN_MS).toBe(1080000);        // 120+60+300+300+300 s
        expect(HEALTHY_WALK_TRANSPORT_MS + WORST_CASE_TOKEN_MS).toBe(6480000);
        // THE HONEST FACT: 6480000 > 6300000. A full 60-page 90s/page walk that also
        // burns one complete 3-attempt slow-tail window exhausts the budget ~180000ms
        // early and terminates TOTAL_BUDGET_EXHAUSTED (fail-loud, never a soft partial).
        expect(HEALTHY_WALK_TRANSPORT_MS + WORST_CASE_TOKEN_MS).toBeGreaterThan(TOTAL_BUDGET_MS);
        expect(HEALTHY_WALK_TRANSPORT_MS + WORST_CASE_TOKEN_MS - TOTAL_BUDGET_MS).toBe(180000);
        // The widened per-token allowance is 1.8x the ~600000ms the budget was sized for.
        expect(WORST_CASE_TOKEN_MS / 600000).toBeCloseTo(1.8, 5);
    });

    // BF-1: wall clock at RUN level — the transport ceiling PLUS the non-transport
    // time it excludes but which still shares the 180-minute arXiv step.
    it('RUN-LEVEL the FLOOR is 175.25min but the true WORST CASE is 275.25min — a 95.25min overrun', () => {
        // FLOOR (optimistic): 6300000 transport + 60 * (20000 pacing + 50000 ar5iv
        // FLOOR + 250 polite). Named a floor because it excludes ar5iv fetch latency.
        expect(EXPECTED_WALL_CLOCK_FLOOR_MS).toBe(10515000);
        expect(EXPECTED_WALL_CLOCK_FLOOR_MS / 60000).toBeCloseTo(175.25, 5);
        expect(STEP_WALL_CLOCK_HEADROOM_MS).toBe(285000);
        expect(STEP_WALL_CLOCK_HEADROOM_MS / 60000).toBeCloseTo(4.75, 5);
        // TRUE WORST CASE: ar5iv's own FETCH_TIMEOUT_MS (15000) dominates the 5000ms
        // spacing, so a page costs 10*15000 = 150000, not 50000.
        expect(AR5IV_PER_PAGE_WORST_MS).toBe(150000);
        expect(WORST_CASE_WALL_CLOCK_MS).toBe(16515000);
        expect(WORST_CASE_WALL_CLOCK_MS / 60000).toBeCloseTo(275.25, 5);
        // ...which OVERRUNS the 180-minute step by 95.25 minutes. Stated, not hidden.
        expect(WORST_CASE_WALL_CLOCK_MS).toBeGreaterThan(ARXIV_STEP_TIMEOUT_MS);
        expect(WORST_CASE_STEP_OVERRUN_MS).toBe(5715000);
        expect(WORST_CASE_STEP_OVERRUN_MS / 60000).toBeCloseTo(95.25, 5);
        // Even the OPTIMISTIC floor does not clear the terminalization reserve: 285000
        // of headroom < 300000 of reserve, i.e. the floor overruns the admission line
        // by 15000ms. No arrangement of the locked constants makes the static envelope
        // fit; only the RUNTIME gate keeps such a run auditable.
        expect(ADMISSION_DEADLINE_MS).toBe(10500000);
        expect(FLOOR_RESERVE_SHORTFALL_MS).toBe(15000);
        expect(FLOOR_RESERVE_SHORTFALL_MS).toBeGreaterThan(0);
        expect(STEP_WALL_CLOCK_HEADROOM_MS).toBeLessThan(TERMINALIZATION_RESERVE_MS);
        // The GATE prices the bound, so the two per-page readings must stay distinct
        // and the run-level derivation must keep showing BOTH. The expected reading is
        // what a healthy run really costs; the bound is what the gate must assume.
        expect(EXPECTED_WALL_CLOCK_FLOOR_MS).toBeLessThan(WORST_CASE_WALL_CLOCK_MS);
        expect(WORST_CASE_WALL_CLOCK_MS - EXPECTED_WALL_CLOCK_FLOOR_MS)
            .toBe(HEALTHY_WALK_PAGES * (FORESEEABLE_TAIL_WORST_MS - FORESEEABLE_TAIL_MS));
        // ar5iv enrichment is NOT hypothetical: the kill switch is never set in CI, and
        // the guard disables only on the exact string 'false'.
        const wf = fs.readdirSync('.github/workflows').map((f) => fs.readFileSync(`.github/workflows/${f}`, 'utf8'));
        expect(wf.some((y) => y.includes('ENABLE_AR5IV'))).toBe(false);
        expect(fs.readFileSync('scripts/ingestion/adapters/arxiv-adapter.js', 'utf8'))
            .toContain("process.env.ENABLE_AR5IV === 'false'");
        expect(fs.readFileSync('scripts/ingestion/adapters/ar5iv-fetcher.js', 'utf8'))
            .toContain('const RATE_LIMIT_MS = 5000');
    });
});

describe('arXiv P0 slow-tail — H downstream gates still reject a failed 1/4', () => {
    // H — a failed Academic harvest cannot establish Academic R2 authority and cannot
    // unlock Merge & Upload; the 2/4, 3/4 and 4/4 conclusion gates are unchanged.
    it('H failed Academic harvest establishes no R2 authority and unlocks no downstream stage', () => {
        const harvest = fs.readFileSync(HARVEST_YML, 'utf8');
        const academic = block(harvest, 'harvest-academic:', 2);
        // The R2 stream + source-authority steps are success-gated (no always()/failure()),
        // so a red arXiv step skips them: no Academic authority from a failed harvest.
        for (const name of ['Stream Academic to R2', 'Establish Authoritative R2 Harvest Source Authority']) {
            const s = step(academic, name);
            const cond = s.slice(0, s.indexOf('run:'));
            expect(cond).toContain("if: github.event.inputs.skip_harvest != 'true'");
            expect(cond).not.toMatch(/always\(\)|failure\(\)|continue-on-error/);
        }
        // Merge & Upload needs ALL four harvest jobs to SUCCEED (default needs semantics).
        expect(harvest).toContain('needs: [harvest-huggingface, harvest-github, harvest-academic, harvest-ecosystem]');
        // 2/4, 3/4, 4/4 upstream-conclusion gates unchanged and still fail closed.
        for (const wf of ['factory-process.yml', 'factory-aggregate.yml', 'factory-upload.yml']) {
            const yml = fs.readFileSync(`.github/workflows/${wf}`, 'utf8');
            expect(yml).toContain('- name: Verify Upstream Conclusion');
            expect(yml).toContain("github.event.workflow_run.conclusion != 'success'");
            const gate = yml.slice(yml.indexOf('- name: Verify Upstream Conclusion'));
            expect(gate.slice(0, gate.indexOf('- name:', 10))).toContain('exit 1');
        }
    });
});
