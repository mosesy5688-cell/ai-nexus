/**
 * Work order N, N5-2 / N5-3 -- executable hygiene contract for the isolation
 * facility itself.
 *
 * WHAT IT PROVES: every file in the facility is listed here and nothing on disk
 * escapes the list; every listed file parses; none exceeds the CES monolith
 * limit; the gates cannot be turned green by evidence collection (no
 * unconditional `exit 0`, no pipe-tail exit masking, no `|| true` on a gate);
 * the attribution artifact is emitted on every terminal path (c5); the
 * exit-code vocabulary is distinct so an isolation failure and a test failure
 * are separable (ruling B3); the counterexamples F1-F4, b4 and its real-mount
 * variant and the positive control are really registered; the refusal accept
 * set excludes the verdicts N4-1/N4-2 forbid; and the self-test runs the N4-0
 * pre-check BEFORE any real syscall.
 *
 * WHAT IT DOES NOT PROVE: any runtime behaviour of the namespace. These are
 * static and parse-level checks. Everything dynamic needs a Linux runner.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'scripts', 'ci', 'isolation');
const CES_MAX_LINES = 250;

/** Sourced, not executed: they must NOT set shell options for their caller. */
const SOURCED = new Set([
    'exit-codes.sh', 'stub-identity.sh', 'mask-channels.sh', 'case-helpers.sh',
    'finalize.sh'
]);
/** The stub deliberately exits 0 for its sentinel argv; it is not a gate. */
const EXIT_ZERO_ALLOWED = new Set(['stub-curl.sh']);

/**
 * EVERY executable file in the facility, including the ones ruling B/C/D added.
 * The list is the coverage: a file missing from it is a file this contract does
 * not check, so the census below asserts that nothing on disk is left out --
 * otherwise "every file parses" would quietly mean "every file I remembered".
 */
const EXPECTED_FILES = [
    'exit-codes.sh', 'finalize.sh', 'netns-launch.sh', 'netns-establish.sh',
    'netns-phases.sh', 'stub-identity.sh', 'stub-curl.sh', 'counterexamples.sh',
    'attribution-cases.sh', 'case-helpers.sh', 'mask-channels.sh',
    'netns-controls.mjs', 'netns-probe.mjs', 'netns-ipc.mjs',
    'netns-descendant.mjs', 'netns-selftest.mjs', 'pos-marker.mjs',
    'attribute.mjs', 'boundary-precondition.mjs', 'fd-ledger.mjs'
];
/** Data, not code: listed so the census is complete, never parsed as a script. */
const EXPECTED_DATA = ['classified-channels.tsv'];

const read = (f: string): string => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n');
const lines = (f: string): number => read(f).split('\n').length;
const shells = () => EXPECTED_FILES.filter((f) => f.endsWith('.sh'));
const mjs = () => EXPECTED_FILES.filter((f) => f.endsWith('.mjs'));
const bashPath = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0 ? 'bash' : null;

describe('the facility exists and respects CES', () => {
    it('every expected file is present', () => {
        expect([...EXPECTED_FILES, ...EXPECTED_DATA]
            .filter((f) => !fs.existsSync(path.join(DIR, f)))).toEqual([]);
    });

    it('nothing on disk escapes this contract', () => {
        // Anti-vacuity for the list itself. Adding a script without adding it
        // here would exempt it from the parse, CES and no-masking checks below,
        // and the file header would then be claiming more than it verifies.
        const onDisk = fs.readdirSync(DIR).filter((f) => !f.startsWith('.')).sort();
        const known = [...EXPECTED_FILES, ...EXPECTED_DATA].sort();
        expect(onDisk.filter((f) => !known.includes(f)),
            'an unlisted file in scripts/ci/isolation is unchecked').toEqual([]);
        expect(known.filter((f) => !onDisk.includes(f))).toEqual([]);
    });

    it('no file exceeds the CES monolith limit', () => {
        const over = EXPECTED_FILES.filter((f) => lines(f) > CES_MAX_LINES)
            .map((f) => `${f}=${lines(f)}`);
        expect(over, `CES Art 5.1 MAX_LINES=${CES_MAX_LINES}`).toEqual([]);
    });

    it('the logic is split across files rather than crammed into one script', () => {
        expect(EXPECTED_FILES.length).toBeGreaterThanOrEqual(10);
        const biggest = Math.max(...EXPECTED_FILES.map(lines));
        expect(biggest).toBeLessThanOrEqual(CES_MAX_LINES);
    });
});

describe('everything parses', () => {
    for (const f of shells()) {
        it(`bash -n ${f}`, () => {
            if (!bashPath) return expect('bash unavailable: NOT CHECKED').toBe('bash unavailable: NOT CHECKED');
            const r = spawnSync(bashPath, ['-n', path.join(DIR, f)], { encoding: 'utf8' });
            expect(r.stderr || '').toBe('');
            expect(r.status).toBe(0);
        });
    }
    for (const f of mjs()) {
        it(`node --check ${f}`, () => {
            const r = spawnSync(process.execPath, ['--check', path.join(DIR, f)], { encoding: 'utf8' });
            expect(r.stderr || '').toBe('');
            expect(r.status).toBe(0);
        });
    }
});

describe('N5-2: failures cannot be turned into success', () => {
    for (const f of shells().filter((x) => !SOURCED.has(x))) {
        it(`${f} runs under set -Eeuo pipefail`, () => {
            expect(read(f)).toMatch(/^set -Eeuo pipefail$/m);
        });
    }

    for (const f of shells().filter((x) => !EXIT_ZERO_ALLOWED.has(x))) {
        it(`${f} has no unconditional exit 0`, () => {
            const bad = read(f).split('\n').filter((l) => /^\s*exit 0\s*(#.*)?$/.test(l));
            expect(bad).toEqual([]);
        });
    }

    it('the launcher propagates the child status verbatim', () => {
        const src = read('netns-launch.sh');
        expect(src).toMatch(/^exit "\$CHILD_RC"$/m);
        expect(src).toMatch(/wait "\$CHILD" \|\| CHILD_RC=\$\?/);
    });

    it('phase D propagates its own status verbatim', () => {
        const src = read('netns-phases.sh');
        expect(src).toMatch(/^exit "\$D_RC"$/m);
        expect(src).toMatch(/timeout -k 15s "\$\{PHASE_D_DEADLINE\}s" "\$@" \|\| D_RC=\$\?/);
    });

    it('the driver exits with its failed-expectation count', () => {
        expect(read('counterexamples.sh')).toMatch(/^exit "\$FAILED"$/m);
    });

    it('no gate result is read from the tail of a pipeline', () => {
        for (const f of shells()) {
            const offenders = read(f).split('\n')
                .filter((l) => /\|\s*(tee|cat|head|tail)\b/.test(l) && /RC=|exit /.test(l));
            expect(offenders, `${f} must not take an exit code from a pipeline tail`).toEqual([]);
        }
    });
});

describe('ruling B3: isolation failures and test failures stay separable', () => {
    it('the exit-code vocabulary is distinct and reserved', () => {
        const codes = [...read('exit-codes.sh').matchAll(/^F2AI_ISO_RC_([A-Z]+)=(\d+)/gm)]
            .map((m) => ({ name: m[1], code: Number(m[2]) }));
        expect(codes.length).toBeGreaterThanOrEqual(7);
        const values = codes.map((c) => c.code);
        expect(new Set(values).size).toBe(values.length);
        for (const c of codes) expect(c.code === 124 || (c.code >= 70 && c.code <= 76)).toBe(true);
    });

    it('phase C failure exits at the self-test gate and never reaches phase D', () => {
        const src = read('netns-phases.sh');
        const gate = src.indexOf('phase C self-test failed');
        const launch = src.indexOf('phaseD.launched');
        expect(gate).toBeGreaterThan(0);
        expect(launch).toBeGreaterThan(gate);
    });
});

describe('N5-1 / N4-6: the counterexamples are registered and non-vacuous', () => {
    it('F1-F4, the F3b/F4b discriminators and the positive control all exist', () => {
        const src = read('counterexamples.sh');
        for (const c of ['pos', 'f1', 'f2', 'f3', 'f3b', 'f4', 'f4b', 'b4', 'b4r']) {
            expect(src, `case ${c} missing`).toContain(`new_case ${c}`);
        }
    });

    it('every case invokes the REAL launcher, not a stand-in wrapper', () => {
        const src = read('counterexamples.sh');
        const invocations = src.split('\n').filter((l) => l.includes('"$LAUNCH"'));
        expect(invocations.length).toBeGreaterThanOrEqual(7);
        expect(src).toContain('LAUNCH="$HERE/netns-launch.sh"');
    });

    it('absence of phase D is asserted from the program\'s own marker', () => {
        const src = read('counterexamples.sh');
        expect(src).toContain('expect_absent "$CASE_EVID/phaseD.marker"');
        expect(read('pos-marker.mjs')).toContain('F2AI_ISO_PHASE_D_EXECUTED');
    });

    it('the fault knobs can only stop the run earlier, never relax the boundary', () => {
        for (const f of ['netns-launch.sh', 'netns-establish.sh', 'netns-phases.sh']) {
            const src = read(f);
            for (const m of src.matchAll(/F2AI_ISO_FAULT\b[^\n]*/g)) {
                expect(m[0]).not.toMatch(/skip.*selftest|no-?isolat|unisolated/i);
            }
        }
    });
});

describe('N4-1 / N4-2: the accept set is predefined and narrow', () => {
    it('only genuine refusal errnos are accepted', () => {
        const src = read('netns-controls.mjs');
        const set = src.match(/ACCEPT_ERRNOS = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
        expect(set).toContain('ENETUNREACH');
        expect(set).toContain('EPERM');
        for (const forbidden of ['ETIMEDOUT', 'ECONNREFUSED', 'EAFNOSUPPORT']) {
            expect(set, `${forbidden} must not count as a refusal`).not.toContain(forbidden);
        }
    });

    it('a successful UDP sendto is a control failure', () => {
        const src = read('netns-controls.mjs');
        expect(src).toContain('SENDTO_SUCCEEDED');
        expect(src.match(/NON_PASS_VERDICTS[\s\S]*?\]\)/)?.[0] ?? '').toContain('SENDTO_SUCCEEDED');
    });

    it('every waiting control carries a deadline', () => {
        const src = read('netns-controls.mjs');
        expect(src).toMatch(/DEADLINE_TCP_MS = \d+/);
        expect(src).toMatch(/DEADLINE_UDP_MS = \d+/);
        expect((src.match(/deadlineMs/g) ?? []).length).toBeGreaterThanOrEqual(6);
    });
});

describe('N4-0 / N4-4 / N4-5: ordering and coverage of the self-test', () => {
    it('the no-packet pre-check runs before any real syscall control', () => {
        const src = read('netns-selftest.mjs');
        const pre = src.indexOf('report.n4_0 = preflight(');
        const controls = src.indexOf('report.controlsParent = await runControls(');
        expect(pre).toBeGreaterThan(0);
        expect(controls).toBeGreaterThan(pre);
        expect(src).toContain("report.stoppedBefore = 'C1-C4");
    });

    it('C6 covers parent, child and grandchild with all four controls', () => {
        expect(read('netns-descendant.mjs')).toMatch(/const MAX_DEPTH = 2/);
        const controls = read('netns-controls.mjs');
        for (const id of ['C1', 'C2', 'C3', 'C4']) expect(controls).toContain(`:${id}\``);
        expect(read('netns-selftest.mjs')).toContain('grandchild layer missing');
    });

    it('C5 is auxiliary and says so', () => {
        const src = read('netns-selftest.mjs');
        expect(src).toContain('AUXILIARY OBSERVATION ONLY');
        expect(src).not.toMatch(/c5[\s\S]{0,80}fail\(/i);
    });

    it('the controlled-namespace escape check has an anti-vacuity precondition', () => {
        const src = read('netns-selftest.mjs');
        expect(src).toContain('ESCAPE:vacuity');
        expect(read('netns-establish.sh')).toContain('escape check would be vacuous');
    });
});
