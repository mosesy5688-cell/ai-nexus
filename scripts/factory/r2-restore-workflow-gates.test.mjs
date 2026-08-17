// REST-2 + REST-3 (D-2026-0816-438): the D-250 registry gate in
// .github/workflows/factory-upload.yml.
//
// REST-2a  the restore-dir invocation carries --strict
// REST-2b  the floor is EQUALITY against the manifest-declared expected count,
//          not a static 100 and not BIN_COUNT compared with itself
// REST-3   the [R2-CLI-RESULT] terminal record is CONSUMED; a restore that
//          "succeeds" without one is a named blocking failure
//
// The REST-3 assertions EXECUTE the real shell text lifted out of the workflow
// against fixtures shaped like the 08-16 incident log. Hermetic - no network,
// credentials or R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF = path.join(HERE, '..', '..', '.github', 'workflows', 'factory-upload.yml');
const wf = fs.readFileSync(WF, 'utf8');

/** The D-250 registry restore invocation. */
const D250_RESTORE = /node scripts\/factory\/r2-workflow-cli\.js restore-dir state\/registry\/ cache\/registry\/ --strict/;

// --- REST-2a ----------------------------------------------------------------

test('REST-2a the D-250 registry restore-dir carries --strict', () => {
    assert.match(wf, D250_RESTORE);
});

test('REST-2a MUTATION: stripping --strict makes the pin RED', () => {
    const mutated = wf.replace(
        'restore-dir state/registry/ cache/registry/ --strict',
        'restore-dir state/registry/ cache/registry/');
    assert.notEqual(mutated, wf, 'mutation must apply');
    assert.equal(D250_RESTORE.test(mutated), false, 'pin goes RED without --strict');
});

// --- REST-2a swallow disposal (D-439 SS A.b) --------------------------------

/** The single D-250 registry restore-dir line, isolated. */
function d250Line() {
    const line = wf.split('\n').find((l) => l.includes('restore-dir state/registry/ cache/registry/'));
    assert.ok(line, 'the D-250 registry restore-dir line must exist');
    return line;
}

test('REST-2a the `|| echo` swallow that neutralized --strict is GONE', () => {
    const line = d250Line();
    // The old form discarded the strict exit in place: --strict could fire and the
    // caller would still continue as if nothing happened (double swallow).
    assert.equal(/\|\| echo/.test(line), false, 'no or-echo swallow may remain on this call');
    // A1: piped through tee so heartbeats stay live; PIPESTATUS[0] carries node's real
    // exit code (the step sets no pipefail, so the pipeline status is tee's).
    assert.match(line, /\| tee "\$RESTORE_LOG"/, 'heartbeats must stay visible live');
    assert.match(wf, /RESTORE_RC=\$\{PIPESTATUS\[0\]\}/, 'the exit code must be captured, not discarded');
    // And the captured code is actually reported rather than dropped on the floor.
    assert.match(wf, /if \[ "\$RESTORE_RC" -ne 0 \]; then/);
});

test('REST-2a MUTATION: re-hanging the `||` swallow makes the pin RED', () => {
    const mutated = wf.replace(
        'restore-dir state/registry/ cache/registry/ --strict 2>&1 | tee "$RESTORE_LOG"',
        'restore-dir state/registry/ cache/registry/ --strict 2>&1 || echo "unavailable"');
    assert.notEqual(mutated, wf, 'mutation must apply');
    const mutatedLine = mutated.split('\n').find((l) => l.includes('restore-dir state/registry/ cache/registry/'));
    assert.equal(/\| tee "\$RESTORE_LOG"/.test(mutatedLine), false, 'capture pin goes RED');
    assert.equal(/\|\| echo/.test(mutatedLine), true, 'the swallow is back');
});

test('REST-2a A1: PIPESTATUS is read on the line immediately after the pipeline', () => {
    // If anything intervenes, PIPESTATUS no longer describes the restore.
    const lines = wf.split('\n');
    const i = lines.findIndex((l) => l.includes('restore-dir state/registry/ cache/registry/'));
    assert.match(lines[i + 1], /^\s*RESTORE_RC=\$\{PIPESTATUS\[0\]\}\s*$/);
});

test('REST-2a the swallow disposal did NOT early-exit past the bootstrap fallback', () => {
    // D-439 option (b): bootstrap semantics retained, manifest-level adjudication.
    const bootstrapCall = 'node scripts/factory/lib/r2-registry-restore.js';
    assert.ok(wf.includes(bootstrapCall), 'legacy bootstrap must stay reachable');
    assert.ok(wf.indexOf('RESTORE_RC=${PIPESTATUS[0]}') < wf.indexOf(bootstrapCall),
        'the capture must precede the bootstrap, i.e. no early exit was introduced');
});

test('REST-5 SCOPE: the mesh-profile restore-dir is TEXTUALLY untouched', () => {
    const mesh = wf.split('\n').find((l) => l.includes('restore-dir state/mesh-profile-shards/'));
    assert.ok(mesh, 'the mesh-profile line must still exist');
    // TEXTUALLY untouched; runtime semantics DO change via the above-fork gate -- see
    // blast-radius disclosure. REST-1a turns this call site (and factory-process.yml
    // 167/168, plus the query-*.yml:35/39 probe sites) from best-effort into
    // fail-closed whenever a manifest is found and the restore comes up short. Only
    // the --strict token is reserved to REST-5.
    assert.equal(/--strict/.test(mesh), false,
        'D-439: the --strict token on this line is reserved to REST-5');
});

// --- REST-2b ----------------------------------------------------------------

test('REST-2b the gate is equality against the manifest expected count', () => {
    assert.match(wf, /if \[ "\$BIN_COUNT" -ne "\$EXPECTED" \]; then/);
    assert.match(wf, /R2_REGISTRY_INCOMPLETE/);
    // EXPECTED is read from the manifest-derived terminal record, never from disk.
    assert.match(wf, /EXPECTED="\$\{TERMINAL_RECORD##\*\\"expected\\":\}"/);
});

test('REST-2b the static 100 floor is GONE from the authoritative gate', () => {
    // The old text failed open at anything >= 100 (the incident passed with 449).
    assert.equal(
        /No current-cycle registry established[\s\S]*?100 \.bin shard floor/.test(wf), false,
        'the static-floor error text must not survive');
    assert.equal(/if \[ "\$BIN_COUNT" -lt 100 \]; then/.test(wf), false,
        'no -lt 100 gate may remain on the R2 authority path');
});

test('REST-2b MUTATION: reverting the floor to >=100 makes the pin RED', () => {
    const mutated = wf.replace(/if \[ "\$BIN_COUNT" -ne "\$EXPECTED" \]; then/g,
        'if [ "$BIN_COUNT" -lt 100 ]; then');
    assert.notEqual(mutated, wf, 'mutation must apply');
    assert.equal(/if \[ "\$BIN_COUNT" -ne "\$EXPECTED" \]; then/.test(mutated), false, 'pin goes RED');
    assert.equal(/if \[ "\$BIN_COUNT" -lt 100 \]; then/.test(mutated), true, 'static floor is back');
});

test('REST-2b a missing manifest fails CLOSED (D-2), never a self-derived floor', () => {
    assert.match(wf, /R2_REGISTRY_MANIFEST_UNAVAILABLE/);
    assert.match(wf, /if \[ "\$MANIFEST_FOUND" != "true" \] \|\| \[ -z "\$EXPECTED" \] \|\| \[ "\$EXPECTED" -le 0 \]; then/);
});

// --- REST-3: execute the REAL shell gate ------------------------------------

/** Lift the REST-3 + REST-2b gate text out of the workflow and dedent it. */
function extractGate() {
    const lines = wf.split('\n');
    const start = lines.findIndex((l) => l.includes('TERMINAL_RECORD="$(grep'));
    const endMarker = lines.findIndex((l, i) => i > start && l.includes('R2_REGISTRY_MANIFEST_UNAVAILABLE'));
    assert.ok(start > 0 && endMarker > start, 'gate text must be locatable in the workflow');
    const block = lines.slice(start, endMarker + 3); // include the exit 1 and fi
    const indent = Math.min(...block.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
    return block.map((l) => l.slice(indent)).join('\n');
}

/** Run the lifted gate against a fixture restore log. */
function runGate(logContents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest3-'));
    const log = path.join(dir, 'restore.log');
    fs.writeFileSync(log, logContents);
    const script = path.join(dir, 'gate.sh');
    fs.writeFileSync(script, `RESTORE_LOG="$1"\n${extractGate()}\necho "GATE-PASSED"\n`);
    const r = spawnSync('bash', [script, log], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// Byte-shaped from the real 08-16 incident log (job 95139906396): heartbeats
// stall at 449/654 with failed:0, then NOTHING. No phase:complete, no terminal.
const INCIDENT_LOG = [
    '[R2-HANDOFF] Manifest found: 654 files. Restoring to cache/registry/...',
    '[R2-RESTORE-PROGRESS] {"schema":"r2-restore-progress/1","phase":"in_progress","elapsed_s":150,"processed":449,"restored":449,"failed":0,"expected":654,"restored_bytes":897220610,"concurrency":5}',
    '[R2-RESTORE-PROGRESS] {"schema":"r2-restore-progress/1","phase":"in_progress","elapsed_s":180,"processed":449,"restored":449,"failed":0,"expected":654,"restored_bytes":897220610,"concurrency":5}',
    '',
].join('\n');

// The 08-15 healthy precedent (job 94990288895) for the same prefix.
const HEALTHY_LOG = [
    '[R2-HANDOFF] Manifest found: 653 files. Restoring to cache/registry/...',
    '[R2-RESTORE-PROGRESS] {"schema":"r2-restore-progress/1","phase":"complete","elapsed_s":68,"processed":653,"restored":653,"failed":0,"expected":653,"restored_bytes":1185628322,"concurrency":5}',
    '[R2-CLI-RESULT] {"action":"restore-dir","success":true,"restored":653,"expected":653,"missing":[],"failed":[],"source":"manifest","manifestFound":true}',
    '[R2-CLI] restore-dir: 653/653 restored from state/registry/ (source=manifest)',
    '',
].join('\n');

test('REST-3 RED-before: the real incident log (stall, no terminal) FIRES the gate', () => {
    const r = runGate(INCIDENT_LOG);
    assert.equal(r.code, 1, 'a restore with no terminal record must block');
    assert.match(r.out, /::error::\[REST-3\] R2_RESTORE_NO_TERMINAL_RECORD/);
    assert.equal(r.out.includes('GATE-PASSED'), false);
});

test('REST-3 the healthy 08-15 precedent PASSES the gate (zero regression)', () => {
    const r = runGate(HEALTHY_LOG);
    assert.equal(r.code, 0, `healthy log must pass; got: ${r.out}`);
    assert.match(r.out, /GATE-PASSED/);
});

test('REST-3 MUTATION: suppressing the terminal record fires the shell gate', () => {
    // Exactly what a regression in r2-workflow-cli.js would look like from outside.
    const suppressed = HEALTHY_LOG.split('\n').filter((l) => !l.includes('[R2-CLI-RESULT]')).join('\n');
    assert.notEqual(suppressed, HEALTHY_LOG, 'mutation must apply');
    const r = runGate(suppressed);
    assert.equal(r.code, 1, 'the shell gate catches a suppressed terminal record');
    assert.match(r.out, /R2_RESTORE_NO_TERMINAL_RECORD/);
});

test('REST-2b a manifest-less terminal record fails CLOSED', () => {
    const noManifest = '[R2-CLI-RESULT] {"action":"restore-dir","success":false,"restored":0,"expected":0,'
        + '"missing":[],"failed":[],"source":"list-fallback","manifestFound":false}\n';
    const r = runGate(noManifest);
    assert.equal(r.code, 1);
    assert.match(r.out, /R2_REGISTRY_MANIFEST_UNAVAILABLE/);
});

test('REST-2b the incident counts survive into EXPECTED for the equality gate', () => {
    // A terminal record IS present but short: REST-3 passes, and EXPECTED becomes
    // the manifest's 654 so the later equality gate can catch the 449.
    const shortRecord = '[R2-CLI-RESULT] {"action":"restore-dir","success":false,"restored":449,"expected":654,'
        + '"missing":[],"failed":[],"source":"manifest","manifestFound":true}\n';
    const r = runGate(shortRecord);
    assert.equal(r.code, 0, 'REST-3 is satisfied by the presence of the record');
    assert.match(r.out, /GATE-PASSED/);
});

// --- layer independence (PR-GR-A F1 same-wall precedent) --------------------

test('REST-1 and REST-3 are independently reachable, not the same throw point', () => {
    const cli = fs.readFileSync(path.join(HERE, 'r2-workflow-cli.js'), 'utf8');
    // REST-1a throws IN process, from the CLI, under its own name.
    assert.match(cli, /formatRestoreGateRecord\(gate\.record\)/);
    assert.equal(/R2_RESTORE_NO_TERMINAL_RECORD/.test(cli), false);
    // REST-3 blocks OUT of process, from the workflow shell, under a different name.
    assert.match(wf, /R2_RESTORE_NO_TERMINAL_RECORD/);
    assert.equal(/formatRestoreGateRecord/.test(wf), false);
    // The incident shape (process dies mid-restore) never reaches the in-process
    // assertion at all, which is exactly why the shell layer has to exist.
    const r = runGate(INCIDENT_LOG);
    assert.equal(r.code, 1);
});
