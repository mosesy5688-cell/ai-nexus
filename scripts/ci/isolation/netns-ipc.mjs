// Free2AITools work order N -- N3-3 host IPC channel enumeration.
//
// A network namespace isolates the network STACK. It does NOT isolate host IPC
// channels, and a container-runtime or resolver socket can do networking on the
// subtree's behalf. N3-3 forbids filing that under limitation L5: such a channel
// must have its access removed or the execution blocked.
//
// So this module (a) enumerates the unix sockets actually present in the runner
// and the test chain, (b) classifies the ones that could act on our behalf, and
// (c) VERIFIES by attempting a real connect() at the final identity. A
// successful connect to a network-capable or credential channel FAILS the
// self-test. Non-classified sockets are recorded, not judged -- the scope is the
// channels actually present, not every possible filesystem behaviour.
import fs from 'node:fs';
import net from 'node:net';

const SEARCH_ROOTS = ['/run', '/var/run', '/tmp'];
const MAX_DEPTH = 3;
export const CONNECT_DEADLINE_MS = 1500;

/** Channels that could perform networking, or hand out credentials, for us. */
export const RISK_PATTERNS = Object.freeze([
    { re: /docker|containerd|podman|crio|buildkit/i, why: 'container runtime: can run networked workloads on our behalf' },
    { re: /dbus/i, why: 'system bus: reaches NetworkManager / resolved' },
    { re: /systemd\/resolve|resolved/i, why: 'host resolver: resolves names outside our namespace' },
    { re: /ssh-agent|S\.gpg-agent|gpg-agent|agent\.[0-9]+$/i, why: 'credential agent' },
    { re: /proxy|squid|privoxy|mitm/i, why: 'proxy endpoint' }
]);

function walk(dir, depth, out) {
    if (depth > MAX_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const p = `${dir}/${e.name}`;
        try {
            if (e.isSocket()) out.push(p);
            else if (e.isDirectory() && !e.isSymbolicLink()) walk(p, depth + 1, out);
        } catch { /* unreadable entry: recorded by omission, never fatal here */ }
    }
}

export function enumerateSockets() {
    const found = [];
    for (const root of SEARCH_ROOTS) walk(root, 0, found);
    // Named explicitly so they are checked even if the walk cannot see them.
    const named = [
        '/var/run/docker.sock', '/run/docker.sock', '/run/containerd/containerd.sock',
        '/run/dbus/system_bus_socket', '/run/systemd/resolve/io.systemd.Resolve',
        process.env.SSH_AUTH_SOCK
    ].filter(Boolean);
    return [...new Set([...found, ...named])];
}

export const classify = (p) => RISK_PATTERNS.find((r) => r.re.test(p)) || null;

function probe(path) {
    return new Promise((resolve) => {
        const started = Date.now();
        let done = false;
        let timer = null;
        let sock = null;
        const finish = (verdict, errno, detail) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            try { if (sock) sock.destroy(); } catch { /* already gone */ }
            resolve({ path, verdict, errno, detail, elapsedMs: Date.now() - started });
        };
        try {
            if (!fs.existsSync(path)) { finish('ABSENT', 'ENOENT', 'path does not exist'); return; }
            sock = net.connect({ path });
        } catch (e) {
            finish('CLOSED', e?.code ?? null, `synchronous throw: ${e?.message}`);
            return;
        }
        timer = setTimeout(
            () => finish('INDETERMINATE', null, `no result within ${CONNECT_DEADLINE_MS}ms`),
            CONNECT_DEADLINE_MS);
        sock.once('connect', () => finish('OPEN', null, 'connect() succeeded'));
        sock.once('error', (e) => finish('CLOSED', e?.code ?? null, String(e?.message)));
    });
}

/**
 * Returns { ok, risky, recorded }. `ok` is false if ANY classified channel is
 * reachable, or if a probe could not reach a determinate answer (fail-closed).
 */
export async function auditChannels() {
    const risky = [];
    const recorded = [];
    for (const p of enumerateSockets()) {
        const hit = classify(p);
        if (!hit) {
            let exists = false;
            try { exists = fs.existsSync(p); } catch { exists = false; }
            recorded.push({ path: p, exists, verdict: 'RECORDED_NOT_CLASSIFIED' });
            continue;
        }
        const r = await probe(p);
        risky.push({ ...r, why: hit.why });
    }
    const ok = risky.every((r) => r.verdict === 'CLOSED' || r.verdict === 'ABSENT');
    return { ok, risky, recorded };
}
