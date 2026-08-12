// REHEARSAL-1 (D-2026-0812-422 / D-2026-0812-423): the reconcile-only lane.
//
// Two halves, both required:
//   STATIC  the workflow really is dispatch-only, carries the [REHEARSAL]
//           identity, states its own non-acceptance, and contains no
//           production-write step.
//   BEHAVIOURAL  reconcile-only really cannot reach the mutating half. The pin
//           that matters is ZERO PutObjectCommand through a fake S3 plus an
//           untouched registry -- deleting the hard stop must turn it RED.
//
// HERMETIC: real NXVF fixtures under a SYNTHETIC key, fake R2, throwaway dirs.
// No network, no credentials, no production key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

process.env.AES_CRYPTO_KEY = 'd'.repeat(64); // synthetic test key -- NOT production

const { runRenorm, OUTCOME, exitCodeFor } = await import('./lib/registry-renorm-run.js');
const { buildRegistry, fakeS3, censusOf, smallRec, giantRec, GIANT_ID } = await import('./registry-renorm-fixtures.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WF_PATH = path.join(ROOT, '.github', 'workflows', 'rehearsal-registry-reconcile.yml');
const wfText = () => fs.readFileSync(WF_PATH, 'utf8').replace(/\r\n/g, '\n');
const wf = parseYaml(wfText());

// --- STATIC: the workflow ---------------------------------------------------

test('H1 dispatch-only: no schedule, no workflow_run, no repository_dispatch', () => {
    assert.deepEqual(Object.keys(wf.on), ['workflow_dispatch'],
        'ZERO CASCADE LINKAGE: workflow_dispatch must be the ONLY trigger');
    const t = wfText();
    for (const forbidden of ['\nschedule:', 'workflow_run:', 'repository_dispatch:', '  cron:']) {
        assert.equal(t.includes(forbidden), false, `must not contain ${forbidden.trim()}`);
    }
});

test('H2 [REHEARSAL] identity is in the run-name, and it is not a Factory stage', () => {
    assert.match(wf['run-name'], /^\[REHEARSAL\]/);
    assert.match(wf.name, /REHEARSAL/);
    assert.equal(/factory\s*\d\s*\/\s*4/i.test(wf.name), false,
        'must not adopt the Factory N/4 naming');
    assert.equal(path.basename(WF_PATH).startsWith('factory-'), false,
        'must not live in the factory-*.yml namespace');
});

test('H3 the workflow states its own NON-acceptance (property iii)', () => {
    const t = wfText();
    assert.match(t, /no G criterion/i, 'must disclaim G-criterion satisfaction');
    assert.match(t, /validation window/i, 'must disclaim the validation window');
    assert.match(t, /GITHUB_STEP_SUMMARY/, 'the disclaimer must reach the run summary, not just a comment');
    const summary = wf.jobs.reconcile.steps.find((s) => /Summary/i.test(s.name || ''));
    assert.ok(summary && summary.if === 'always()', 'the disclaimer must be emitted even on failure');
});

test('H4 no production-write step: restore-only cache, no upload/backup to R2', () => {
    const t = wfText();
    // actions/cache@ (without /restore) saves on post -- that WOULD be a write.
    assert.equal(/uses:\s*actions\/cache@/.test(t), false,
        'must use actions/cache/restore, never actions/cache (which saves on post)');
    assert.match(t, /uses:\s*actions\/cache\/restore@/);
    for (const w of ['cache/save@', 'backup-dir', 'upload-file', 'upload-buffer', 'backup-file', 'delete-prefix']) {
        assert.equal(t.includes(w), false, `production-write helper must not appear: ${w}`);
    }
    // The only artifact sink is upload-artifact.
    assert.match(t, /uses:\s*actions\/upload-artifact@/);
});

test('H5 the reconcile step invokes the CLI with --reconcile-only and real secrets', () => {
    const step = wf.jobs.reconcile.steps.find((s) => String(s.run || '').includes('registry-renorm-cli.js'));
    assert.ok(step, 'the reconcile step must exist');
    assert.match(step.run, /--reconcile-only/, 'the mode flag is what makes this a rehearsal');
    assert.equal(step.env.AES_CRYPTO_KEY, '${{ secrets.AES_CRYPTO_KEY }}',
        'property (v): in-domain decryption from the secret store');
    assert.equal(step.env.OP_GR_B_ARTIFACT_DIR, 'rehearsal-out');
    assert.equal(/AES_CRYPTO_KEY:\s*['"][0-9a-fA-F]/.test(wfText()), false, 'no literal key may appear');
});

test('H6 the registry restore mirrors the harvest order: cache FIRST, R2 gap-fill', () => {
    const t = wfText();
    const cacheAt = t.indexOf('restore-keys: |\n            global-registry-');
    const r2At = t.indexOf('node scripts/factory/lib/r2-registry-restore.js');
    const cliAt = t.indexOf('registry-renorm-cli.js --reconcile-only');
    assert.ok(cacheAt > 0 && r2At > 0 && cliAt > 0, 'all three steps must be present');
    assert.ok(cacheAt < r2At, 'GHA cache restore must precede the R2 gap-fill (true loaded state)');
    assert.ok(r2At < cliAt, 'the registry must be fully restored before the reconcile runs');
});

// --- BEHAVIOURAL: reconcile-only cannot write -------------------------------

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function rehearse(censusIds, { marker = null } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reh1-'));
    const registryDir = path.join(root, 'cache', 'registry');
    const shardPath = await buildRegistry(registryDir, [smallRec('kaggle-dataset--x--keep'), giantRec(GIANT_ID)]);
    const before = sha(shardPath);
    const artifactDir = path.join(root, 'rehearsal-out');
    const s3 = fakeS3({ marker });
    const result = await runRenorm({
        s3, bucket: 'test-bucket', censusDoc: censusOf(censusIds), registryDir, artifactDir,
        flagEnabled: true, reconcileOnly: true, snapshotMaxBytes: 512 * 1024 * 1024,
        context: { run_id: '1', run_attempt: '1', head_sha: 'deadbeef' },
    });
    return { root, registryDir, shardPath, before, artifactDir, s3, result };
}
const cleanup = (s) => fs.rmSync(s.root, { recursive: true, force: true });

test('H7 MATCH under reconcile-only: reports, writes NOTHING, mutates NOTHING', async () => {
    const s = await rehearse([GIANT_ID]);
    try {
        // A cohort MATCH is exactly the case that would proceed to rewrite in
        // production. Under reconcile-only it must stop dead.
        assert.equal(s.result.outcome, OUTCOME.RECONCILED);
        assert.equal(s.result.status, 'MATCH');
        assert.equal(s.s3.puts.length, 0, 'ZERO PutObjectCommand -- no marker, no anything');
        assert.equal(sha(s.shardPath), s.before, 'the registry must be byte-identical');
        assert.equal(fs.existsSync(path.join(s.artifactDir, 'pre-image')), false, 'no snapshot');
        assert.equal(fs.existsSync(path.join(s.artifactDir, 'staged')), false, 'no staging');
        assert.equal(fs.existsSync(path.join(s.artifactDir, 'verification.json')), false, 'no verification');
        assert.equal(exitCodeFor(s.result.outcome), 0);
    } finally { cleanup(s); }
});

test('H8 the manifest is complete AND flagged rehearsal:true', async () => {
    const s = await rehearse([GIANT_ID]);
    try {
        const m = JSON.parse(fs.readFileSync(path.join(s.artifactDir, 'dry-run-manifest.json'), 'utf8'));
        assert.equal(m.rehearsal, true, 'must never be confusable with a production manifest');
        assert.equal(m.status, 'MATCH');
        assert.ok(Array.isArray(m.records) && m.records.length === 1);
        assert.ok(m.reconciliation && m.accounting && m.size_probes, 'same fields as the real manifest');
        assert.deepEqual(m.reconciliation.missing, []);
        assert.deepEqual(m.reconciliation.extra, []);
        assert.deepEqual(m.reconciliation.duplicates, []);
        assert.equal(m.marker.state, 'ABSENT', 'marker state is REPORTED');
    } finally { cleanup(s); }
});

test('H9 MISMATCH is a RESULT, not a failure: still zero writes, exit 0', async () => {
    const s = await rehearse(['hf-dataset--absent--id']);
    try {
        assert.equal(s.result.outcome, OUTCOME.RECONCILED);
        assert.equal(s.result.status, 'MISMATCH');
        assert.equal(s.s3.puts.length, 0);
        assert.equal(sha(s.shardPath), s.before);
        assert.equal(exitCodeFor(s.result.outcome), 0, 'a mismatch must not fail the rehearsal');
        const m = JSON.parse(fs.readFileSync(path.join(s.artifactDir, 'dry-run-manifest.json'), 'utf8'));
        assert.equal(m.rehearsal, true);
        assert.equal(m.reconciliation.extra.length, 1);
    } finally { cleanup(s); }
});

test('H10 a PRESENT marker is reported, not obeyed and never re-written', async () => {
    // Production would skip here. A rehearsal must still reconcile, so the
    // marker cannot mask the answer -- and must still not be written.
    const s = await rehearse([GIANT_ID], { marker: { run_id: '999', shards_rewritten: 1 } });
    try {
        assert.equal(s.result.outcome, OUTCOME.RECONCILED, 'must NOT short-circuit to SKIPPED');
        assert.equal(s.s3.puts.length, 0, 'the marker must never be written by a rehearsal');
        const m = JSON.parse(fs.readFileSync(path.join(s.artifactDir, 'dry-run-manifest.json'), 'utf8'));
        assert.equal(m.marker.state, 'PRESENT');
        assert.equal(m.marker.marker.run_id, '999', 'the marker body is reported for the operator');
        assert.equal(sha(s.shardPath), s.before);
    } finally { cleanup(s); }
});

test('H11 production mode is unchanged by the flag (non-regression)', async () => {
    // The same fixture WITHOUT reconcileOnly must still perform the real thing,
    // otherwise the rehearsal lane would have silently disabled the operation.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reh1p-'));
    try {
        const registryDir = path.join(root, 'cache', 'registry');
        await buildRegistry(registryDir, [smallRec('kaggle-dataset--x--keep'), giantRec(GIANT_ID)]);
        const s3 = fakeS3();
        const r = await runRenorm({
            s3, bucket: 'test-bucket', censusDoc: censusOf([GIANT_ID]), registryDir,
            artifactDir: path.join(root, 'op-gr-b'), flagEnabled: true,
            snapshotMaxBytes: 512 * 1024 * 1024, context: {},
        });
        assert.equal(r.outcome, OUTCOME.VERIFIED, 'production path must still complete');
        assert.equal(s3.puts.length, 1, 'production still writes exactly one marker');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('H13 the CLI FORWARDS the mode to runRenorm (call-site pin)', () => {
    // Found by mutation: H5 pins that the WORKFLOW passes --reconcile-only, and
    // H7-H10 pin that runRenorm honours `reconcileOnly` -- but nothing pinned the
    // wiring BETWEEN them. Replacing the pass-through with `reconcileOnly: false`
    // left every other test green while the rehearsal silently ran in PRODUCTION
    // mode. That is the worst failure this lane can have, so it gets its own pin.
    const src = fs.readFileSync(path.join(HERE, 'registry-renorm-cli.js'), 'utf8');
    assert.match(src, /const reconcileOnly = process\.argv\.includes\('--reconcile-only'\);/,
        'the CLI must derive the mode from argv');
    const at = src.indexOf('runRenorm({');
    assert.ok(at > 0, 'the CLI must call runRenorm');
    const call = src.slice(at);
    assert.match(call, /^\s*reconcileOnly,\s*$/m,
        'the mode must be passed through verbatim, not re-derived or hard-coded');
    assert.equal(/reconcileOnly:\s*(false|true)/.test(call), false,
        'the mode must never be hard-coded at the call site');
    assert.match(call, /flagEnabled: reconcileOnly \|\| process\.env\.OP_GR_B_RENORM === 'true'/,
        'a rehearsal must be runnable before the production flag is armed');
});

test('H12 exit-code table still exhaustive with RECONCILED added', () => {
    const all = Object.values(OUTCOME);
    assert.equal(all.length, 6, 'a new terminal outcome must be given an explicit exit code');
    for (const o of all) assert.equal(exitCodeFor(o), o === OUTCOME.VERIFICATION_FAILED ? 1 : 0, o);
});
