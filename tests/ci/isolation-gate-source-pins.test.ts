/**
 * WO-N-P4 -- STRING PINS on the phase-C gate and the classifier.
 *
 * WHAT THESE ARE, EXACTLY: assertions that certain bytes appear in certain
 * files. They see TEXT. They do not run bash, they do not run the launcher, and
 * they prove nothing about what happens when the gate is reached. Every name in
 * this file is worded to claim only that.
 *
 * THE GAP THEY DO NOT CLOSE (M10; N-P5 item 0): whether an ordinary run with a
 * genuine red P9 actually stops is NOT pinned by anything executable in this
 * suite. The counterexamples that reach this gate all set a FAULT knob, so the
 * production path -- no knob, a real inherited fd, judged red by the ordinary
 * predicate -- is exercised by nothing. A mutant can leave fail() BYTE-IDENTICAL
 * and still prevent it from firing (M10 redefines fail() inside the gate under
 * `[ -z "$FAULT" ]`; an `exit() { return 0; }` or a `node()` override does it
 * from outside). The contiguous-region pin below and the function census narrow
 * that window -- all three of those named mutants break one of them -- but they
 * DO NOT close it: these are still string assertions, and a route that defeats
 * the gate without changing these bytes would pass. Closing M10 needs a
 * counterexample that induces a genuine inherited fd with no FAULT knob; that is
 * N-P5 item 0 and is deliberately not attempted here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_DENY } from '../../scripts/ci/isolation/netns-probe.mjs';

const ISO = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../..', 'scripts', 'ci', 'isolation');
const src = (f: string): string =>
    fs.readFileSync(path.join(ISO, f), 'utf8').replace(/\r\n/g, '\n');

/**
 * netns-phases.sh lines 75-85, ONE contiguous region: the self-test call, the
 * rc capture, and the whole `if ... fi` including its two comment lines. It is
 * one string on purpose -- two adjacent `toContain` calls leave a seam, and a
 * seam is exactly where M10 and MUT-16 insert. Generated from the file, not
 * retyped.
 */
const PHASE_C_GATE = [
    "C_RC=0",
    "node \"$HERE/netns-selftest.mjs\" \"$PARAMS\" >\"$EVID/selftest.stdout.txt\" \\",
    "  2>\"$EVID/selftest.stderr.txt\" || C_RC=$?",
    "printf '%s\\n' \"$C_RC\" >\"$EVID/phaseC.rc\"",
    "rec \"phase C rc=$C_RC\"",
    "if [ \"$C_RC\" -ne 0 ]; then",
    "  # Phase D is not started. The absence of the program's own marker file, not a",
    "  # missing log line, is what the counterexamples assert (N4-6).",
    "  fail \"phase C self-test failed (see selftest.stdout.txt) -- phase D NOT started\" \\",
    "    \"$F2AI_ISO_RC_SELFTEST\"",
    "fi"
].join('\n');

/** netns-phases.sh:34, whole definition. Text only: it cannot see a later
 *  redefinition, a shell function that shadows exit, or a PATH change. */
const FAIL_DEF =
    'fail() { rec "FAIL($2) $1"; printf \'netns-phases: %s\\n\' "$1" >&2; exit "$2"; }';

/** netns-selftest.mjs: the two statements that ARE the Node-side gate, plus the
 *  loop that populates what they read. Nothing in tests/ referenced
 *  report.failures before this file existed. */
const FAILURE_LOOP =
    '    for (const c of report.n4_0.checks) if (!c.ok) fail(c.id, c.why);';
const GATE_IF = '    if (report.failures.length > 0) {';
const GATE_RC = '    return finish(report, evid, report.failures.length === 0 ? 0 : 1);';

describe('netns-phases.sh: bytes that must be present (text assertions only)', () => {
    it('the phase-C gate appears as ONE contiguous region, exactly once', () => {
        const sh = src('netns-phases.sh');
        expect(sh).toContain(PHASE_C_GATE);
        expect(sh.split(PHASE_C_GATE).length - 1).toBe(1);
        // A line inserted ANYWHERE between the self-test call and the closing
        // `fi` breaks the match -- including between `then` and the fail(),
        // which is where M10 goes and where two separate pins left a seam.
        expect(PHASE_C_GATE.split('\n').length).toBe(11);
    });

    it('C_RC is assigned exactly twice and the fail() text is unmodified', () => {
        const sh = src('netns-phases.sh');
        expect(sh.match(/C_RC=/g)?.length).toBe(2);
        expect(sh).toContain('|| C_RC=$?');
        expect(sh).toContain(FAIL_DEF);
        expect(sh.match(/fail "phase C self-test failed/g)?.length).toBe(1);
    });

    it('the script declares exactly two shell functions, rec and fail', () => {
        const sh = src('netns-phases.sh');
        // A census of DECLARATION TEXT, not a claim about execution. Any added
        // or redefined function makes it three, in either bash spelling: the
        // count tolerates `(){` as well as `() {`, and the `function NAME`
        // form is refused outright (the file uses neither). It happens to
        // catch M10 and the exit()/node() overrides as written. It CANNOT see
        // a defeat that adds no declaration -- a PATH change, an alias, a
        // sourced file -- and it is not evidence that the gate fires.
        expect(sh.match(/\(\)\s*\{/g)?.length).toBe(2);
        expect([...sh.matchAll(/^(\w+)\(\)\s*\{/gm)].map((m) => m[1])).toEqual(['rec', 'fail']);
        expect(sh).not.toMatch(/^\s*function\s+\w+/m);
    });

    it('phase D is downstream of the gate and its code is not remapped', () => {
        const sh = src('netns-phases.sh');
        const gate = sh.indexOf(PHASE_C_GATE);
        expect(gate).toBeGreaterThan(0);
        expect(sh.indexOf('>"$EVID/phaseD.launched"')).toBeGreaterThan(gate);
        expect(sh.indexOf('timeout -k 15s "${PHASE_D_DEADLINE}s" "$@"')).toBeGreaterThan(gate);
        expect(sh).toContain('exit "$D_RC"');
    });
});

describe('netns-selftest.mjs: bytes that must be present (text assertions only)', () => {
    it('every failed N4-0 check is reported, with no filter in front of it', () => {
        const s = src('netns-selftest.mjs');
        expect(s).toContain(FAILURE_LOOP);
        expect(s.match(/for \(const c of report\.n4_0\.checks\)/g)?.length).toBe(1);
        expect(s).not.toMatch(/report\.n4_0\.checks\.filter/);
    });

    it('the two statements that ARE the gate read report.failures unfiltered', () => {
        const s = src('netns-selftest.mjs');
        // :165 -- a non-empty failure set stops the run before C1-C4.
        expect(s).toContain(GATE_IF);
        expect(s).toContain("        report.stoppedBefore = 'C1-C4 (the N4-0 pre-check did not pass)';");
        expect(s).toContain('        return finish(report, evid, 1);');
        // :208 -- and the final code is that same set, counted.
        expect(s).toContain(GATE_RC);
        // Neither may be narrowed to exempt a check by id.
        expect(s).not.toMatch(/report\.failures\.filter/);
        expect(s.match(/report\.failures\.length/g)?.length).toBe(2);
    });
});

describe('netns-selftest.mjs: the nsenter classifier (text assertions only)', () => {
    const body = (): string => {
        const s = src('netns-selftest.mjs');
        return s.slice(s.indexOf('function classifyNsenter'), s.indexOf('/** N2-3: try to join'));
    };

    it('an open failure carrying a PERMISSION errno is INDETERMINATE, NOT '
        + 'REFUSED: the escape gate may not widen for an unobserved class', () => {
        const b = body();
        expect(b.length).toBeGreaterThan(0);
        const gone = b.indexOf("return 'FAIL-vacuous'");
        const open = b.indexOf("if (/cannot open/.test(s)) return 'INDETERMINATE'");
        const refused = b.indexOf("return 'REFUSED'");
        expect(gone).toBeGreaterThan(0);
        expect(open).toBeGreaterThan(gone);
        expect(refused).toBeGreaterThan(open);
        expect(b).toContain('operation not permitted|permission denied');
        expect(b).toContain('no such file or directory|does not exist');
        expect(b).not.toContain('cannot open|');
    });

    it('the consumer accepts REFUSED and nothing else, so every other verdict '
        + 'still stops the run -- JOINED included', () => {
        const s = src('netns-selftest.mjs');
        expect(s).toContain("if (report.escape.verdict !== 'REFUSED') fail('ESCAPE'");
        expect(body()).not.toContain('All three except JOINED');
    });
});

describe('the behaviour suite depends on ENV_DENY; that dependency is pinned', () => {
    it('ENV_DENY matches the variable isolation-p9-gate-behaviour injects', () => {
        // If this regex is ever narrowed, that suite stops stopping at N4-0 and
        // starts spawning descendants and attempting an nsenter escape from
        // inside a unit test. The failure mode is not a clean red, so the
        // precondition is asserted here rather than assumed there.
        expect(ENV_DENY.some((re: RegExp) => re.test('HTTPS_PROXY'))).toBe(true);
        expect(String(ENV_DENY[0])).toBe('/^https?_proxy$/i');
    });
});
