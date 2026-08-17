// REST-1c (D-2026-0816-438): TERMINAL GUARANTEE. The process must not be able to
// exit 0 while a directory restore is still pending its terminal record.
//
// The 08-16 incident (run 31936530908, job 95139906396): heartbeats stalled at
// processed:449 of expected:654, no phase:complete was ever emitted, no
// [R2-CLI-RESULT] was emitted, and node exited 0. The truncated 449-shard set was
// then fused as if whole.
//
// Exit codes are proven by SPAWNING REAL node processes, not by asserting on a
// mock. Hermetic - no network, credentials or R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    evaluateExitGuard, registerPendingRestore, resolvePendingRestore,
    pendingRestoreCount, __resetPendingRestores,
    TERMINAL_GUARD_MARKER, NO_TERMINAL_RECORD_CODE,
} from './lib/r2-restore-exit-guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, 'lib', 'r2-restore-exit-guard.js').split(path.sep).join('/');

/** Run a snippet in a real node process and report its true exit code. */
function runNode(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest1c-'));
    const file = path.join(dir, 'probe.mjs');
    fs.writeFileSync(file, `import { registerPendingRestore, resolvePendingRestore } from 'file://${GUARD}';\n${body}\n`);
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// --- the pure decision ------------------------------------------------------

test('REST-1c a pending restore at exit is a NAMED non-zero verdict', () => {
    const v = evaluateExitGuard(1, 0);
    assert.equal(v.code, NO_TERMINAL_RECORD_CODE);
    assert.equal(v.pending, 1);
    assert.equal(v.observed_exit_code, 0);
    assert.equal(v.forced_exit_code, 1);
});

test('REST-1c nothing pending => the guard is inert (zero regression)', () => {
    assert.equal(evaluateExitGuard(0, 0), null);
    assert.equal(evaluateExitGuard(0, 3), null);
});

test('REST-1c the verdict carries COUNTS ONLY', () => {
    const v = evaluateExitGuard(7, 0);
    for (const [k, val] of Object.entries(v)) {
        assert.ok(typeof val === 'number' || k === 'code', `${k} must be a count`);
    }
});

test('REST-1c register/resolve accounting', () => {
    __resetPendingRestores();
    const a = registerPendingRestore(() => {});
    const b = registerPendingRestore(() => {});
    assert.equal(pendingRestoreCount(), 2);
    resolvePendingRestore(a);
    resolvePendingRestore(a); // idempotent
    assert.equal(pendingRestoreCount(), 1);
    resolvePendingRestore(b);
    assert.equal(pendingRestoreCount(), 0);
});

// --- REAL exit-code proofs --------------------------------------------------

test('REST-1c INCIDENT SHAPE: silent drain with a restore pending => exit 1', () => {
    // Exactly the 08-16 mechanism: work is outstanding, nothing holds the event
    // loop open, the process falls off the end and would report success.
    const r = runNode('registerPendingRestore(); // never resolved - the wedge');
    assert.equal(r.code, 1, 'a pending restore must force a non-zero exit');
    assert.match(r.out, /R2_RESTORE_NO_TERMINAL_RECORD/);
    assert.ok(r.out.includes(TERMINAL_GUARD_MARKER));
});

test('REST-1c RED-before control: the SAME drain without the guard exits 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest1c-ctl-'));
    const file = path.join(dir, 'probe.mjs');
    // An unref-ed heartbeat is all that is left holding the loop - the real bug.
    fs.writeFileSync(file, 'const t = setInterval(() => {}, 30000); t.unref();\n');
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, 'this is the silent exit-0 the guard exists to stop');
});

test('REST-1c a resolved restore exits 0 (healthy path untouched)', () => {
    const r = runNode('const g = registerPendingRestore(); resolvePendingRestore(g);');
    assert.equal(r.code, 0);
    assert.equal(r.out.includes(NO_TERMINAL_RECORD_CODE), false, 'no false alarm');
});

test('REST-1c the guard never MASKS an existing failure exit code', () => {
    const r = runNode('registerPendingRestore(); process.exit(2);');
    assert.notEqual(r.code, 0, 'still a failure');
});

test('REST-1c a throw still exits non-zero with the guard installed', () => {
    const r = runNode('registerPendingRestore(); throw new Error("boom");');
    assert.notEqual(r.code, 0);
});

// --- placement justification ------------------------------------------------

test('REST-1c the guard is registered at the CLI seam, above the FFI/JS fork', () => {
    const cli = fs.readFileSync(path.join(HERE, 'r2-workflow-cli.js'), 'utf8');
    assert.match(cli, /const guard = registerPendingRestore\(\);/);
    assert.match(cli, /resolvePendingRestore\(guard\);/);
    // Pending is marked BEFORE the engine runs and resolved only AFTER the
    // terminal record is emitted.
    assert.ok(cli.indexOf('registerPendingRestore()') < cli.indexOf('restoreDirectoryFromR2FFI('));
    assert.ok(cli.indexOf('[R2-CLI-RESULT]') < cli.indexOf('resolvePendingRestore(guard)'));
});

test('REST-1c the existing unref invariant is PRESERVED (no regression)', () => {
    // r2-restore-progress.test.mjs:129 pins that the real interval IS unref-ed.
    // The guarantee therefore had to live at the caller, not by re-ref-ing here.
    const src = fs.readFileSync(path.join(HERE, 'lib', 'r2-restore-progress.js'), 'utf8');
    assert.match(src, /if \(timer && typeof timer\.unref === 'function'\) timer\.unref\(\);/);
    // And telemetry stays free of any exit-code concern.
    assert.equal(/process\.on\(|process\.exitCode/.test(src), false,
        'telemetry must not gain process-level behaviour');
});
