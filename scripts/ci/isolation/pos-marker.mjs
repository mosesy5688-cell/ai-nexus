// Free2AITools work order N -- the non-vacuous POSITIVE control's program.
//
// N4-6: the positive control must prove the DESIGNATED program under test really
// executed and left a PREDEFINED marker (it need not reach the internet). The
// pre-failure counterexamples then assert the absence of that SAME marker plus
// process-execution evidence -- "I saw no log line" is not allowed to stand in
// for "it never started".
//
// So the marker below is written BY THIS PROGRAM, not by the launcher, and it
// carries the identity facts that only a process actually running at the final
// identity inside the boundary could report: its own pid, its uid line, its
// network-namespace id, its capability sets and its own FD table.
import fs from 'node:fs';

const readLink = (p) => { try { return fs.readlinkSync(p); } catch { return 'UNREADABLE'; } };
const status = (() => { try { return fs.readFileSync('/proc/self/status', 'utf8'); } catch { return ''; } })();
const field = (n) => {
    const m = status.match(new RegExp(`^${n}:\\s*(.*)$`, 'm'));
    return m ? m[1].trim() : null;
};

const nonce = process.argv[2];
if (!nonce) {
    process.stderr.write('pos-marker: a nonce argument is required\n');
    process.exit(2);
}
const evid = process.env.F2AI_ISO_EVID;
if (!evid) {
    process.stderr.write('pos-marker: F2AI_ISO_EVID is not set\n');
    process.exit(2);
}

let fds = [];
try {
    fds = fs.readdirSync('/proc/self/fd').map((f) => `${f}=${readLink(`/proc/self/fd/${f}`)}`);
} catch { fds = ['UNREADABLE']; }

const marker = {
    marker: 'F2AI_ISO_PHASE_D_EXECUTED',
    nonce,
    utc: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    uidLine: field('Uid'),
    gidLine: field('Gid'),
    groups: field('Groups'),
    capEff: field('CapEff'),
    capBnd: field('CapBnd'),
    noNewPrivs: field('NoNewPrivs'),
    netns: readLink('/proc/self/ns/net'),
    userns: readLink('/proc/self/ns/user'),
    pidns: readLink('/proc/self/ns/pid'),
    fds
};
fs.writeFileSync(`${evid}/phaseD.marker`, `${JSON.stringify(marker, null, 2)}\n`);
process.stdout.write(`F2AI_ISO_PHASE_D_EXECUTED ${nonce}\n`);
