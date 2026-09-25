/**
 * WO-N-P4 -- what the P9 gate does WHEN IT RUNS. These cases execute the real
 * netns-selftest.mjs as a child process. The string pins that merely assert
 * bytes live in isolation-gate-source-pins.test.ts and are named as such.
 *
 * WHAT IS PINNED HERE: that netns-selftest.mjs, given a ledger, puts
 * P9-no-stray-fds in report.failures exactly when that ledger is bad, exits
 * non-zero when it does, and stops before C1-C4 rather than running the real
 * controls. That is the Node half of the gate, and it is genuinely executed.
 *
 * WHAT IS NOT PINNED, ANYWHERE IN THIS SUITE (M10; N-P5 item 0): whether an
 * ordinary run with a genuine red P9 actually stops is NOT pinned by anything
 * executable in this suite. Every counterexample that reaches the phase-C gate
 * in counterexamples.sh sets a FAULT knob, so the production path -- no knob, a
 * real inherited fd, judged red by the ordinary predicate -- is exercised by
 * nothing. The shell half of the gate is covered only by string assertions, and
 * those NARROW the window without closing it: fail() can be left BYTE-IDENTICAL
 * and still be prevented from firing (M10 redefines it inside the gate under
 * `[ -z "$FAULT" ]`; an `exit()` or `node()` shell-function override does it
 * from outside the region). Those are caught AS WRITTEN by the region pin and
 * the function census in isolation-gate-source-pins, which also covers the two
 * files netns-phases.sh sources; but a defeat that adds no declaration -- an
 * alias or a PATH shim -- is caught by nothing. The same blindness covers the
 * P-1 PRE-PHASE-D gate at netns-phases.sh:92, which no counterexample exercises
 * as a FAILING gate because F4b exits earlier at the post-drop check on line 60.
 * Do not read anything below as "the gate is pinned".
 *
 * ENVIRONMENT. On CI this file runs INSIDE the launcher: test-suite.yml:147
 * invokes `netns-launch.sh -- npx vitest run --coverage` and vitest.config.ts
 * includes every *.test.ts, so these cases execute at the FINAL IDENTITY inside
 * the boundary, where the other N4-0 preconditions DO hold. Off a runner they
 * do not. The exit code is therefore never the discriminator: the discriminator
 * is P9's presence in report.failures. An exit code is asserted only where P9's
 * own red verdict entails it on its own, which holds in both environments, and
 * the failure SETS are compared against AMBIENT -- measured in this same
 * process -- rather than against a hard-coded list that would name one machine.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ISO = path.join(ROOT, 'scripts', 'ci', 'isolation');
const SELFTEST = path.join(ISO, 'netns-selftest.mjs');
const PHASES_SCRIPT = fileURLToPath(new URL(
    `file://${path.join(ISO, 'netns-phases.sh').replace(/\\/g, '/')}`));

/** The deny-listed name injected below. isolation-gate-source-pins asserts that
 *  ENV_DENY still matches it -- this file would silently stop stopping at N4-0
 *  if that regex were ever narrowed. */
const DENY_VAR = 'HTTPS_PROXY';
const P9 = 'P9-no-stray-fds';

interface Run { evid: string; status: number | null; stdout: string; report: any }

/**
 * Spawn the REAL self-test against a synthetic evidence directory. `lines` is
 * the ledger to write, or null to write none at all. Nothing is mocked: this is
 * the same entry point netns-phases.sh invokes at line 76.
 *
 * DENY_VAR is injected DELIBERATELY. It makes P10-env-clean fail in every
 * environment, so the N4-0 gate always stops the child before C1-C4 and the
 * child never fires the real syscall controls, the descendant spawns, the
 * nsenter escape or the C5 resolver lookups from inside a unit test -- which it
 * otherwise would, on a runner, where N4-0 passes. It says nothing about P9.
 */
function runSelftest(lines: string[] | null): Run {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-gate-'));
    const evid = dir.replace(/\\/g, '/');
    if (lines !== null) fs.writeFileSync(path.join(dir, 'fd-final.txt'), `${lines.join('\n')}\n`);
    const params = path.join(dir, 'params.txt');
    fs.writeFileSync(params, `EVID=${evid}\nMODE=wo-n-p4-behaviour\n`);
    const r = spawnSync(process.execPath, [SELFTEST, params], {
        encoding: 'utf8', timeout: 120000,
        env: { ...process.env, [DENY_VAR]: 'http://wo-n-p4-forces-p10.invalid' }
    });
    let report: any = null;
    try { report = JSON.parse(fs.readFileSync(path.join(dir, 'selftest-report.json'), 'utf8')); }
    catch { report = null; }
    return { evid, status: r.status, stdout: String(r.stdout), report };
}

const CLEAN = ['0\t/dev/null', '1\tpipe:[100]', '2\tpipe:[101]', `255\t${PHASES_SCRIPT}`];
const p9Of = (run: Run): any =>
    run.report?.n4_0?.checks?.find((c: { id: string }) => c.id === P9);
const failedIds = (run: Run): string[] =>
    (run.report?.failures ?? []).map((f: { id: string }) => f.id).sort();

/**
 * The failure set this environment produces from a GREEN ledger: the injected
 * P10, plus whatever the ambient N4-0 state adds (nothing extra on a runner
 * inside the launcher, several checks off one). Measured once, here, so the
 * assertions below can be exact without naming a machine.
 */
const GREEN = runSelftest(CLEAN);
const AMBIENT = failedIds(GREEN);
const AMBIENT_PLUS_P9 = [...AMBIENT, P9].sort();

describe('the real self-test against a synthetic ledger (this part executes)', () => {
    it('the ambient baseline is real: the injected deny var fired and P9 is '
        + 'not in it, so every "P9 absent" below is non-vacuous', () => {
        expect(AMBIENT).toContain('P10-env-clean');
        expect(AMBIENT).not.toContain(P9);
    });

    it('a KEPT descriptor puts P9 in failures -- the failure set is exactly '
        + 'the ambient one plus P9, and the process exits 1', () => {
        const run = runSelftest([...CLEAN, '9\t/tmp/wo-n-p4-fd-bait.txt']);
        expect(failedIds(run)).toEqual(AMBIENT_PLUS_P9);
        expect(run.stdout).toContain('BOUNDARY_NOT_PROVEN');
        expect(run.stdout).toContain(`FAIL ${P9}:`);
        const p9 = p9Of(run);
        expect(p9.ok).toBe(false);
        expect(p9.observed.stray.map((s: { fd: string }) => s.fd)).toEqual(['9']);
        // Entailed by P9's own verdict: a red N4-0 check exits 1 whatever else
        // holds, so this one is environment-independent.
        expect(run.status).toBe(1);
        // ...and it stopped at the gate, so it ran no real control.
        expect(run.report.stoppedBefore).toContain('C1-C4');
        expect(run.report.controlsParent).toBe(undefined);
        fs.rmSync(run.evid, { recursive: true, force: true });
    });

    it('the same ledger WITHOUT that descriptor leaves P9 out entirely', () => {
        // No exit-code assertion: with P9 green the code says only what the
        // ambient environment says. What P9 says is these. (Comparing
        // failedIds(GREEN) to AMBIENT would compare a value to itself.)
        expect(GREEN.stdout).not.toContain(`FAIL ${P9}:`);
        expect(p9Of(GREEN).ok).toBe(true);
        expect(GREEN.report.controlsParent).toBe(undefined);
        fs.rmSync(GREEN.evid, { recursive: true, force: true });
    });

    it('NO ledger at all is a FAILURE, never a skip', () => {
        const run = runSelftest(null);
        expect(failedIds(run)).toEqual(AMBIENT_PLUS_P9);
        expect(run.status).toBe(1);
        const p9 = p9Of(run);
        expect(p9.ok).toBe(false);
        expect(String(p9.observed.reason)).toContain('unreadable');
        expect(String(p9.observed.source).endsWith('/fd-final.txt')).toBe(true);
        fs.rmSync(run.evid, { recursive: true, force: true });
    });

    it('a ledger line it cannot parse is a FAILURE even with nothing stray', () => {
        const run = runSelftest([...CLEAN, 'not a ledger line']);
        expect(failedIds(run)).toEqual(AMBIENT_PLUS_P9);
        expect(run.status).toBe(1);
        const p9 = p9Of(run);
        expect([p9.ok, p9.observed.stray]).toEqual([false, []]);
        expect(p9.observed.reason).toBe('parsed 4 of 5 recorded lines');
        fs.rmSync(run.evid, { recursive: true, force: true });
    });
});

/**
 * N-P5 item 0 (M10), case P9o in counterexamples.sh: what can be checked OFF a
 * runner. Registration text plus one pure-function evaluation -- this does NOT
 * show the launcher stopping. That evidence exists only in the CI run that
 * executes the driver (rc 74 and no phaseD.marker on the originals; phase D
 * STARTED on every mutated copy).
 */
describe('P9o: the inherited stdout it uses lies in the establish/P9 difference set', () => {
    const read = (f: string): string => fs.readFileSync(path.join(ISO, f), 'utf8').replace(/\r\n/g, '\n');

    it('P9 refuses /dev/zero on fd 1, while establish refuses only a socket on 0/1/2', async () => {
        const { strayReason } = await import('../../scripts/ci/isolation/fd-ledger.mjs');
        expect(strayReason({ fd: '1', target: '/dev/zero' }, PHASES_SCRIPT))
            .toBe('stdio fd points at /dev/zero, not /dev/null, a pipe, a tty or a file');
        expect(read('netns-establish.sh'))
            .toContain('case "$fd" in 0|1|2) case "$tgt" in socket:*) STRAY=1;');
    });

    it('the case clears both knobs, sends stdout to /dev/zero and runs all six mutants', () => {
        const d = read('counterexamples.sh');
        expect(d).toContain('env -u F2AI_ISO_FAULT -u F2AI_ISO_FAULT_ACK "$1" --evidence');
        expect(d).toContain('"$CASE_NONCE" >/dev/zero 2>"$CASE_EVID/driver.stderr"');
        expect(d).toContain("= 'P9-no-stray-fds|1' ]");
        expect(d).toContain('p9o_run "$LAUNCH" p9o; p9o_expect P9o');
        expect([...d.matchAll(/^p9o_mutant (\S+) /gm)].map((m) => m[1]))
            .toEqual(['M10', 'F2a-exit', 'F2b-node', 'G2a-alias', 'G2b-path', 'MUT-16']);
    });

    it('each mutant anchor starts exactly one line of netns-phases.sh', () => {
        const lines = read('netns-phases.sh').split('\n');
        for (const a of ['if [ "$C_RC" -ne 0 ]; then', 'fail() {', 'rec "phase C rc=$C_RC"']) {
            expect(lines.filter((l) => l.startsWith(a)).length, a).toBe(1);
        }
    });
});
