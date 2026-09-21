// Free2AITools work order N -- refusal controls C1-C4 (real syscalls).
//
// N4-1: every control records address family, operation, the REAL errno and a
// PREDEFINED accept set. A wait-timeout or a generic non-zero tool exit does NOT
// prove system refusal, so ETIMEDOUT is deliberately NOT in the accept set, and
// a UDP sendto that RETURNS SUCCESS is judged a control FAILURE -- it is never
// explained away as "the peer does not exist anyway".
//
// N4-2: address-family-unsupported, tool-missing and unknown-error are recorded
// as their own verdicts and none of them counts as a refusal pass.
//
// N4-3: every control that can wait carries a definite deadline.
//
// On the targets: 192.0.2.1 (RFC 5737 TEST-NET-1) and 2001:db8::1 (RFC 3849)
// are DOCUMENTATION addresses. The RFCs only advise operators to filter them;
// they do NOT guarantee the host emits no packet, so nothing here is inferred
// from the choice of address. What is load-bearing is (a) the N4-0 pre-check
// proving we are in a new namespace with no route, run BEFORE any of this, and
// (b) the real errno each control below returns.
import net from 'node:net';
import dgram from 'node:dgram';

export const TARGET_V4 = '192.0.2.1';
export const TARGET_V6 = '2001:db8::1';
export const PORT_TCP = 443;
export const PORT_UDP = 53;
export const DEADLINE_TCP_MS = 3000;
export const DEADLINE_UDP_MS = 2000;

/** PREDEFINED accept set: only these errnos count as system refusal. */
export const ACCEPT_ERRNOS = Object.freeze([
    'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPERM', 'EACCES', 'EADDRNOTAVAIL'
]);

/** Recorded separately, explicitly NOT a pass (N4-2). */
export const NON_PASS_VERDICTS = Object.freeze([
    'CONNECTED', 'SENDTO_SUCCEEDED', 'DEADLINE', 'AF_UNSUPPORTED', 'UNKNOWN_ERROR'
]);

const classify = (code) => {
    if (code && ACCEPT_ERRNOS.includes(code)) return 'REFUSED';
    if (code === 'EAFNOSUPPORT') return 'AF_UNSUPPORTED';
    return 'UNKNOWN_ERROR';
};

export const isPass = (r) => r.verdict === 'REFUSED';

function tcpControl({ id, host, family, port = PORT_TCP, deadlineMs = DEADLINE_TCP_MS }) {
    const meta = { id, layer: 'tcp', op: 'connect', family, target: `${host}:${port}`, deadlineMs };
    const started = Date.now();
    return new Promise((resolve) => {
        let done = false;
        let timer = null;
        let sock = null;
        const finish = (verdict, errno, detail) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            try { if (sock) sock.destroy(); } catch { /* socket already gone */ }
            resolve({ ...meta, verdict, errno, detail, elapsedMs: Date.now() - started });
        };
        try {
            sock = net.connect({ host, port, family, autoSelectFamily: false });
        } catch (e) {
            finish(classify(e?.code), e?.code ?? null, `synchronous throw: ${e?.message}`);
            return;
        }
        timer = setTimeout(
            () => finish('DEADLINE', null, `no syscall result within ${deadlineMs}ms`), deadlineMs);
        sock.once('connect', () => finish('CONNECTED', null, 'connection established'));
        sock.once('error', (e) => finish(classify(e?.code), e?.code ?? null, String(e?.message)));
    });
}

function udpControl({ id, host, family, port = PORT_UDP, deadlineMs = DEADLINE_UDP_MS }) {
    const meta = { id, layer: 'udp', op: 'sendto', family, target: `${host}:${port}`, deadlineMs };
    const started = Date.now();
    // Fixed, non-secret payload. It carries nothing about this repository.
    const payload = Buffer.from('f2ai-n-refusal-control');
    return new Promise((resolve) => {
        let done = false;
        let timer = null;
        let sock = null;
        const finish = (verdict, errno, detail) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            try { if (sock) sock.close(); } catch { /* socket already closed */ }
            resolve({ ...meta, verdict, errno, detail, elapsedMs: Date.now() - started });
        };
        try {
            sock = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
        } catch (e) {
            finish(classify(e?.code), e?.code ?? null, `createSocket threw: ${e?.message}`);
            return;
        }
        sock.on('error', (e) => finish(classify(e?.code), e?.code ?? null, String(e?.message)));
        timer = setTimeout(
            () => finish('DEADLINE', null, `no syscall result within ${deadlineMs}ms`), deadlineMs);
        try {
            sock.send(payload, port, host, (e) => {
                if (e) {
                    finish(classify(e?.code), e?.code ?? null, String(e?.message));
                } else {
                    // N4-1, explicit: a successful sendto is a control FAILURE.
                    finish('SENDTO_SUCCEEDED', null,
                        'sendto returned success -- the datagram left the socket');
                }
            });
        } catch (e) {
            finish(classify(e?.code), e?.code ?? null, `send threw: ${e?.message}`);
        }
    });
}

/**
 * Run the full four-control matrix. `tag` names the process layer it ran in
 * (parent / child / grandchild) so C6 can re-run ALL FOUR for descendants
 * rather than only one IPv4 TCP probe (N4-4).
 */
export async function runControls(tag) {
    const results = [];
    results.push(await tcpControl({ id: `${tag}:C1`, host: TARGET_V4, family: 4 }));
    results.push(await tcpControl({ id: `${tag}:C2`, host: TARGET_V6, family: 6 }));
    results.push(await udpControl({ id: `${tag}:C3`, host: TARGET_V4, family: 4 }));
    results.push(await udpControl({ id: `${tag}:C4`, host: TARGET_V6, family: 6 }));
    return results;
}
