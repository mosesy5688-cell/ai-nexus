/**
 * Work order N, ruling C c2/c4/c5 -- the attribution decision table, executed.
 *
 * c1 settled that exit codes are NOT remapped: 70-76 were never a reserved
 * range, and verbatim propagation is an intentional honesty property that is
 * not traded away for easier attribution. c4 then demands proof that
 * attribution still works when the program under test exits 70, 71 or 124.
 *
 * scripts/ci/isolation/attribution-cases.sh proves that end to end through the
 * real launcher and needs a Linux runner. This file proves the DECISION TABLE
 * itself, by driving attribute.mjs over synthetic record sets, and it runs
 * anywhere -- so the part that can be checked without a runner is checked.
 *
 * The sharpest case is the last one: two runs with the SAME launcher exit code
 * and different records must produce different verdicts. If they did not, the
 * code would still be the criterion.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ATTRIBUTE = path.join(ROOT, 'scripts', 'ci', 'isolation', 'attribute.mjs');

type Records = Record<string, string>;

/** Build an evidence directory containing exactly the given record files. */
function evidenceWith(records: Records): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2ai-attr-'));
    for (const [name, body] of Object.entries(records)) {
        fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
}

function attribute(records: Records): Records {
    const dir = evidenceWith(records);
    const r = spawnSync(process.execPath, [ATTRIBUTE, dir], { encoding: 'utf8', timeout: 20000 });
    expect(r.status, `attribute.mjs must never fail a run: ${r.stderr}`).toBe(0);
    const text = fs.readFileSync(path.join(dir, 'attribution.txt'), 'utf8');
    const out: Records = {};
    for (const line of text.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
}

/** A run that reached phase D and returned `code`. */
const programExited = (code: number, extra: Records = {}): Records => attribute({
    'launcher.rc': `${code}\n`,
    'launcher.timing': 'elapsed_s=12\ndeadline_s=1800\n',
    'ns-identity.txt': 'sub_netns=net:[4026539999]\n',
    'phaseC.rc': '0\n',
    'phaseD.launched': 'utc=2026-09-22T00:00:00Z\nargv=node x.mjs\n',
    'phaseD.rc': `${code}\n`,
    'phaseD.timing': `elapsed_s=2\ndeadline_s=1500\n`,
    ...extra
});

describe('c4: a program exit is never mistaken for a launcher gate', () => {
    it('the program exits 70 -> PROGRAM_FAILED, not ISOLATION_PRECHECK_FAILED', () => {
        const a = programExited(70);
        expect(a.verdict).toBe('PROGRAM_FAILED');
        expect(a.verdict_class).toBe('TEST');
        expect(a.verdict).not.toBe('ISOLATION_PRECHECK_FAILED');
        expect(a['record.phaseD_rc']).toBe('70');
    });

    it('the program exits 71 -> PROGRAM_FAILED, not ISOLATION_ESTABLISH_FAILED', () => {
        const a = programExited(71);
        expect(a.verdict).toBe('PROGRAM_FAILED');
        expect(a.verdict).not.toBe('ISOLATION_ESTABLISH_FAILED');
    });

    it('the program exits 74 -> PROGRAM_FAILED, not ISOLATION_SELFTEST_FAILED', () => {
        const a = programExited(74);
        expect(a.verdict).toBe('PROGRAM_FAILED');
        expect(a.verdict).not.toBe('ISOLATION_SELFTEST_FAILED');
    });

    it('the program exits 124 itself -> PROGRAM_FAILED, decided from the value', () => {
        // Both layers record a source here, so the files EXIST and the verdict
        // still is not a timeout: `program` and `propagated` say so.
        const a = programExited(124, {
            'phaseD.timeout-source': 'phaseD.timeout-source=program\nelapsed_s=2\ndeadline_s=1500\n',
            'launcher.timeout-source': 'launcher.timeout-source=propagated\nreason=x\n'
        });
        expect(a.verdict).toBe('PROGRAM_FAILED');
        expect(a.timeout_source).toBe('program');
        expect(a['record.phaseD_timeout_source']).toBe('program');
        expect(a['record.launcher_timeout_source']).toBe('propagated');
        expect(a.verdict).not.toBe('PROGRAM_TIMEOUT');
        expect(a.verdict).not.toBe('LAUNCHER_TIMEOUT');
    });

    it('a clean run attributes as PASS', () => {
        const a = programExited(0);
        expect(a.verdict).toBe('PASS');
        expect(a.verdict_class).toBe('PASS');
    });
});

describe('c3: the timeout source is read, never inferred from an absence', () => {
    it('a recorded inner source makes the same 124 a PROGRAM_TIMEOUT', () => {
        const a = programExited(124, {
            'phaseD.timeout-source': 'phaseD.timeout-source=inner\nelapsed_s=1500\ndeadline_s=1500\n',
            'launcher.timeout-source': 'launcher.timeout-source=propagated\nreason=x\n'
        });
        expect(a.verdict).toBe('PROGRAM_TIMEOUT');
        expect(a.timeout_source).toBe('inner');
    });

    it('the SAME files with different values give the two 124 verdicts', () => {
        // The sharpest c3 case. Identical exit code, identical record FILES --
        // only the values differ. If existence were the criterion these two
        // would be one case.
        const inner = programExited(124, {
            'phaseD.timeout-source': 'phaseD.timeout-source=inner\nelapsed_s=1500\ndeadline_s=1500\n',
            'launcher.timeout-source': 'launcher.timeout-source=propagated\nreason=x\n'
        });
        const program = programExited(124, {
            'phaseD.timeout-source': 'phaseD.timeout-source=program\nelapsed_s=2\ndeadline_s=1500\n',
            'launcher.timeout-source': 'launcher.timeout-source=propagated\nreason=x\n'
        });
        expect(inner.exit_code_hint).toBe(program.exit_code_hint);
        expect(inner.verdict).not.toBe(program.verdict);
        expect(inner.verdict).toBe('PROGRAM_TIMEOUT');
        expect(program.verdict).toBe('PROGRAM_FAILED');
    });

    it('a recorded outer source is a LAUNCHER_TIMEOUT and is isolation-side', () => {
        const a = programExited(124, {
            'launcher.timeout-source': 'launcher.timeout-source=outer\nreason=signal\n'
        });
        expect(a.verdict).toBe('LAUNCHER_TIMEOUT');
        expect(a.verdict_class).toBe('ISOLATION');
        expect(a.timeout_source).toBe('outer');
        expect(a.detail).toContain('reason=signal');
    });

    it('`propagated` is NOT a launcher timeout', () => {
        // The outer layer records a value even for a 124 it did not cause, so
        // the record's presence cannot be what makes a launcher timeout.
        const a = programExited(124, {
            'launcher.timeout-source': 'launcher.timeout-source=propagated\nreason=x\n',
            'phaseD.timeout-source': 'phaseD.timeout-source=program\nelapsed_s=2\ndeadline_s=1500\n'
        });
        expect(a.verdict).not.toBe('LAUNCHER_TIMEOUT');
        expect(a.verdict_class).toBe('TEST');
    });

    it('a 124 with NO source recorded is named indeterminate, not guessed', () => {
        // The producers always write a source for a 124, so this state means the
        // evidence set is incomplete. It is reported, not resolved either way.
        const a = programExited(124);
        expect(a.verdict).toBe('PROGRAM_INDETERMINATE');
        expect(a.verdict_class).toBe('INDETERMINATE');
        expect(a.timeout_source).toBe('unrecorded');
        expect(a['record.phaseD_timeout_source']).toBe('absent');
        expect(a.detail).toContain('no timeout source was recorded');
    });
});

describe('the isolation-side verdicts stay distinguishable (ruling B3)', () => {
    it('phase C failed and phase D never launched -> ISOLATION_SELFTEST_FAILED', () => {
        const a = attribute({
            'launcher.rc': '74\n', 'ns-identity.txt': 'sub_netns=net:[1]\n', 'phaseC.rc': '1\n'
        });
        expect(a.verdict).toBe('ISOLATION_SELFTEST_FAILED');
        expect(a['record.phaseD_launched']).toBe('no');
    });

    it('a classified masking failure -> ISOLATION_ESTABLISH_FAILED (b4 shape)', () => {
        const a = attribute({
            'launcher.rc': '71\n', 'ns-identity.txt': 'sub_netns=net:[1]\n',
            'ipc-mask.txt': 'MASKED\t/run/dbus\tTMPFS_DIR\nMASK_FAILED\t/run/docker.sock\tBIND_NULL\trc=32\n'
        });
        expect(a.verdict).toBe('ISOLATION_ESTABLISH_FAILED');
        expect(a.detail).toContain('classified host IPC channel');
    });

    it('nothing recorded at all -> ISOLATION_PRECHECK_FAILED', () => {
        const a = attribute({ 'launcher.rc': '70\n' });
        expect(a.verdict).toBe('ISOLATION_PRECHECK_FAILED');
    });

    it('an FD cleanup violation is named as such', () => {
        const a = attribute({
            'launcher.rc': '73\n', 'ns-identity.txt': 'sub_netns=net:[1]\n',
            'fd-violations.txt': 'unexpected-fd 9 /tmp/evid/fd-bait.txt\n'
        });
        expect(a.verdict).toBe('ISOLATION_FD_CLEANUP_FAILED');
    });
});

describe('c1/c2: the exit code is a hint, not the criterion', () => {
    it('every artifact says so explicitly', () => {
        const a = programExited(70);
        expect(a.basis).toBe('records');
        expect(a.exit_code_is_criterion).toBe('no');
        expect(a.exit_code_hint).toBe('70');
        expect(a.attribution_version).toBe('1');
    });

    it('the SAME exit code with different records gives different verdicts', () => {
        // This is the whole point. launcher.rc is 70 in both.
        const program = programExited(70);
        const precheck = attribute({ 'launcher.rc': '70\n' });
        expect(program.exit_code_hint).toBe(precheck.exit_code_hint);
        expect(program.verdict).not.toBe(precheck.verdict);
        expect(program.verdict).toBe('PROGRAM_FAILED');
        expect(precheck.verdict).toBe('ISOLATION_PRECHECK_FAILED');
    });

    it('generating attribution can never turn a failure into a success', () => {
        const a = programExited(71);
        expect(a.verdict).not.toBe('PASS');
        // attribute.mjs always exits 0 so it cannot alter the launcher's status;
        // the launcher still returns the child's code verbatim.
        const src = fs.readFileSync(ATTRIBUTE, 'utf8');
        expect(src).toContain('process.exit(0)');
        expect(src).not.toMatch(/process\.exit\((?!0\))/);
    });
});
