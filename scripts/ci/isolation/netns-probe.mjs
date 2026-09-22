// Free2AITools work order N -- N4-0 pre-check. NO PACKETS ARE SENT HERE.
//
// N4-0: before any real syscall control runs, confirm we are in the expected
// NEW namespace and verify interfaces, routes and the privilege / FD
// preconditions. Only then may C1-C4 run. If any check below fails, the
// self-test stops and phase D is never started.
//
// N2-4: "UID is 0" and "has CAP_SYS_ADMIN" are reported as separate facts. The
// load-bearing condition is the measured capability sets plus the user
// namespace, never the UID alone.
//
// WO-N-P3. Four predicates were FALSE NEGATIVES on run 35733326729: each
// reported FAIL while reality inside that same namespace said the opposite.
// None was a boundary violation and none is relaxed here -- each was a probe
// reading the WRONG SOURCE or the WRONG LINE: (1) P1 enumerated the sysfs net
// directory, not remounted and so answering for the HOST; (2) P2 counted
// loopback's own all-zero rows as default routes; (3) P7's line match ran off
// an EMPTY `Groups:` line and returned NStgid's value; (4) P9 measured THIS
// process's descriptors, charging Node's own io_uring/pipe/eventpoll/eventfd as
// "inherited". The subprocesses below (`ip`, `sh`) speak to the kernel only.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const readLink = (p) => { try { return fs.readlinkSync(p); } catch { return 'UNREADABLE'; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** A kernel-local helper. Returns stdout, or null when it could not run. */
const run = (cmd, args) => {
    const r = spawnSync(cmd, args,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    return (!r.error && r.status === 0) ? String(r.stdout) : null;
};

/** Environment inheritance is a SEPARATE mechanism from FD inheritance (N-3). */
export const ENV_DENY = Object.freeze([
    /^https?_proxy$/i, /^all_proxy$/i, /^no_proxy$/i, /^npm_config_.*proxy$/i,
    /^ssh_auth_sock$/i, /^gpg_agent_info$/i,
    /^(github|gh|actions)_.*token$/i, /^actions_(runtime|results|cache)_/i,
    /^(aws|r2|cloudflare|cf)_/i, /^.*_(secret|password|api_key)$/i
]);

export function namespaceIdentity() {
    return {
        net: readLink('/proc/self/ns/net'),
        user: readLink('/proc/self/ns/user'),
        pid: readLink('/proc/self/ns/pid'),
        mnt: readLink('/proc/self/ns/mnt')
    };
}

/**
 * WO-N-P3 (3). `\s*` matches newlines, so on an EMPTY field the old pattern ran
 * past the line end into the NEXT key: a cleared group list prints as
 * `Groups:\t \n` (the kernel's legacy trailing space) and it returned
 * `NStgid:\t351` -- "groups are NOT cleared". Horizontal space only now; the
 * key still starts its line, so no other key can be prefix-matched into it.
 */
export function statusField(status, name) {
    const m = String(status).match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm'));
    return m ? m[1].trim() : null;
}

export function privilegeState() {
    const status = readText('/proc/self/status');
    const field = (name) => statusField(status, name);
    const ids = (name) => (field(name) || '').split(/\s+/).filter(Boolean);
    return {
        uid: ids('Uid'), gid: ids('Gid'),
        groups: (field('Groups') || '').split(/\s+/).filter(Boolean),
        capInh: field('CapInh'), capPrm: field('CapPrm'), capEff: field('CapEff'),
        capBnd: field('CapBnd'), capAmb: field('CapAmb'),
        noNewPrivs: field('NoNewPrivs'), seccomp: field('Seccomp')
    };
}

const allZero = (hex) => typeof hex === 'string' && /^0+$/.test(hex);

/** `ip -o link show`: "1: lo: <LOOPBACK,UP,LOWER_UP> mtu ... state UNKNOWN ..." */
export function parseLinkShow(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
        const m = line.match(/^\d+:\s*([^:@\s]+)[@:]/);
        if (!m) continue;
        const st = line.match(/\sstate\s+(\S+)/);
        out.push({ name: m[1], operstate: (st ? st[1] : 'unknown').toLowerCase() });
    }
    return out;
}

/** `/proc/net/dev`: two header lines, then "    lo: <counters>". */
export function parseNetDev(text) {
    return String(text).split('\n').slice(2)
        .map((l) => l.match(/^\s*([^\s:]+):/)).filter(Boolean)
        .map((m) => ({ name: m[1], operstate: 'unknown' }));
}

/**
 * WO-N-P3 (1). Both sources are scoped to the network namespace: `ip -o link
 * show` asks the kernel over netlink for THIS namespace and /proc/net is
 * per-namespace by construction. The sysfs net directory is neither -- it
 * listed the host's docker0 / eth0 / enP26900s1 while `ip -o link show`, at the
 * same instant in the same namespace, saw only lo.
 */
export function interfaceState() {
    const ipOut = run('ip', ['-o', 'link', 'show']);
    if (ipOut !== null) return { source: 'ip -o link show', links: parseLinkShow(ipOut) };
    const dev = readText('/proc/net/dev');
    if (dev) return { source: '/proc/net/dev', links: parseNetDev(dev) };
    return { source: 'NONE', links: [] };
}

const LOOPBACK = 'lo';
const v4Dev = (l) => (l.trim().split(/\s+/)[0] || '');
const v6Dev = (l) => (l.trim().split(/\s+/).pop() || '');

/**
 * WO-N-P3 (2). /proc/net/route and /proc/net/ipv6_route ARE namespace-scoped,
 * so the source was right and the arithmetic was not: loopback's own all-zero
 * rows (unreachable ::/0 and ::1/128) have OUTPUT DEVICE lo, and counting them
 * made a namespace with no routes at all report "2 IPv6 default routes". The
 * device joins the predicate; entry counts keep every row, narrowing nothing.
 */
export function parseProcRoutes(v4Text, v6Text) {
    const v4 = String(v4Text).split('\n').slice(1).filter((l) => l.trim());
    const v6 = String(v6Text).split('\n').filter((l) => l.trim());
    return {
        v4Entries: v4.length,
        // Destination 00000000 in the main table is the IPv4 default route.
        v4Default: v4.filter((l) => v4Dev(l) !== LOOPBACK
            && (l.trim().split(/\s+/)[1] || '') === '00000000').length,
        v6Entries: v6.length,
        // An all-zero destination with prefix length 00 is the IPv6 default route.
        v6Default: v6.filter((l) => v6Dev(l) !== LOOPBACK && /^0{32}\s+00\s/.test(l)).length,
        v4Raw: v4.slice(0, 20), v6Raw: v6.slice(0, 20)
    };
}

export function routeState() {
    return parseProcRoutes(readText('/proc/net/route'), readText('/proc/net/ipv6_route'));
}

export function fdInventory() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync('/proc/self/fd'); } catch { return out; }
    for (const n of names) out.push({ fd: n, target: readLink(`/proc/self/fd/${n}`) });
    return out;
}

const STDIO_FDS = Object.freeze(['0', '1', '2']);
const READDIR_TARGET = /^\/proc\/\d+\/fd$/;
const FD_INVENTORY_CMD = 'ls -l /proc/self/fd';

/** Accepts either shape the facility produces: "<fd>\t<target>" or `ls -l`. */
export function parseFdDump(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
        const tab = line.match(/^(\d+)\t(.*)$/);
        if (tab) { out.push({ fd: tab[1], target: tab[2] }); continue; }
        const ls = line.match(/\s(\d+) -> (.*)$/);
        if (ls) out.push({ fd: ls[1], target: ls[2] });
    }
    return out;
}

/**
 * WO-N-P3 (4). P9 asks what was INHERITED, unanswerable on the probe itself:
 * Node opens its own io_uring, pipes, eventpoll and eventfd AFTER exec, and the
 * handle its readdir holds on /proc/self/fd is shut before we readlink it (it
 * reads back UNREADABLE) -- all were charged as inheritance. This is NOT a
 * blanket pass for anon_inode/pipe: the inventory moves to a freshly exec'd
 * process, where the only legitimate descriptors are stdio, the readdir's own
 * handle, and -- when a SHELL took it, as netns-phases.sh does -- the script it
 * is executing (bash's fd 255), named by the caller and never guessed.
 */
export function inheritedFds(entries, { selfProgram = null } = {}) {
    return entries.filter((f) => !STDIO_FDS.includes(f.fd)
        && !READDIR_TARGET.test(f.target)
        && !(selfProgram !== null && f.target === selfProgram));
}

/** A fresh minimal process: what IT can see is exactly what was handed down. */
export function inheritedFdInventory() {
    const out = run('sh', ['-c', FD_INVENTORY_CMD]);
    if (out === null) {
        return { ok: false, reason: `sh -c '${FD_INVENTORY_CMD}' did not run`, entries: [] };
    }
    return { ok: true, reason: null, entries: parseFdDump(out) };
}

export function envViolations() {
    return Object.keys(process.env).filter((k) => ENV_DENY.some((re) => re.test(k)));
}

/**
 * The whole N4-0 gate. Returns { ok, checks } where every check carries its own
 * verdict and the observed value, so a failure says WHICH precondition failed.
 */
export function preflight({ hostNetns, hostUserns, targetUid }) {
    const ns = namespaceIdentity();
    const priv = privilegeState();
    const ifaces = interfaceState();
    const routes = routeState();
    const fds = fdInventory();
    const handedDown = inheritedFdInventory();
    const strayFds = inheritedFds(handedDown.entries);
    const envBad = envViolations();
    const checks = [];
    const add = (id, ok, observed, why) => checks.push({ id, ok, observed, why });

    add('P0-netns-changed', ns.net !== 'UNREADABLE' && ns.net !== hostNetns,
        { sub: ns.net, host: hostNetns }, 'the subtree must be in a NEW network namespace');
    add('P1-interfaces', ifaces.links.length > 0 && ifaces.links.every((i) => i.name === 'lo'),
        ifaces, 'only loopback may exist inside, from a NAMESPACE-SCOPED source');
    add('P2-no-default-route', routes.v4Default === 0 && routes.v6Default === 0, routes,
        'no IPv4/IPv6 default route inside; loopback rows are not routes off box');
    add('P3-caps-empty', allZero(priv.capEff) && allZero(priv.capPrm) && allZero(priv.capBnd),
        { capEff: priv.capEff, capPrm: priv.capPrm, capBnd: priv.capBnd, capAmb: priv.capAmb },
        'effective, permitted AND bounding capability sets must be empty -- this, '
        + 'not the UID, is what makes setns back out impossible');
    add('P4-no-new-privs', priv.noNewPrivs === '1', priv.noNewPrivs,
        'no_new_privs blocks re-escalation via setuid/file caps; it is one of three '
        + 'measures and is NOT claimed to remove already-held capabilities');
    add('P5-uid-stable', priv.uid.length === 4 && new Set(priv.uid).size === 1
        && priv.gid.length === 4 && new Set(priv.gid).size === 1,
        { uid: priv.uid, gid: priv.gid, targetUid },
        'real, effective, saved and fs ids must all be the same -- a saved UID of 0 '
        + 'left behind would be a way back');
    add('P6-uid-zero-only-in-userns', priv.uid[0] !== '0' || ns.user !== hostUserns,
        { uid: priv.uid[0], subUserns: ns.user, hostUserns },
        'stated separately from capabilities (N2-4): UID 0 is only acceptable when '
        + 'it is UID 0 inside a NEW user namespace');
    add('P7-groups-cleared', priv.groups.length === 0, priv.groups,
        'supplementary groups are dropped; this is what removes docker-group access '
        + 'to a container service socket');
    add('P8-no-socket-fds', fds.every((f) => !f.target.startsWith('socket:')), fds,
        'no inherited socket descriptor may survive into the final identity');
    add('P9-no-stray-fds', handedDown.ok && strayFds.length === 0,
        { source: FD_INVENTORY_CMD, ok: handedDown.ok, reason: handedDown.reason,
            handedDown: handedDown.entries, stray: strayFds },
        'INHERITANCE, in a freshly exec-ed process: only stdio and the handle '
        + 'its own readdir holds. No inventory at all is FAILURE, never a skip');
    add('P10-env-clean', envBad.length === 0, envBad,
        'proxy, credential-agent and token variables must not be inherited');

    return { ok: checks.every((c) => c.ok), checks, ns, priv, ifaces, routes, fds };
}
