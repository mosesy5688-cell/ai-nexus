// D-439 residual: ZERO ENGINE EXEMPTIONS.
//
// Proves that the terminal record REST-3 consumes, and the REST-1a completeness
// assertion, are emitted/evaluated by the CALLER (r2-workflow-cli.js) ABOVE the
// rust-FFI / JS fork - so neither engine can be exempt from them. The proof is by
// EXECUTION: a copy of the real CLI is run as a real subprocess with the bridge
// replaced by a stub that impersonates each engine outcome.
//
// Hermetic - the stub replaces the bridge entirely, so there is no network, no
// credential and no R2 access on any path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'r2-workflow-cli.js');
const url = (p) => `file://${p.split(path.sep).join('/')}`;

/**
 * Run the REAL CLI restore-dir action with restoreDirectoryFromR2FFI stubbed to
 * `impl`. Everything else in the CLI is byte-identical to production.
 */
function runCliWithEngine(implSource, args = ['--strict']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-parity-'));
    const stub = path.join(dir, 'bridge-stub.mjs');
    fs.writeFileSync(stub, `export function initR2Bridge() {}
export function createR2ClientFFI() { return {}; }
export async function backupFileToR2FFI() { return { success: true }; }
export async function restoreFileFromR2FFI() { return { success: true }; }
export async function backupDirectoryToR2FFI() { return { success: true }; }
export async function uploadFileFFI() { return { success: true }; }
export async function uploadBufferToR2FFI() { return { success: true }; }
export const restoreDirectoryFromR2FFI = ${implSource};
`);
    const copy = path.join(dir, 'cli-under-test.mjs');
    const src = fs.readFileSync(CLI, 'utf8')
        .replace("'./lib/r2-bridge.js'", `'${url(stub)}'`)
        .replace("'./lib/r2-restore-gate.js'", `'${url(path.join(HERE, 'lib', 'r2-restore-gate.js'))}'`);
    fs.writeFileSync(copy, src);
    const r = spawnSync(process.execPath, [copy, 'restore-dir', 'state/registry/', 'cache/registry/', ...args],
        { encoding: 'utf8', cwd: dir });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const COMPLETE = `async () => ({ success: true, restored: 653, expected: 653, missing: [], failed: [], source: 'manifest', manifestFound: true })`;
const SHORT = `async () => ({ success: true, restored: 449, expected: 654, missing: [], failed: [], source: 'manifest', manifestFound: true })`;
const WEDGED = `() => new Promise(() => {})`;

test('ENGINE PARITY: a COMPLETE engine result emits the terminal record and exits 0', () => {
    const r = runCliWithEngine(COMPLETE);
    assert.match(r.out, /\[R2-CLI-RESULT\]/, 'the terminal record REST-3 consumes must be emitted');
    assert.match(r.out, /"expected":653/);
    assert.equal(r.code, 0);
});

test('ENGINE PARITY: a SHORT engine result is caught by REST-1a above the fork', () => {
    // The engine reported success:true with failed:0 - the exact 08-16 shape.
    const r = runCliWithEngine(SHORT);
    assert.match(r.out, /\[R2-CLI-RESULT\]/, 'terminal record still emitted');
    assert.match(r.out, /R2_RESTORE_INCOMPLETE/, 'REST-1a must fire regardless of engine');
    assert.match(r.out, /"shortfall":205/);
    assert.notEqual(r.code, 0, 'partial success must exit non-zero');
});

test('ENGINE PARITY: REST-1a fires even WITHOUT --strict (partial success is failure)', () => {
    const r = runCliWithEngine(SHORT, []);
    assert.match(r.out, /R2_RESTORE_INCOMPLETE/);
    assert.notEqual(r.code, 0);
});

test('ENGINE PARITY: a WEDGED engine reproduces the incident and is BLOCKED', () => {
    // The engine never returns; nothing holds the event loop open; node falls off
    // the end exactly as it did on 08-16 (run 31936530908, job 95139906396).
    const r = runCliWithEngine(WEDGED);
    // 1. No terminal record -> the REST-3 shell gate has its trigger.
    assert.equal(/\[R2-CLI-RESULT\]/.test(r.out), false, 'the incident emits no terminal record');
    // 2. And REST-1c refuses to let it be a silent success.
    assert.equal(r.code, 1, 'a wedged engine must NOT exit 0');
    assert.match(r.out, /R2_RESTORE_NO_TERMINAL_RECORD/);
});

test('ENGINE PARITY: the terminal record is emitted by the CALLER, not by an engine', () => {
    const cli = fs.readFileSync(CLI, 'utf8');
    const bridge = fs.readFileSync(path.join(HERE, 'lib', 'r2-bridge.js'), 'utf8');
    const handoff = fs.readFileSync(path.join(HERE, 'lib', 'r2-handoff.js'), 'utf8');
    // Only the CLI emits it, so no engine can omit it.
    assert.match(cli, /\[R2-CLI-RESULT\]/);
    assert.equal(/R2-CLI-RESULT/.test(bridge), false, 'the bridge must not own the terminal record');
    assert.equal(/R2-CLI-RESULT/.test(handoff), false, 'the JS engine must not own the terminal record');
    // And there is exactly ONE engine seam for restore-dir in the CLI.
    assert.equal((cli.match(/restoreDirectoryFromR2FFI\(/g) || []).length, 1,
        'a second seam would be a bypass route');
});

test('ENGINE PARITY: the bridge exposes ONE restore-dir entry point (no side door)', () => {
    const bridge = fs.readFileSync(path.join(HERE, 'lib', 'r2-bridge.js'), 'utf8');
    assert.equal((bridge.match(/export async function restoreDirectoryFromR2FFI/g) || []).length, 1);
    // Whatever the bridge dispatches to, its RESULT is what the CLI gates on, so a
    // future rust engine is governed by the same assertion without further change.
    assert.match(bridge, /export async function restoreDirectoryFromR2FFI\(client, r2Prefix, localDir, opts = \{\}\)/);
});
