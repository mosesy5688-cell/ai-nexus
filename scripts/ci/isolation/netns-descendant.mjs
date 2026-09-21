// Free2AITools work order N -- C6 descendant probe (child and grandchild).
//
// N4-4: C6 must cover PARENT, CHILD and GRANDCHILD namespace identity, and must
// re-run ALL FOUR of IPv4/IPv6 x TCP/UDP for descendants -- not just one IPv4
// TCP probe. This file is the child; it spawns itself once more to become the
// grandchild, and prints one JSON line so the parent can assert on it.
//
// P-2 requires the network defence to cover the whole process tree, not only
// the direct child. That is what depth 2 is here for.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runControls, isPass } from './netns-controls.mjs';
import { namespaceIdentity, privilegeState } from './netns-probe.mjs';

const SELF = fileURLToPath(import.meta.url);
export const SPAWN_DEADLINE_MS = 25000;
const MAX_DEPTH = 2;

export function spawnDescendant(depth) {
    return new Promise((resolve) => {
        const started = Date.now();
        let done = false;
        let out = '';
        let err = '';
        const child = spawn(process.execPath, [SELF, String(depth)], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const finish = (payload) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch { /* already exited */ }
            resolve({ elapsedMs: Date.now() - started, ...payload });
        };
        const timer = setTimeout(
            () => finish({ ok: false, reason: 'SPAWN_DEADLINE', stdout: out, stderr: err }),
            SPAWN_DEADLINE_MS);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => finish({ ok: false, reason: `SPAWN_ERROR:${e?.code}`, stderr: err }));
        child.on('close', (code) => {
            let parsed = null;
            try { parsed = JSON.parse(out.trim().split('\n').pop() || 'null'); } catch { parsed = null; }
            if (code !== 0 || !parsed) {
                finish({ ok: false, reason: `EXIT:${code}`, stdout: out, stderr: err });
                return;
            }
            finish({ ok: true, report: parsed });
        });
    });
}

async function main() {
    const depth = Number(process.argv[2] || 1);
    const tag = depth === 1 ? 'child' : 'grandchild';
    const priv = privilegeState();
    const report = {
        depth,
        tag,
        pid: process.pid,
        ns: namespaceIdentity(),
        uid: priv.uid,
        capEff: priv.capEff,
        capBnd: priv.capBnd,
        noNewPrivs: priv.noNewPrivs,
        controls: await runControls(tag)
    };
    report.controlsAllRefused = report.controls.every(isPass);
    if (depth < MAX_DEPTH) report.descendant = await spawnDescendant(depth + 1);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    // Exit code carries only "this probe produced a report"; the PASS/FAIL
    // judgement is made by the parent self-test against the report contents.
    process.exit(0);
}

if (process.argv[1] === SELF) {
    main().catch((e) => {
        process.stderr.write(`descendant failed: ${e?.stack || e}\n`);
        process.exit(1);
    });
}
