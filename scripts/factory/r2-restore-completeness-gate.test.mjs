// REST-1a (D-2026-0816-438): manifest-authoritative completeness assertion at the
// CLI/caller layer, ABOVE the rust-FFI / JS dual-engine fork.
//
// The fixtures are the REAL 08-16 incident numbers (run 31936530908, job
// 95139906396): a manifest declaring 654 members, 449 restored, failed 0, and a
// process that reported success. Hermetic - no network, credentials or R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    evaluateRestoreCompleteness, formatRestoreGateRecord,
    RESTORE_INCOMPLETE_CODE, RESTORE_GATE_MARKER,
} from './lib/r2-restore-gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'r2-workflow-cli.js');
const GATE = path.join(HERE, 'lib', 'r2-restore-gate.js');

/** The exact shape r2-workflow-cli.js emits, with the incident's counts. */
const INCIDENT = {
    action: 'restore-dir', success: true, restored: 449, expected: 654,
    missing: [], failed: [], source: 'manifest', manifestFound: true,
};
/** The 08-15 healthy precedent for the same prefix (run 31875176698). */
const HEALTHY = {
    action: 'restore-dir', success: true, restored: 653, expected: 653,
    missing: [], failed: [], source: 'manifest', manifestFound: true,
};

test('REST-1a RED-before shape: 449 of a manifest-declared 654 is a FAILURE', () => {
    const v = evaluateRestoreCompleteness(INCIDENT);
    assert.equal(v.ok, false, 'a partial restore must not be accepted');
    assert.equal(v.code, RESTORE_INCOMPLETE_CODE);
    assert.equal(v.record.expected, 654);
    assert.equal(v.record.restored, 449);
    assert.equal(v.record.shortfall, 205);
});

test('REST-1a partial success is failure even when failed:0 and success:true', () => {
    // This is the precise reason the incident was invisible: nothing FAILED, the
    // set was simply short, and the caller reported success.
    assert.equal(INCIDENT.failed.length, 0);
    assert.equal(INCIDENT.success, true);
    assert.equal(evaluateRestoreCompleteness(INCIDENT).ok, false);
});

test('REST-1a the healthy 653/653 precedent stays GREEN (zero regression)', () => {
    assert.equal(evaluateRestoreCompleteness(HEALTHY).ok, true);
    assert.equal(evaluateRestoreCompleteness({ ...HEALTHY, missing: [], failed: [] }).ok, true);
});

test('REST-1a a missing or failed member is incomplete even at full count', () => {
    assert.equal(evaluateRestoreCompleteness({ ...HEALTHY, missing: ['x'] }).ok, false);
    assert.equal(evaluateRestoreCompleteness({ ...HEALTHY, failed: ['y'] }).ok, false);
});

test('REST-1a expected comes from the MANIFEST, never from what we downloaded', () => {
    // Self-derived expectation (D-3) would make every restore trivially complete.
    const selfDerived = { ...INCIDENT, expected: INCIDENT.restored };
    assert.equal(evaluateRestoreCompleteness(selfDerived).ok, true,
        'control: if expected were self-derived the gate could never fire');
    assert.equal(evaluateRestoreCompleteness(INCIDENT).ok, false,
        'with the real manifest authority it DOES fire');
});

test('REST-1a no independent authority => pre-existing strict semantics, unchanged', () => {
    // A cold prefix on a best-effort call site must keep behaving as it does today.
    assert.equal(evaluateRestoreCompleteness({ manifestFound: false, expected: 0, restored: 0 }).ok, true);
    assert.equal(evaluateRestoreCompleteness({ manifestFound: true, expected: 0, restored: 0 }).ok, true);
    assert.equal(evaluateRestoreCompleteness(null).ok, true);
});

test('REST-1a the emitted record carries COUNTS ONLY - never an object key', () => {
    const POISON = [
        'state/registry/part-00449.bin',
        'AKIAIOSFODNN7EXAMPLE',
        'https://bucket.r2.cloudflarestorage.com/x?X-Amz-Signature=deadbeef',
    ];
    const v = evaluateRestoreCompleteness({
        ...INCIDENT, missing: POISON, failed: [POISON[0]],
    });
    const line = formatRestoreGateRecord(v.record);
    assert.ok(line.startsWith(RESTORE_GATE_MARKER));
    for (const s of POISON) assert.equal(line.includes(s), false, `gate record leaked: ${s}`);
    // The keys became counts.
    assert.equal(v.record.missing, 3);
    assert.equal(v.record.failed, 1);
    for (const val of Object.values(v.record)) {
        assert.ok(typeof val === 'number' || val === RESTORE_INCOMPLETE_CODE);
    }
});

// --- ABOVE-THE-FORK placement proof -----------------------------------------

test('REST-1a the assertion is wired at the CLI seam, above the FFI/JS fork', () => {
    const cli = fs.readFileSync(CLI, 'utf8');
    // The CLI calls the BRIDGE (the fork owner), not the JS implementation.
    assert.match(cli, /restoreDirectoryFromR2FFI\(undefined, r2Prefix, localDir, \{ strict \}\)/);
    assert.equal(/restoreDirectoryFromR2\(/.test(cli), false,
        'the CLI must not reach past the bridge into the JS engine');
    // The gate runs on the bridge RESULT, so both engines are governed.
    assert.match(cli, /const gate = evaluateRestoreCompleteness\(result\);/);
    assert.match(cli, /if \(!gate\.ok\) \{[^\n]*process\.exit\(1\)/);
    // Ordering: the gate must sit AFTER the engine call.
    assert.ok(cli.indexOf('restoreDirectoryFromR2FFI(') < cli.indexOf('evaluateRestoreCompleteness(result)'));
    // And the JS engine body must NOT be where the assertion lives.
    const handoff = fs.readFileSync(path.join(HERE, 'lib', 'r2-handoff.js'), 'utf8');
    assert.equal(/evaluateRestoreCompleteness/.test(handoff), false,
        'an assertion inside the JS body would be bypassed by the FFI wrapper');
});

// --- MUTATION PIN (executes a mutated copy of the production file) -----------

test('REST-1a MUTATION: a self-derived expectation makes the gate a no-op => RED', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest1a-'));
    const mutant = path.join(dir, 'r2-restore-gate.mutant.mjs');
    const src = fs.readFileSync(GATE, 'utf8');
    // D-3 violation: derive `expected` from what we happened to restore.
    const mutated = src
        .replace("export { registerPendingRestore, resolvePendingRestore } from './r2-restore-exit-guard.js';", '')
        .replace('const expected = count(r.expected);', 'const expected = count(r.restored);');
    assert.notEqual(mutated, src, 'mutation must apply');
    fs.writeFileSync(mutant, mutated);
    const m = await import(`file://${mutant.split(path.sep).join('/')}`);
    // Under the mutation the incident is silently "complete" -> the pin above goes RED.
    assert.equal(m.evaluateRestoreCompleteness(INCIDENT).ok, true,
        'mutated gate accepts 449/654 => the real pin is not a constant-true no-op');
    fs.rmSync(dir, { recursive: true, force: true });
});
