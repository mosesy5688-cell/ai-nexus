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
import fs from 'node:fs';

const readLink = (p) => { try { return fs.readlinkSync(p); } catch { return 'UNREADABLE'; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

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

export function privilegeState() {
    const status = readText('/proc/self/status');
    const field = (name) => {
        const m = status.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'));
        return m ? m[1].trim() : null;
    };
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

export function interfaceState() {
    let names = [];
    try { names = fs.readdirSync('/sys/class/net'); } catch { names = ['UNREADABLE']; }
    return names.map((n) => ({
        name: n, operstate: readText(`/sys/class/net/${n}/operstate`).trim() || 'unknown'
    }));
}

export function routeState() {
    const v4 = readText('/proc/net/route').split('\n').slice(1).filter((l) => l.trim());
    const v6 = readText('/proc/net/ipv6_route').split('\n').filter((l) => l.trim());
    return {
        v4Entries: v4.length,
        // Destination 00000000 in the main table is the IPv4 default route.
        v4Default: v4.filter((l) => (l.split(/\s+/)[1] || '') === '00000000').length,
        v6Entries: v6.length,
        // An all-zero destination with prefix length 00 is the IPv6 default route.
        v6Default: v6.filter((l) => /^0{32}\s+00\s/.test(l)).length,
        v4Raw: v4.slice(0, 20), v6Raw: v6.slice(0, 20)
    };
}

export function fdInventory() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync('/proc/self/fd'); } catch { return out; }
    for (const n of names) out.push({ fd: n, target: readLink(`/proc/self/fd/${n}`) });
    return out;
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
    const envBad = envViolations();
    const checks = [];
    const add = (id, ok, observed, why) => checks.push({ id, ok, observed, why });

    add('P0-netns-changed', ns.net !== 'UNREADABLE' && ns.net !== hostNetns,
        { sub: ns.net, host: hostNetns }, 'the subtree must be in a NEW network namespace');
    add('P1-interfaces', ifaces.length > 0 && ifaces.every((i) => i.name === 'lo'), ifaces,
        'only loopback may exist inside; anything else means we are still bridged');
    add('P2-no-default-route', routes.v4Default === 0 && routes.v6Default === 0, routes,
        'no IPv4 and no IPv6 default route may exist inside the namespace');
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
    add('P9-no-stray-fds', fds.every((f) => ['0', '1', '2'].includes(f.fd)
        || f.target.startsWith('anon_inode:') || /^\/proc\/\d+\/fd$/.test(f.target)), fds,
        'only stdio, descriptors this process created itself after exec '
        + '(anon_inode epoll/eventfd) and the descriptor this very readdir holds '
        + 'open on /proc/self/fd are allowed; anything else was inherited');
    add('P10-env-clean', envBad.length === 0, envBad,
        'proxy, credential-agent and token variables must not be inherited');

    return { ok: checks.every((c) => c.ok), checks, ns, priv, ifaces, routes, fds };
}
