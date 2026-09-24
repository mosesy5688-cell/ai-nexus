// Free2AITools work order N -- phase C self-test, run at the FINAL identity.
//
// Order is not decorative. N4-0 first: a NO-PACKET pre-check that we are in the
// expected new namespace with the expected interfaces, routes, privilege and FD
// state. Only if that passes do the real syscall controls C1-C4 run, then the
// host-IPC audit (N3-3), then C6 across parent/child/grandchild, then the
// controlled-namespace escape check (N2-3), and finally C5 -- which is an
// AUXILIARY observation and is never load-bearing for P-2 (N4-5).
//
// Exit 0 = the boundary is proven from inside at this identity.
// Exit 1 = it is not, and the caller must NOT start phase D.
import fs from 'node:fs';
import dns from 'node:dns';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflight } from './netns-probe.mjs';
import { inspectChannels } from './netns-ipc.mjs';
import { runControls, isPass, ACCEPT_ERRNOS } from './netns-controls.mjs';
import { spawnDescendant } from './netns-descendant.mjs';

const OVERALL_DEADLINE_MS = 120000;
const ESCAPE_DEADLINE_MS = 5000;
const C5_DEADLINE_MS = 3000;
const C5_NAME = 'c5-auxiliary-observation.invalid';

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// WO-N-P4. The shell that wrote $EVID/fd-final.txt from its own /proc/<pid>/fd
// is the shell that execs phase D, and the script it is executing is this
// file's sibling -- netns-phases.sh runs `node "$HERE/netns-selftest.mjs"`.
// P9 accepts fd 255 only when it points HERE. Named by the caller, never
// guessed from a shape.
const PHASES_SCRIPT = fileURLToPath(new URL('./netns-phases.sh', import.meta.url));
const FD_LEDGER = (evid) => `${evid}/fd-final.txt`;

function readParams(file) {
    const out = {};
    for (const line of readText(file).split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
}

const withDeadline = (p, ms, tag) => Promise.race([
    p.then((value) => ({ ok: true, value }), (e) => ({ ok: false, code: e?.code ?? null, message: String(e?.message) })),
    new Promise((r) => setTimeout(() => r({ ok: false, code: 'DEADLINE', message: `${tag} exceeded ${ms}ms` }), ms))
]);

/**
 * WO-N-P3 (5). The target has to still BE there before its refusal means
 * anything. A CTRL_PID that has already exited takes /proc/<pid>/ns/net with
 * it, and nsenter then fails for a reason with nothing to do with the boundary.
 */
function controlLiveness(nsPath, ctrlPid) {
    if (!ctrlPid) return 'CTRL_PID is absent from the params file';
    try { process.kill(Number(ctrlPid), 0); } catch (e) {
        // EPERM means alive but not ours to signal; only ESRCH means gone.
        if (e?.code !== 'EPERM') return `CTRL_PID ${ctrlPid} is not alive (${e?.code})`;
    }
    try { fs.readlinkSync(nsPath); } catch (e) { return `${nsPath} unreadable (${e?.code})`; }
    return null;
}

/**
 * WO-N-P3 (5), second half, CORRECTED BY WO-N-P4 B3. ENOENT and EPERM are not
 * the same answer. The pre-N-P3 code mapped EVERY non-zero nsenter exit to
 * REFUSED, so a namespace that had simply vanished read as a boundary holding.
 * N-P3 separated the two but let the wrong alternative decide.
 *
 * `cannot open` names the OPERATION, not the failure, and so discriminates
 * between no two errnos at all. N-P3 made it an ENOENT alternative and tested
 * it FIRST, so an open failure carrying a PERMISSION errno was recorded as
 * "the target vanished" -- a boundary that HELD, mislabelled. That class is
 * INDETERMINATE now: honest about what is not known, and still stopping the
 * run, because the escape check accepts REFUSED and nothing else.
 *
 * It is deliberately NOT promoted to REFUSED. That would widen the escape gate
 * for a message class this facility has never produced -- all nine escape
 * cases of run 35758594726 report `reassociate to namespace 'ns/net' failed:
 * Operation not permitted` -- and F-6 forbids a looser predicate. The REFUSED
 * set is therefore UNCHANGED from 8852b2011, element for element; only the
 * label on two never-observed classes moves, and both still stop the run.
 *
 * Every verdict other than REFUSED stops the run -- JOINED above all, since it
 * means the join SUCCEEDED and the boundary did not hold.
 */
function classifyNsenter(code, stderr) {
    const s = String(stderr).toLowerCase();
    if (code === 0) return 'JOINED';
    if (/no such file or directory|does not exist/.test(s)) return 'FAIL-vacuous';
    // An open failure states no boundary fact, whatever errno follows it.
    if (/cannot open/.test(s)) return 'INDETERMINATE';
    if (/operation not permitted|permission denied/.test(s)) return 'REFUSED';
    return 'INDETERMINATE';
}

/** N2-3: try to join a CONTROLLED namespace. Never the real host, never traffic. */
function escapeControl(nsPath, ctrlPid) {
    const dead = controlLiveness(nsPath, ctrlPid);
    if (dead !== null) {
        return Promise.resolve({ nsPath, verdict: 'FAIL-vacuous', detail: dead, stderr: '' });
    }
    return new Promise((resolve) => {
        let done = false;
        let err = '';
        const child = spawn('nsenter', [`--net=${nsPath}`, '--', 'true'],
            { stdio: ['ignore', 'ignore', 'pipe'] });
        const finish = (verdict, detail) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch { /* already exited */ }
            resolve({ nsPath, verdict, detail, stderr: err.trim().slice(0, 400) });
        };
        const timer = setTimeout(() => finish('INDETERMINATE', 'no result before deadline'),
            ESCAPE_DEADLINE_MS);
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => finish('TOOL_MISSING', `nsenter could not run: ${e?.code}`));
        child.on('close', (code) => finish(classifyNsenter(code, err), `nsenter exit ${code}`));
    });
}

async function c5Auxiliary() {
    let servers = [];
    try { servers = dns.getServers(); } catch { servers = ['UNREADABLE']; }
    return {
        note: 'AUXILIARY OBSERVATION ONLY. Not load-bearing for P-2 (N4-5). A cache '
            + 'hit, a hosts-file hit or a resolver error code cannot on their own prove '
            + 'egress blocking, and no uncontrolled comparison is fired at the host '
            + 'default resolver.',
        resolutionPath: 'inside the namespace; /etc/resolv.conf as visible here; no '
            + 'route exists, so any query that leaves the stub resolver cannot be delivered',
        api: ['dns.promises.lookup -> getaddrinfo(3)', 'dns.promises.resolve4 -> c-ares over UDP'],
        name: C5_NAME,
        servers,
        resolvConf: readText('/etc/resolv.conf').split('\n').slice(0, 20),
        lookup: await withDeadline(dns.promises.lookup(C5_NAME), C5_DEADLINE_MS, 'lookup'),
        resolve4: await withDeadline(dns.promises.resolve4(C5_NAME), C5_DEADLINE_MS, 'resolve4')
    };
}

async function main() {
    const params = readParams(process.argv[2]);
    const evid = params.EVID;
    const report = {
        utc: new Date().toISOString(),
        acceptErrnos: ACCEPT_ERRNOS,
        params: {
            mode: params.MODE, hostNetns: params.HOST_NETNS, subNetns: params.SUB_NETNS,
            controlNs: params.CTRL_NS, controlNsPath: params.CTRL_NS_PATH,
            controlPid: params.CTRL_PID, controlPreDropJoinRc: params.CTRL_PRE_RC
        },
        failures: []
    };
    const fail = (id, detail) => report.failures.push({ id, detail });

    // --- N4-0, no packets ---------------------------------------------------
    report.n4_0 = preflight({
        hostNetns: params.HOST_NETNS, hostUserns: params.HOST_USERNS,
        targetUid: params.TARGET_UID,
        fdLedger: FD_LEDGER(evid), selfProgram: PHASES_SCRIPT
    });
    for (const c of report.n4_0.checks) if (!c.ok) fail(c.id, c.why);
    if (report.failures.length > 0) {
        report.stoppedBefore = 'C1-C4 (the N4-0 pre-check did not pass)';
        return finish(report, evid, 1);
    }

    // --- C1-C4, real syscalls ----------------------------------------------
    report.controlsParent = await runControls('parent');
    for (const r of report.controlsParent) if (!isPass(r)) fail(r.id, `${r.verdict} errno=${r.errno}`);

    // --- N3-3 host IPC channels: READ-ONLY corroboration, the strict option -
    // The defence is the establish-stage masking, which already aborted with 71
    // if any classified channel could not be masked. Nothing here connects.
    report.ipc = inspectChannels();
    if (!report.ipc.listLoaded) fail('IPC:list', report.ipc.reason);
    for (const c of report.ipc.stillOpen || []) {
        fail(`IPC:${c.path}`, `still a live socket after masking (${c.why})`);
    }

    // --- C6 parent / child / grandchild ------------------------------------
    report.c6 = await spawnDescendant(1);
    const parentNs = report.n4_0.ns.net;
    if (!report.c6.ok) {
        fail('C6', `descendant probe failed: ${report.c6.reason}`);
    } else {
        const layers = [report.c6.report, report.c6.report?.descendant?.report].filter(Boolean);
        if (layers.length !== 2) fail('C6', 'grandchild layer missing');
        for (const l of layers) {
            if (l.ns?.net !== parentNs) fail(`C6:${l.tag}:ns`, `${l.ns?.net} != parent ${parentNs}`);
            for (const r of l.controls || []) if (!isPass(r)) fail(r.id, `${r.verdict} errno=${r.errno}`);
        }
    }

    // --- N2-3 escape check against the CONTROLLED namespace -----------------
    if (params.CTRL_PRE_RC !== '0') {
        fail('ESCAPE:vacuity', `joining the control namespace while privileged returned `
            + `${params.CTRL_PRE_RC}; a refusal now would prove nothing`);
    }
    report.escape = await escapeControl(params.CTRL_NS_PATH, params.CTRL_PID);
    if (report.escape.verdict !== 'REFUSED') fail('ESCAPE', `${report.escape.verdict}: ${report.escape.detail}`);

    // --- C5, auxiliary only -------------------------------------------------
    report.c5 = await c5Auxiliary();

    return finish(report, evid, report.failures.length === 0 ? 0 : 1);
}

function finish(report, evid, code) {
    report.verdict = code === 0 ? 'BOUNDARY_PROVEN_AT_FINAL_IDENTITY' : 'BOUNDARY_NOT_PROVEN';
    try { fs.writeFileSync(`${evid}/selftest-report.json`, `${JSON.stringify(report, null, 2)}\n`); }
    catch (e) { process.stderr.write(`could not write report: ${e?.message}\n`); }
    process.stdout.write(`${report.verdict}\n`);
    for (const f of report.failures) process.stdout.write(`FAIL ${f.id}: ${f.detail}\n`);
    return code;
}

const watchdog = setTimeout(() => {
    process.stderr.write(`self-test exceeded ${OVERALL_DEADLINE_MS}ms\n`);
    process.exit(1);
}, OVERALL_DEADLINE_MS);

main().then((code) => { clearTimeout(watchdog); process.exit(code); })
    .catch((e) => {
        clearTimeout(watchdog);
        process.stderr.write(`self-test threw: ${e?.stack || e}\n`);
        process.exit(1);
    });
