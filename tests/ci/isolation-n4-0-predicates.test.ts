/**
 * WO-N-P3 -- DISCRIMINATING POWER for the four N4-0 predicates that came back
 * FALSE NEGATIVE on run 35733326729 (artifact `isolation-evidence`).
 *
 * All four reported FAIL while the reality captured inside the very same
 * namespace said the opposite, and all four failed CLOSED, so phase D never
 * started. None was a boundary violation; each was a probe reading the wrong
 * source or the wrong line. A repair may therefore only make a predicate MORE
 * ACCURATE, never more permissive, so every case below that widens anything is
 * paired with one showing that a real violation is still caught.
 *
 * tests/ci/fixtures/wo-n-p3 holds VERBATIM bytes from that run: the four
 * observed values the self-test reported, and the baselines the launcher wrote
 * in the same namespace at the same identity. Nothing here is invented except
 * material explicitly labelled synthetic. Each predicate gets three cases:
 * (a) the PRE-FIX parser, quoted from the code at 0092f3b92, produces the wrong
 * answer that blocked the run; (b) the SHIPPED parser gets the same bytes right
 * AND judges that namespace's baseline PASSING; (c) the MUTANT the work order
 * names produces the pre-fix answer again, so reverting the fix is red.
 *
 * WHAT THIS DOES NOT PROVE: nothing here enters a namespace. These are pure
 * parsing tests over recorded bytes; the runtime proof needs a Linux runner.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parseLinkShow, parseProcRoutes, statusField, parseFdDump, inheritedFds
} from '../../scripts/ci/isolation/netns-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'tests', 'ci', 'fixtures', 'wo-n-p3');
const PROBE = path.join(ROOT, 'scripts', 'ci', 'isolation', 'netns-probe.mjs');

const text = (f: string): string =>
    fs.readFileSync(path.join(FIX, f), 'utf8').replace(/\r\n/g, '\n');
const json = (f: string): any => JSON.parse(text(f));
const probeSrc = (): string => fs.readFileSync(PROBE, 'utf8').replace(/\r\n/g, '\n');
const split = (v: string | null): string[] => (v || '').split(/\s+/).filter(Boolean);

/** The P1 verdict exactly as preflight() forms it, so both sides agree. */
const loOnly = (links: Array<{ name: string }>): boolean =>
    links.length > 0 && links.every((i) => i.name === 'lo');

describe('P1-interfaces: the source has to be namespace-scoped', () => {
    it('(a) PRE-FIX: the sysfs enumeration the runner returned FAILS', () => {
        const observed = json('P1-interfaces.observed.json');
        expect(observed.map((i: { name: string }) => i.name))
            .toEqual(['docker0', 'enP26900s1', 'eth0', 'lo']);
        // docker0 / enP26900s1 / eth0 are the HOST's. sysfs is not remounted,
        // so this list never described the namespace the probe was running in.
        expect(loOnly(observed)).toBe(false);
    });

    it('(b) POST-FIX: the same namespace via ip -o link show PASSES, and a '
        + 'genuinely bridged one is still caught', () => {
        const links = parseLinkShow(text('baseline-inside-links.txt'));
        expect(links).toEqual([{ name: 'lo', operstate: 'unknown' }]);
        expect(loOnly(links)).toBe(true);
        const bridged = `${text('baseline-inside-links.txt')}\n`
            + '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq '
            + 'state UP mode DEFAULT group default qlen 1000';
        expect(parseLinkShow(bridged).map((i) => i.name)).toEqual(['lo', 'eth0']);
        expect(loOnly(parseLinkShow(bridged))).toBe(false);
    });

    it('(c) MUTANT: going back to the sysfs source is red', () => {
        // The mutant is a source swap, so it is pinned at the source: the probe
        // must not read anything under /sys, in any form.
        expect(probeSrc()).not.toContain('/sys');
        expect(probeSrc()).toContain("run('ip', ['-o', 'link', 'show'])");
        // ...and this is the answer that source would hand the predicate.
        expect(loOnly(json('P1-interfaces.observed.json'))).toBe(false);
    });
});

describe('P2-no-default-route: loopback rows are not routes off the box', () => {
    const obs = () => json('P2-no-default-route.observed.json');
    /** The pre-fix v6 counter, quoted from netns-probe.mjs at 0092f3b92. */
    const preV6 = (rows: string[]): number =>
        rows.filter((l) => /^0{32}\s+00\s/.test(l)).length;

    it('(a) PRE-FIX: counts two IPv6 default routes, both of them lo', () => {
        const o = obs();
        expect([o.v4Entries, o.v4Default, o.v6Entries, o.v6Default]).toEqual([0, 0, 3, 2]);
        expect(preV6(o.v6Raw)).toBe(2);
        // Every one of the three rows has output device lo.
        expect(o.v6Raw.every((l: string) => l.trim().split(/\s+/).pop() === 'lo')).toBe(true);
    });

    it('(b) POST-FIX: the same bytes, no default route, evidence intact', () => {
        const o = obs();
        const r = parseProcRoutes(`Iface\tDestination\n${o.v4Raw.join('\n')}`,
            o.v6Raw.join('\n'));
        expect([r.v4Default, r.v6Default]).toEqual([0, 0]);
        // The rows themselves are still reported: the verdict narrowed, the
        // evidence did not.
        expect(r.v6Entries).toBe(3);
        expect(r.v6Raw).toEqual(o.v6Raw);
    });

    it('(b) and the ip route baselines from that namespace PASS', () => {
        // Both files are zero bytes: `ip route show` and `ip -6 route show`
        // inside that namespace listed no route at all, default or otherwise.
        expect(text('baseline-inside-route4.txt')).toBe('');
        expect(text('baseline-inside-route6.txt')).toBe('');
        const r = parseProcRoutes(text('baseline-inside-route4.txt'),
            text('baseline-inside-route6.txt'));
        expect([r.v4Default, r.v6Default, r.v4Entries, r.v6Entries]).toEqual([0, 0, 0, 0]);
    });

    it('(b) a default route on a REAL device is still counted', () => {
        const v6 = obs().v6Raw[0].replace(/lo$/, 'eth0');
        expect(parseProcRoutes('header', v6).v6Default).toBe(1);
        const v4 = 'Iface\tDestination\neth0\t00000000\t0100000A\t0003\t0\t0\t100';
        expect(parseProcRoutes(v4, '').v4Default).toBe(1);
        expect(parseProcRoutes(v4.replace('eth0', 'lo\t'), '').v4Default).toBe(0);
    });

    it('(c) MUTANT: dropping the lo exclusion brings the false negative back', () => {
        expect(preV6(obs().v6Raw)).toBe(2);
        expect(probeSrc()).toContain('v6Dev(l) !== LOOPBACK');
        expect(probeSrc()).toContain('v4Dev(l) !== LOOPBACK');
    });
});

describe('P7-groups-cleared: the match may not leave its own line', () => {
    /**
     * A faithful reconstruction of the relevant lines of /proc/self/status in
     * that namespace. Groups is EMPTY and the kernel prints it as "Groups:\t \n"
     * -- the trailing space is its documented legacy -- with NStgid immediately
     * after. The baseline records the empty Groups line and the observed value
     * records NStgid's contents, so these two lines are what was there.
     */
    const STATUS = 'Uid:\t1001\t1001\t1001\t1001\nGid:\t1001\t1001\t1001\t1001\n'
        + 'FDSize:\t256\nGroups:\t \nNStgid:\t351\nNSpid:\t351\n'
        + 'CapInh:\t0000000000000000\nNoNewPrivs:\t1\n';
    /** The pre-fix field reader, quoted from netns-probe.mjs at 0092f3b92. */
    const preField = (s: string, k: string): string | null => {
        const m = s.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
        return m ? m[1].trim() : null;
    };

    it('(a) PRE-FIX: reproduces the observed wrong value EXACTLY', () => {
        expect(json('P7-groups-cleared.observed.json')).toEqual(['NStgid:', '351']);
        expect(split(preField(STATUS, 'Groups')))
            .toEqual(json('P7-groups-cleared.observed.json'));
    });

    it('(b) POST-FIX: the same bytes report no supplementary groups', () => {
        expect(split(statusField(STATUS, 'Groups'))).toEqual([]);
        // The recorded final identity agrees on every count.
        const fin = text('baseline-final-identity.txt');
        expect(fin).toContain('groups=Groups:  ');
        expect(fin.match(/^Cap\w+:\t0+$/gm)?.length).toBe(5);
        expect(fin).toContain('NoNewPrivs:\t1');
    });

    it('(b) every other field reads as it did, and REAL groups still report', () => {
        expect(split(statusField(STATUS, 'Uid'))).toEqual(['1001', '1001', '1001', '1001']);
        expect(statusField(STATUS, 'CapInh')).toBe('0000000000000000');
        expect(statusField(STATUS, 'NoNewPrivs')).toBe('1');
        expect(statusField(STATUS, 'Seccomp')).toBe(null);
        const withGroups = STATUS.replace('Groups:\t \n', 'Groups:\t4 24 27 \n');
        expect(split(statusField(withGroups, 'Groups'))).toEqual(['4', '24', '27']);
    });

    it('(c) MUTANT: restoring the newline-crossing pattern is red', () => {
        expect(split(preField(STATUS, 'Groups'))).toEqual(['NStgid:', '351']);
        expect(probeSrc()).toContain(String.raw`:[ \\t]*(.*)$`);
        expect(probeSrc()).not.toContain(String.raw`:\\s*(.*)$`);
    });

    it('(c) MUTANT: dropping the ^ anchor is red', () => {
        // XGroups is SYNTHETIC -- no such key exists in /proc/self/status. It
        // is here only to give the anchor something to discriminate, because
        // an unanchored key matches as the suffix of any longer key.
        const decoy = `XGroups:\t27 999 \n${STATUS}`;
        const unanchored = decoy.match(new RegExp('Groups:[ \\t]*(.*)$', 'm'));
        expect(split(unanchored?.[1] ?? null)).toEqual(['27', '999']);
        expect(split(statusField(decoy, 'Groups'))).toEqual([]);
    });
});

describe('P9-no-stray-fds: inheritance, not the probe own descriptors', () => {
    type Fd = { fd: string; target: string };
    const observed = (): Fd[] => json('P9-no-stray-fds.observed.json');
    const PHASES = '/home/runner/work/ai-nexus/ai-nexus/'
        + 'scripts/ci/isolation/netns-phases.sh';
    /** The pre-fix predicate, quoted from netns-probe.mjs at 0092f3b92. */
    const preStray = (fds: Fd[]): Fd[] => fds.filter((f) => !['0', '1', '2'].includes(f.fd)
        && !f.target.startsWith('anon_inode:') && !/^\/proc\/\d+\/fd$/.test(f.target));

    it('(a) PRE-FIX: FAILS on the Node runtime own descriptors', () => {
        const fds = observed();
        const offenders = preStray(fds);
        expect(offenders.length).toBe(9);
        // All nine are Node's own internal pipes plus fd 20, the readdir's own
        // handle, already closed by the time it was readlinked.
        expect(offenders.every((f) => f.target.startsWith('pipe:')
            || f.target === 'UNREADABLE')).toBe(true);
        // Nothing inherited was actually present: no socket, no foreign path.
        expect(fds.filter((f) => f.target.startsWith('socket:'))).toEqual([]);
    });

    it('(b) POST-FIX: the recorded final-identity inventory PASSES, and the '
        + 'allowance that lets it pass is narrow', () => {
        const entries = parseFdDump(text('baseline-fd-final.txt'));
        expect(entries.map((e) => e.fd)).toEqual(['0', '1', '2', '255']);
        // 255 is the script bash is executing. bash opens it AT exec, so it was
        // never inherited -- but the caller has to NAME it; no shape is waved
        // through on the strength of looking runtime-ish.
        expect(inheritedFds(entries, { selfProgram: PHASES })).toEqual([]);
        expect(inheritedFds(entries).map((e) => e.fd)).toEqual(['255']);
    });

    it('(b) a minimal exec-ed inventory passes with nothing declared', () => {
        const ls = ['lrwx------ 1 r r 64 Sep 22 13:26 0 -> /dev/null',
            'l-wx------ 1 r r 64 Sep 22 13:26 1 -> /tmp/out',
            'l-wx------ 1 r r 64 Sep 22 13:26 2 -> /tmp/err',
            'lr-x------ 1 r r 64 Sep 22 13:26 3 -> /proc/914/fd'].join('\n');
        expect(parseFdDump(ls).map((e) => e.fd)).toEqual(['0', '1', '2', '3']);
        expect(inheritedFds(parseFdDump(ls))).toEqual([]);
    });

    it('(c) MUTANT: charging the probe own descriptors as inherited is red', () => {
        // This IS the pre-fix reading: 18 of Node's own descriptors billed as
        // handed down. The shipped gate must take its inventory elsewhere.
        expect(inheritedFds(observed()).length).toBe(18);
        expect(probeSrc()).toContain('inheritedFdInventory()');
        expect(probeSrc()).toMatch(/P9-no-stray-fds', handedDown\.ok/);
        expect(probeSrc()).not.toMatch(/P9-no-stray-fds', fds\./);
        // And an inventory that cannot be taken at all is a FAILURE, not a skip.
        expect(probeSrc()).toContain('handedDown.ok && strayFds.length === 0');
        expect(probeSrc()).toContain('ok: false, reason:');
    });

    it('(c) MUTANT: a blanket anon_inode/pipe pass would be MORE permissive', () => {
        const child = parseFdDump('3\tsocket:[99]\n4\tpipe:[100]\n'
            + '5\tanon_inode:[io_uring]\n6\t/home/runner/.netrc');
        // The shipped rule refuses all four in an exec-ed process.
        expect(inheritedFds(child).map((e) => e.fd)).toEqual(['3', '4', '5', '6']);
        // A blanket allowance would let the pipe and the io_uring through.
        const blanket = (f: Fd): boolean => f.target.startsWith('anon_inode:')
            || f.target.startsWith('pipe:');
        expect(child.filter((f) => !blanket(f)).map((e) => e.fd)).toEqual(['3', '6']);
    });
});
