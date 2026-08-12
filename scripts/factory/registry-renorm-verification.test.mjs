// OP-GR-B (ruling D-2026-0810-418): THE UNRECOVERABLE OUTCOME.
//
// Gate-2 REQUIRED-R1. Every other terminal of runRenorm() is safe by
// construction -- it either mutated nothing, or it mutated and verified. This
// file covers the one path that is neither: the registry WAS rewritten and the
// post-transform verification FAILED.
//
// Why it is the single dangerous outcome: if a failed verification still wrote
// the durable R2 completion marker, the one-time operation would be permanently
// disabled over a corrupt registry -- unrecoverable without manual R2 surgery.
// The reviewer's MUT-F (`if (!verification.ok) {` -> `if (false) {`) made
// exactly that happen and every suite stayed GREEN. These tests close it.
//
// The failure is driven by a REAL reachable record shape, not a stub: a record
// oversized because of a NON-governed field, which the `tags` contract cannot
// shrink. Real NXVF, real AES under a synthetic key, fake R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AES_CRYPTO_KEY = 'c'.repeat(64); // synthetic test key -- NOT production

const { runRenorm, OUTCOME, exitCodeFor } = await import('./lib/registry-renorm-run.js');
const { GIANT_MIN_BYTES } = await import('./lib/registry-renorm-core.js');
const { buildRegistry, fakeS3, censusOf, smallRec, unfixableGiant } = await import('./registry-renorm-fixtures.mjs');

const UNFIXABLE_ID = 'kaggle-dataset--synthetic--unfixable';

async function failingScenario() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogb-verify-'));
    const registryDir = path.join(root, 'cache', 'registry');
    await buildRegistry(registryDir, [smallRec('kaggle-dataset--x--keep0'), unfixableGiant(UNFIXABLE_ID)]);
    const artifactDir = path.join(root, 'op-gr-b');
    const s3 = fakeS3();
    const result = await runRenorm({
        s3, bucket: 'test-bucket', censusDoc: censusOf([UNFIXABLE_ID]), registryDir, artifactDir,
        flagEnabled: true, snapshotMaxBytes: 512 * 1024 * 1024,
        context: { run_id: '1', run_attempt: '1', head_sha: 'deadbeef' },
    });
    return { root, artifactDir, s3, result };
}

test('V1 a surviving giant fails verification and reports which record survived', async () => {
    const s = await failingScenario();
    try {
        assert.equal(s.result.outcome, OUTCOME.VERIFICATION_FAILED);
        assert.equal(s.result.verification.ok, false);
        assert.deepEqual(s.result.verification.giant_records_remaining.map((g) => g.id), [UNFIXABLE_ID]);
        assert.ok(s.result.verification.max_record_bytes_after >= GIANT_MIN_BYTES);
    } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('V2 THE INVARIANT: a failed verification writes NO completion marker', async () => {
    const s = await failingScenario();
    try {
        assert.equal(s.s3.puts.length, 0,
            'ZERO PutObjectCommand calls -- a marker here would permanently disable the one-time op over a corrupt registry');
    } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('V3 the verification artifact records the failure honestly', async () => {
    const s = await failingScenario();
    try {
        const v = JSON.parse(fs.readFileSync(path.join(s.artifactDir, 'verification.json'), 'utf8'));
        assert.equal(v.status, 'VERIFICATION_FAILED');
        assert.equal(v.verification.ok, false);
        assert.equal(v.verification.giant_records_remaining[0].id, UNFIXABLE_ID);
        assert.ok(Array.isArray(v.refresh_census), 'the refresh census must still be published on the failure path');
    } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('V4 the pre-image survives the failure, so the mutation is recoverable', async () => {
    const s = await failingScenario();
    try {
        const pre = path.join(s.artifactDir, 'pre-image');
        assert.ok(fs.existsSync(path.join(pre, 'part-000.bin')), 'the pre-image shard must remain on disk');
        const sums = JSON.parse(fs.readFileSync(path.join(pre, 'SHA256SUMS.json'), 'utf8'));
        assert.equal(sums.shards.length, 1);
        assert.equal(sums.shards[0].verified, true);
    } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('V5 the process exits NON-ZERO so the cascade stops loudly', async () => {
    const s = await failingScenario();
    try {
        assert.equal(exitCodeFor(s.result.outcome), 1);
    } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('V6 exit-code policy is exhaustive: only VERIFICATION_FAILED is non-zero', () => {
    const all = Object.values(OUTCOME);
    assert.equal(all.length, 6, 'a new terminal outcome must be given an explicit exit code here');
    for (const o of all) {
        assert.equal(exitCodeFor(o), o === OUTCOME.VERIFICATION_FAILED ? 1 : 0, `exit code for ${o}`);
    }
    // Named explicitly so the ACCEPTED exit-0-on-abandon policy cannot drift.
    assert.equal(exitCodeFor(OUTCOME.INERT), 0);
    assert.equal(exitCodeFor(OUTCOME.SKIPPED_MARKER_PRESENT), 0);
    assert.equal(exitCodeFor(OUTCOME.ABANDONED), 0, 'self-abandon must let the cascade proceed (ruling)');
    assert.equal(exitCodeFor(OUTCOME.VERIFIED), 0);
    assert.equal(exitCodeFor(OUTCOME.RECONCILED), 0, 'REHEARSAL-1 reconcile-only mutates nothing');
    assert.equal(exitCodeFor(OUTCOME.VERIFICATION_FAILED), 1);
});
