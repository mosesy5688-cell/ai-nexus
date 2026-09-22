// Free2AITools work order N -- the fail-closed boundary precondition (ruling D,
// d3 + d4). Importable by a test, and runnable directly as `node
// boundary-precondition.mjs --assert` so its own mutants can be executed.
//
// WHY IT EXISTS. The previous precondition block asserted an IN-PROCESS monkey
// patch (globalThis.fetch and net.Socket.prototype.connect replaced with
// throwers). M-G1-02 already refuted that: a patch does not reach a fresh child
// process, let alone the kernel. Worse, measured on this workstation, ALL FIVE
// of those "fail-closed precondition" cases passed on Windows with NO BOUNDARY
// AT ALL. A precondition that stays green when the thing it guards does not
// exist is not a precondition -- it has zero discriminating power.
//
// So this check is built so it CANNOT pass without the boundary:
//
//   d4  UNFORGEABLE MARKER. The launcher writes <EVID>/launch.nonce carrying
//       its nonce, the subtree's network-namespace id and the host's, and
//       exports the same nonce as F2AI_ISO_NONCE. All of these must correspond,
//       AND /proc/self/ns/net re-read here must equal the recorded subtree id
//       and differ from the host id. The nonce pairing shows the launcher ran;
//       the kernel's namespace identity shows we are actually inside it. No
//       in-process patch can forge the second half.
//
//   d3  EMPIRICAL NAMESPACE-LEVEL BLOCKING. Only after the marker verifies does
//       a REAL connect() go out to an external address. It must fail fast with
//       ENETUNREACH or EACCES, asserted literally. A connection, any other
//       errno, or no answer before the deadline all terminate.
//
// MISSING EITHER ONE TERMINATES with code 71 -- not a skip, and certainly not a
// pass. That means the suites which call this can only be run inside the
// launcher. That is the intended consequence, not an accident.
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const FATAL_CODE = 71;
export const ACCEPTED_ERRNOS = Object.freeze(['ENETUNREACH', 'EACCES']);
export const CONNECT_DEADLINE_MS = 2000;
export const TARGET_HOST = '192.0.2.1';
export const TARGET_PORT = 443;

export class BoundaryAbsent extends Error {
    constructor(reason) {
        super(`E_ISOLATION_BOUNDARY_ABSENT(${FATAL_CODE}): ${reason}`);
        this.name = 'BoundaryAbsent';
        this.code = FATAL_CODE;
        this.reason = reason;
    }
}

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const field = (t, k) => (t.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim() ?? null;

/** d4. Throws BoundaryAbsent; never emits a packet. */
export function verifyMarker(env = process.env) {
    const evid = env.F2AI_ISO_EVID;
    const nonce = env.F2AI_ISO_NONCE;
    if (!evid) throw new BoundaryAbsent('F2AI_ISO_EVID is not set: no launcher ran');
    if (!nonce) throw new BoundaryAbsent('F2AI_ISO_NONCE is not set: no launcher ran');
    const raw = readText(`${evid}/launch.nonce`);
    if (raw === null) throw new BoundaryAbsent(`${evid}/launch.nonce is missing`);
    const fileNonce = field(raw, 'nonce');
    const subNetns = field(raw, 'sub_netns');
    const hostNetns = field(raw, 'host_netns');
    if (!fileNonce || !subNetns || !hostNetns) {
        throw new BoundaryAbsent('launch.nonce is incomplete');
    }
    if (fileNonce !== nonce) {
        throw new BoundaryAbsent(
            'the environment nonce and the marker file do not correspond');
    }
    if (subNetns === hostNetns) {
        throw new BoundaryAbsent(
            `the marker records no new namespace (sub ${subNetns} == host ${hostNetns})`);
    }
    let observed;
    try { observed = fs.readlinkSync('/proc/self/ns/net'); } catch (e) {
        throw new BoundaryAbsent(
            `/proc/self/ns/net is unreadable (${e?.code}): this is not a Linux namespace`);
    }
    if (observed !== subNetns) {
        throw new BoundaryAbsent(
            `this process is in ${observed}, not the subtree namespace ${subNetns}`);
    }
    if (observed === hostNetns) {
        throw new BoundaryAbsent(`this process is in the HOST namespace ${hostNetns}`);
    }
    return { nonce, subNetns, hostNetns, observedNetns: observed };
}

/** d3. A real connect(). Only ever called after verifyMarker has passed. */
export function probeBlocking() {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        let done = false;
        let timer = null;
        let sock = null;
        const settle = (fn, arg) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            try { if (sock) sock.destroy(); } catch { /* already gone */ }
            fn(arg);
        };
        try {
            sock = net.connect({
                host: TARGET_HOST, port: TARGET_PORT, family: 4, autoSelectFamily: false
            });
        } catch (e) {
            settle(reject, new BoundaryAbsent(`connect threw synchronously: ${e?.code}`));
            return;
        }
        timer = setTimeout(() => settle(reject, new BoundaryAbsent(
            `connect to ${TARGET_HOST}:${TARGET_PORT} did not fail fast within `
            + `${CONNECT_DEADLINE_MS}ms; a wait is not a refusal`)), CONNECT_DEADLINE_MS);
        sock.once('connect', () => settle(reject, new BoundaryAbsent(
            `connect to ${TARGET_HOST}:${TARGET_PORT} SUCCEEDED: there is no boundary`)));
        sock.once('error', (e) => {
            const code = e?.code ?? null;
            if (!ACCEPTED_ERRNOS.includes(code)) {
                settle(reject, new BoundaryAbsent(
                    `connect failed with ${code}, which is not one of `
                    + `${ACCEPTED_ERRNOS.join('/')}; that is not proof of namespace blocking`));
                return;
            }
            settle(resolve, {
                connectTarget: `${TARGET_HOST}:${TARGET_PORT}`,
                connectErrno: code,
                connectElapsedMs: Date.now() - started
            });
        });
    });
}

/** Both halves. Terminates the process with 71 when the boundary is absent. */
export async function requireIsolationBoundary() {
    try {
        const marker = verifyMarker();
        const blocking = await probeBlocking();
        return { markerVerified: true, ...marker, ...blocking };
    } catch (e) {
        process.stderr.write(`${e?.message || e}\n`);
        process.exit(FATAL_CODE);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--assert')) {
    requireIsolationBoundary().then((ev) => {
        process.stdout.write(`${JSON.stringify(ev)}\n`);
        process.exit(0);
    });
}
