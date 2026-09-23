/**
 * WO-N-P4 -- DISCRIMINATING POWER for the repaired P9 inherited-FD predicate:
 * the ledger's PARSING and its CLASSIFICATION. The gate's BEHAVIOUR -- that a
 * red P9 actually stops the run -- is pinned in isolation-p9-gate-behaviour.
 *
 * P9 was DOUBLE-VACUOUS on run 35758594726 (V6.1 Test Suite, head 8852b2011,
 * artifact isolation-evidence): F3b kept an uncleaned descriptor, the launcher
 * did not go red and phaseD.marker existed. Three of the four locked properties
 * get one describe block each here:
 *
 *  (i)   the inventoried set is EXACTLY what is about to be inherited -- the
 *        fds held, before exec, by the process that will exec the program --
 *        and NO extra exec may be used to obtain it;
 *  (ii)  the allow-list judges the TARGET, never the number;
 *  (iii) the parser may not silently drop a line: parsed < recorded is FAIL.
 *
 * tests/ci/fixtures/wo-n-p4 holds three artefacts of that run, and they are NOT
 * all of one kind. Each is sha256-pinned below; the labels are exact:
 *   f3b-fd-final-WITH-BAIT.txt  BYTE-IDENTICAL to the artifact's f3b ledger.
 *   pos-fd-final-CLEAN.txt      BYTE-IDENTICAL to the artifact's pos ledger.
 *   f3b-P9-observed-...json     JSON-EQUAL ONLY. The artifact carries this
 *     object LF-only at 10-space indent inside selftest-report.json; this copy
 *     is a 2-space, CRLF re-serialization. Its BYTES are not the artifact's
 *     bytes and it must never be described as verbatim.
 *
 * WHAT THIS DOES NOT PROVE: nothing here enters a namespace or executes
 * netns-phases.sh; these are parsing, classification and source assertions.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    parseFdDump, strayFds, strayReason, readFdLedger
} from '../../scripts/ci/isolation/fd-ledger.mjs';
import { preflight } from '../../scripts/ci/isolation/netns-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'tests', 'ci', 'fixtures', 'wo-n-p4');
const ISO = path.join(ROOT, 'scripts', 'ci', 'isolation');

const src = (f: string): string =>
    fs.readFileSync(path.join(ISO, f), 'utf8').replace(/\r\n/g, '\n');
const bytes = (f: string): Buffer => fs.readFileSync(path.join(FIX, f));
const sha = (f: string): string => createHash('sha256').update(bytes(f)).digest('hex');
const text = (f: string): string => bytes(f).toString('utf8');
const crs = (f: string): number => (text(f).match(/\r/g) ?? []).length;

const F3B = 'f3b-fd-final-WITH-BAIT.txt';
const POS = 'pos-fd-final-CLEAN.txt';
const OBS = 'f3b-P9-observed-WRONGLY-PASSED.json';
const PHASES = '/home/runner/work/ai-nexus/ai-nexus/'
    + 'scripts/ci/isolation/netns-phases.sh';

it('the fixtures are pinned: sha256, byte length, CR count', () => {
    // The two LEDGERS are the artifact's own bytes, pure LF as the shell wrote
    // them, and the parser refuses a CR. The OBSERVATION is a re-serialization
    // and carries CRLF; it is kept exactly as extracted, not renormalised.
    // .gitattributes marks this directory -text: no checkout may rewrite it.
    expect([sha(F3B), bytes(F3B).length, crs(F3B)]).toEqual(
        ['e2831ffaa8cae600a2bc54e4c5478d2aea2f62793b3137ef0f1b6c25f03aebde', 414, 0]);
    expect([sha(POS), bytes(POS).length, crs(POS)]).toEqual(
        ['38ce427267b3421cfe0b6ea49883c105e97f26a1f70f8d325783c4bf00256d93', 307, 0]);
    expect([sha(OBS), bytes(OBS).length, crs(OBS)]).toEqual(
        ['c1693ea9130654c00fa730c51a3642efbb91eec408355f9d191fa1876434e96d', 374, 23]);
});

describe('(i) the pre-exec ledger, obtained with NO extra exec', () => {
    it('fd-ledger.mjs imports node:fs and NOTHING else -- it spawns nothing', () => {
        expect(src('fd-ledger.mjs').match(/^import .*$/gm))
            .toEqual(["import fs from 'node:fs';"]);
        for (const banned of ['child_process', 'spawnSync', 'spawn(', 'execSync']) {
            expect(src('fd-ledger.mjs'), banned).not.toContain(banned);
        }
    });

    it('netns-probe.mjs takes no inventory by exec, and run() survives for ip', () => {
        const s = src('netns-probe.mjs');
        for (const gone of ['inheritedFdInventory', 'ls -l /proc/self/fd',
            'READDIR_TARGET', 'FD_INVENTORY_CMD']) {
            expect(s, gone).not.toContain(gone);
        }
        expect(s).toContain("import { readFdLedger } from './fd-ledger.mjs';");
        expect(s).toContain('const ledger = readFdLedger(fdLedger, { selfProgram });');
        expect(s).toContain('ledger.ok && ledger.stray.length === 0');
        expect(s).toContain("run('ip', ['-o', 'link', 'show'])");
        expect(s.match(/run\('/g)?.length).toBe(1);
    });

    it('the record is written by the shell that execs phase D, BEFORE that exec', () => {
        const sh = src('netns-phases.sh');
        expect(sh).toContain('SHELL_PID=$$');
        expect(sh).toContain('for p in "/proc/$SHELL_PID/fd/"*');
        const write = sh.indexOf('>>"$EVID/fd-final.txt"');
        const selftest = sh.indexOf('node "$HERE/netns-selftest.mjs"');
        const exec = sh.indexOf('timeout -k 15s "${PHASE_D_DEADLINE}s" "$@"');
        expect(write).toBeGreaterThan(0);
        expect(selftest).toBeGreaterThan(write);
        expect(exec).toBeGreaterThan(selftest);
    });

    it('netns-selftest.mjs hands P9 that path and NAMES the script for fd 255', () => {
        const s = src('netns-selftest.mjs');
        expect(s).toContain('const FD_LEDGER = (evid) => `${evid}/fd-final.txt`;');
        expect(s).toContain("new URL('./netns-phases.sh', import.meta.url)");
        expect(s).toContain('fdLedger: FD_LEDGER(evid), selfProgram: PHASES_SCRIPT');
    });

    it('preflight READS that file: the F3b ledger is red, the positive one '
        + 'green, and no ledger at all is FAILURE', () => {
        const p9 = (o: Record<string, unknown>): any => preflight({
            hostNetns: 'host', hostUserns: 'hostu', targetUid: '1001', ...o
        }).checks.find((c: { id: string }) => c.id === 'P9-no-stray-fds');
        const red = p9({ fdLedger: path.join(FIX, F3B), selfProgram: PHASES });
        expect(red.ok).toBe(false);
        expect(red.observed.stray.map((s: { fd: string }) => s.fd)).toEqual(['9']);
        expect(red.observed.handedDown.length).toBe(5);
        expect(p9({ fdLedger: path.join(FIX, POS), selfProgram: PHASES }).ok).toBe(true);
        const gone = p9({ fdLedger: path.join(os.tmpdir(), 'no-such-fd-final.txt') });
        expect(gone.ok).toBe(false);
        expect(String(gone.observed.reason)).toContain('unreadable');
        expect(p9({}).ok).toBe(false);
    });
});

describe('(ii) the allow-list judges the TARGET, never the number', () => {
    const one = (fd: string, target: string, selfProgram: string | null = PHASES): any[] =>
        strayFds([{ fd, target }], { selfProgram });

    it('a socket is stray on ANY fd -- 0, 1 and 2 included', () => {
        for (const fd of ['0', '1', '2', '3', '9', '255']) {
            expect(one(fd, 'socket:[19050]').map((s) => s.fd), `fd ${fd}`).toEqual([fd]);
        }
    });

    it('0/1/2 may be /dev/null, a pipe, a tty or a regular file, nothing else', () => {
        for (const t of ['/dev/null', 'pipe:[100]', '/dev/pts/3', '/dev/tty',
            '/home/runner/work/x/driver.stdout']) expect(one('1', t), t).toEqual([]);
        const bad = ['anon_inode:[io_uring]', '/proc/369/fd', 'UNREADABLE',
            '/tmp/x (deleted)', 'socket:[1]', '/sys/class/net'];
        for (const t of bad) expect(one('2', t).length, t).toBe(1);
    });

    it('B4: a DIRECTORY on 0/1/2 is refused -- the locked list says regular FILE', () => {
        // Measured against this machine's own filesystem so it holds on either
        // platform: the working directory IS a directory, package.json is not.
        const dir = process.cwd().replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
        expect(fs.statSync(dir).isDirectory()).toBe(true);
        expect(one('0', dir).length, dir).toBe(1);
        expect(one('0', `${dir}/package.json`), dir).toEqual([]);
        // Directory tells caught by shape alone, on any filesystem at all.
        for (const t of ['/some/dir/', '/some/dir/..', '/some/dir/.']) {
            expect(one('0', t).length, t).toBe(1);
        }
    });

    it('a shape that merely RESEMBLES an allowed target is refused', () => {
        // isTty is anchored: tty<digits>, pts/<digits> or console, exactly.
        for (const t of ['/dev/ttyfoo', '/dev/pts/x', '/dev/ttyS0x', '/dev/consolex']) {
            expect(one('1', t).length, t).toBe(1);
        }
        // isPipe is the `pipe:` prefix, not a filesystem whose name starts pipe.
        expect(one('1', 'pipefs').length).toBe(1);
        // fd 255 is string equality with the named script, not a suffix of it.
        expect(one('255', `/attacker${PHASES}`).length).toBe(1);
        expect(one('255', `${PHASES}.bak`).length).toBe(1);
    });

    it('255 is the script being executed or it is stray, and it is NAMED', () => {
        expect(one('255', PHASES)).toEqual([]);
        expect(one('255', '/home/runner/work/ai-nexus/ai-nexus/other.sh').length).toBe(1);
        expect(one('255', PHASES, null).length).toBe(1);
    });

    it('every other number is stray whatever it points at: the readdir '
        + 'exemption is gone, and neither real ledger ever needed it', () => {
        expect(one('3', '/proc/914/fd').length).toBe(1);
        expect(one('9', '/home/runner/work/x/fd-bait.txt').length).toBe(1);
        for (const f of [F3B, POS]) {
            expect(parseFdDump(text(f)).entries
                .some((e: { target: string }) => /^\/proc\/\d+\/fd$/.test(e.target)), f)
                .toBe(false);
        }
    });

    it('strayReason says WHICH rule refused, so P9 never just says no, and the '
        + 'socket rule is the one that answers for a socket', () => {
        expect(strayReason({ fd: '1', target: 'socket:[19050]' }, PHASES))
            .toMatch(/^socket descriptor/);
        expect(strayReason({ fd: '255', target: 'socket:[1]' }, PHASES))
            .toMatch(/^socket descriptor/);
        expect(strayReason({ fd: '9', target: '/x/y' }, PHASES)).toContain('inherited');
        expect(strayReason({ fd: '0', target: 'anon_inode:[x]' }, PHASES)).toContain('stdio');
        expect(strayReason({ fd: '255', target: '/x/other.sh' }, PHASES)).toContain('255');
        expect(strayReason({ fd: '0', target: '/dev/null' }, PHASES)).toBe(null);
    });
});

describe('(iii) the parser may not silently drop a line', () => {
    it('both real ledgers parse completely', () => {
        for (const [f, n] of [[F3B, 5], [POS, 4]] as Array<[string, number]>) {
            const r = parseFdDump(text(f));
            expect([r.ok, r.recorded, r.entries.length], f).toEqual([true, n, n]);
        }
    });

    it('a line it cannot read fails the WHOLE ledger and says how many', () => {
        const r = parseFdDump(`${text(POS)}not a ledger line\n`);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('parsed 4 of 5 recorded lines');
        expect(r.unparsed).toEqual(['not a ledger line']);
        // The four it did read are still returned: the verdict narrowed, the
        // evidence did not.
        expect(r.entries.length).toBe(4);
    });

    it('a blank line counts as recorded, and an fd must be digits + one tab', () => {
        const blank = parseFdDump('0\t/dev/null\n\n1\tpipe:[1]\n');
        expect([blank.ok, blank.recorded, blank.entries.length]).toEqual([false, 3, 2]);
        expect(parseFdDump('x\t/dev/null\n').ok).toBe(false);
        expect(parseFdDump('0 /dev/null\n').ok).toBe(false);
        // MUT-5: a TRAILING blank is a line too, and only one is discarded.
        expect(parseFdDump('0\t/dev/null\n\n').ok).toBe(false);
    });

    it('the ls -l shape the old parser also accepted is now a FAILURE', () => {
        const r = parseFdDump('lrwx------ 1 r r 64 Sep 22 13:26 0 -> /dev/null\n');
        expect([r.ok, r.recorded, r.entries.length]).toEqual([false, 1, 0]);
    });

    it('an empty, blank or CR-mangled ledger is a FAILURE, never a skip', () => {
        expect([parseFdDump('').ok, parseFdDump('').reason])
            .toEqual([false, 'the ledger is empty']);
        expect(parseFdDump('\n').ok).toBe(false);
        expect(parseFdDump(text(POS).replace(/\n/g, '\r\n')).ok).toBe(false);
    });

    it('readFdLedger propagates the floor and still reports what it saw', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-ledger-'));
        const p = path.join(dir, 'fd-final.txt');
        fs.writeFileSync(p, `${text(F3B)}not a ledger line\n`);
        const r = readFdLedger(p, { selfProgram: PHASES });
        expect([r.ok, r.recorded, r.entries.length]).toEqual([false, 6, 5]);
        expect(r.stray.map((s: { fd: string }) => s.fd)).toEqual(['9']);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
