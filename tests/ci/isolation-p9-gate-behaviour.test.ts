/**
 * WO-N-P4 B5 -- property (iv): a red P9 makes the run stop and phase D never
 * start. The review round found this property PINNED BY NOTHING: two mutants
 * survived a full green suite, because the assertions checked indexOf ordering
 * and substring presence -- text, not behaviour. That is the N-P3 failure mode
 * exactly ("tested a path the product does not take"), so it is answered here
 * by RUNNING the product.
 *
 *   MUT-16  insert `C_RC=0` after netns-phases.sh:79. Every asserted string and
 *           every ordering survives, and phase D runs after a red P9.
 *   MUT-17  exclude P9 from the failure loop at netns-selftest.mjs:164.
 *
 * MUT-17 is killed twice: once by an assertion on the WHOLE loop statement, and
 * once behaviourally, by spawning the real netns-selftest.mjs against a
 * synthetic red ledger and reading its exit code and its failures.
 * MUT-16 is shell-side. It is killed here by a source assertion on the whole
 * gate REGION plus a count of every assignment to C_RC -- an inserted
 * assignment makes three where the file has two. STATED PLAINLY: the
 * BEHAVIOURAL proof of MUT-16 needs bash and a Linux runner and IS NOT RUN
 * here; only the source invariant is.
 *
 * ENVIRONMENT. On CI this file runs INSIDE the launcher: test-suite.yml:147
 * invokes `netns-launch.sh -- npx vitest run --coverage` and vitest.config.ts
 * includes every *.test.ts, so these cases execute at the FINAL IDENTITY
 * inside the boundary, where the other N4-0 preconditions DO hold. Off a
 * runner they do not. The exit code is therefore never the discriminator: in
 * every case the discriminating assertion is whether P9-no-stray-fds is among
 * the reported failures, which is exactly what MUT-17 changes. An exit code is
 * asserted only where P9's own red verdict entails it on its own, which holds
 * in both environments. See runSelftest for how the child is kept from running
 * the real controls on a runner.
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
const src = (f: string): string =>
    fs.readFileSync(path.join(ISO, f), 'utf8').replace(/\r\n/g, '\n');

/** netns-phases.sh:34. Without `exit "$2"` this disables the P-1 post-drop
 *  gate, the F2 fault gate, the phase C gate and the pre-phase-D gate at once
 *  (MUT-A2), leaving every other assertion in this file intact. */
const FAIL_DEF =
    'fail() { rec "FAIL($2) $1"; printf \'netns-phases: %s\\n\' "$1" >&2; exit "$2"; }';

/** The gate's BODY. MUT-16 pins everything up to `then`; swapping this fail()
 *  for a rec() (MUT-A) survives that, so the call is pinned with its code. */
const GATE_BODY = [
    '  fail "phase C self-test failed (see selftest.stdout.txt) -- phase D NOT started" \\',
    '    "$F2AI_ISO_RC_SELFTEST"',
    'fi'
].join('\n');

/** The exact statement that turns a failed N4-0 check into a reported failure. */
const FAILURE_LOOP =
    '    for (const c of report.n4_0.checks) if (!c.ok) fail(c.id, c.why);\n';

/** The whole phase-C gate, from the invocation to the `fi`, with no room to
 *  slip a line in between. MUT-16 inserts one; a contiguous match refuses it. */
const PHASE_C_GATE = [
    'C_RC=0',
    'node "$HERE/netns-selftest.mjs" "$PARAMS" >"$EVID/selftest.stdout.txt" \\',
    '  2>"$EVID/selftest.stderr.txt" || C_RC=$?',
    'printf \'%s\\n\' "$C_RC" >"$EVID/phaseC.rc"',
    'rec "phase C rc=$C_RC"',
    'if [ "$C_RC" -ne 0 ]; then'
].join('\n');

interface Run { evid: string; status: number | null; stdout: string; report: any }

/**
 * Spawn the REAL self-test against a synthetic evidence directory. `lines` is
 * the ledger to write, or null to write none at all. Nothing is mocked: this is
 * the same entry point netns-phases.sh invokes at line 76.
 *
 * One deny-listed variable is injected DELIBERATELY. It makes P10-env-clean
 * fail in every environment, so the N4-0 gate always stops the child before
 * C1-C4 and the child never fires the real syscall controls, the descendant
 * spawns, the nsenter escape or the C5 resolver lookups from inside a unit
 * test -- which it otherwise would, on a runner, where N4-0 passes. It also
 * keeps `failures` non-empty there, so "P9 is NOT in failures" cannot pass
 * vacuously. It says nothing about P9 either way.
 */
function runSelftest(lines: string[] | null): Run {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-gate-'));
    const evid = dir.replace(/\\/g, '/');
    if (lines !== null) fs.writeFileSync(path.join(dir, 'fd-final.txt'), `${lines.join('\n')}\n`);
    const params = path.join(dir, 'params.txt');
    fs.writeFileSync(params, `EVID=${evid}\nMODE=wo-n-p4-behaviour\n`);
    const r = spawnSync(process.execPath, [SELFTEST, params], {
        encoding: 'utf8', timeout: 120000,
        env: { ...process.env, HTTPS_PROXY: 'http://wo-n-p4-forces-p10.invalid' }
    });
    let report: any = null;
    try { report = JSON.parse(fs.readFileSync(path.join(dir, 'selftest-report.json'), 'utf8')); }
    catch { report = null; }
    return { evid, status: r.status, stdout: String(r.stdout), report };
}

const CLEAN = ['0\t/dev/null', '1\tpipe:[100]', '2\tpipe:[101]', `255\t${PHASES_SCRIPT}`];
const p9Of = (run: Run): any =>
    run.report?.n4_0?.checks?.find((c: { id: string }) => c.id === 'P9-no-stray-fds');
const failedIds = (run: Run): string[] =>
    (run.report?.failures ?? []).map((f: { id: string }) => f.id);

describe('B5 behaviour: the real self-test, run against a synthetic ledger', () => {
    it('a KEPT descriptor makes P9 red, puts it in failures and exits 1', () => {
        const run = runSelftest([...CLEAN, '9\t/tmp/wo-n-p4-fd-bait.txt']);
        // Entailed by P9's own verdict: a red N4-0 check exits 1 whatever
        // else holds, so this one is environment-independent.
        expect(run.status).toBe(1);
        expect(run.stdout).toContain('BOUNDARY_NOT_PROVEN');
        expect(run.stdout).toContain('FAIL P9-no-stray-fds:');
        expect(failedIds(run)).toContain('P9-no-stray-fds');
        const p9 = p9Of(run);
        expect(p9.ok).toBe(false);
        expect(p9.observed.stray.map((s: { fd: string }) => s.fd)).toEqual(['9']);
        // ...and it stopped BEFORE the real syscall controls ran.
        expect(run.report.stoppedBefore).toContain('C1-C4');
        expect(run.report.controlsParent).toBe(undefined);
        fs.rmSync(run.evid, { recursive: true, force: true });
    });

    it('the same ledger WITHOUT that descriptor leaves P9 out of the failures', () => {
        const run = runSelftest(CLEAN);
        // No exit-code assertion here: with P9 green the code says only what
        // the ambient environment says. What P9 says is these three, and the
        // injected failure keeps the "not in failures" pair non-vacuous.
        expect(failedIds(run).length).toBeGreaterThan(0);
        expect(run.stdout).not.toContain('FAIL P9-no-stray-fds:');
        expect(failedIds(run)).not.toContain('P9-no-stray-fds');
        expect(p9Of(run).ok).toBe(true);
        // ...and the child stopped at the gate, so it ran no real control.
        expect(run.report.controlsParent).toBe(undefined);
        fs.rmSync(run.evid, { recursive: true, force: true });
    });

    it('NO ledger at all is a FAILURE, never a skip', () => {
        const run = runSelftest(null);
        expect(run.status).toBe(1);
        expect(failedIds(run)).toContain('P9-no-stray-fds');
        const p9 = p9Of(run);
        expect(p9.ok).toBe(false);
        expect(String(p9.observed.reason)).toContain('unreadable');
        expect(String(p9.observed.source).endsWith('/fd-final.txt')).toBe(true);
        fs.rmSync(run.evid, { recursive: true, force: true });
    });

    it('a ledger line it cannot parse is a FAILURE even with nothing stray', () => {
        const run = runSelftest([...CLEAN, 'not a ledger line']);
        expect(run.status).toBe(1);
        expect(failedIds(run)).toContain('P9-no-stray-fds');
        const p9 = p9Of(run);
        expect([p9.ok, p9.observed.stray]).toEqual([false, []]);
        expect(p9.observed.reason).toBe('parsed 4 of 5 recorded lines');
        fs.rmSync(run.evid, { recursive: true, force: true });
    });
});

describe('B5 source: the statements a mutant would have to keep', () => {
    it('MUT-17: the failure loop reports EVERY failed check, P9 included', () => {
        const s = src('netns-selftest.mjs');
        expect(s).toContain(FAILURE_LOOP);
        expect(s.match(/for \(const c of report\.n4_0\.checks\)/g)?.length).toBe(1);
        // Nothing may filter the checks before that loop reaches them.
        expect(s).not.toMatch(/report\.n4_0\.checks\.filter/);
        const stop = s.indexOf("report.stoppedBefore = 'C1-C4");
        expect(stop).toBeGreaterThan(s.indexOf(FAILURE_LOOP));
        expect(s.slice(stop, stop + 120)).toContain('return finish(report, evid, 1);');
    });

    it('MUT-16: the phase-C gate is contiguous and C_RC is assigned twice only', () => {
        const sh = src('netns-phases.sh');
        // A line inserted anywhere inside the gate breaks this match.
        expect(sh).toContain(PHASE_C_GATE);
        // ...and an assignment inserted anywhere else in the file is caught by
        // the count: the file assigns C_RC exactly twice, the initialiser and
        // the `|| C_RC=$?` that captures the self-test's code.
        expect(sh.match(/C_RC=/g)?.length).toBe(2);
        expect(sh).toContain('|| C_RC=$?');
        // Phase D is downstream of the gate and the code is not remapped.
        const gate = sh.indexOf(PHASE_C_GATE);
        expect(sh.indexOf('>"$EVID/phaseD.launched"')).toBeGreaterThan(gate);
        expect(sh.indexOf('timeout -k 15s "${PHASE_D_DEADLINE}s" "$@"')).toBeGreaterThan(gate);
        expect(sh).toContain('phase D NOT started');
        expect(sh).toContain('exit "$D_RC"');
    });

    it('MUT-A / MUT-A2: the gate BODY and fail() itself, exit code included', () => {
        const sh = src('netns-phases.sh');
        // MUT-A: turning the fail() into a rec() leaves every string this file
        // otherwise asserts in place, so the whole statement is matched.
        expect(sh).toContain(GATE_BODY);
        expect(sh.match(/fail "phase C self-test failed/g)?.length).toBe(1);
        // MUT-A2: fail() that does not exit neuters four gates at once.
        expect(sh).toContain(FAIL_DEF);
        expect(sh.match(/^fail\(\) \{/gm)?.length).toBe(1);
    });
});

describe('B3: the nsenter classifier, and what it refuses to widen', () => {
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
        // Each branch matches an errno phrase and nothing else.
        expect(b).toContain('operation not permitted|permission denied');
        expect(b).toContain('no such file or directory|does not exist');
        expect(b).not.toContain('cannot open|');
    });

    it('the consumer accepts REFUSED and nothing else, so every other verdict '
        + 'still stops the run -- JOINED included', () => {
        const s = src('netns-selftest.mjs');
        expect(s).toContain("if (report.escape.verdict !== 'REFUSED') fail('ESCAPE'");
        // F9: the comment must not claim JOINED is the one exception.
        expect(body()).not.toContain('All three except JOINED');
    });
});
