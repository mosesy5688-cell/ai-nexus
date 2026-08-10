// OP-GR-B (ruling D-2026-0810-418): END-TO-END terminal paths of runRenorm().
//
// Real NXVF shards written by the repo's own ShardWriter under a SYNTHETIC test
// key, a real >= 32 MiB giant-`tags` record, and a fake R2. The production
// AES_CRYPTO_KEY is never read and never needed.
//
// The invariant every mutating test re-checks: on ANY abandon path the shard
// bytes on disk are IDENTICAL to what they were before the run. "Self-abandon
// with zero rewrites" is asserted against SHA-256, not against a log line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AES_CRYPTO_KEY = 'b'.repeat(64); // synthetic test key -- NOT production

const { runRenorm, OUTCOME } = await import('./lib/registry-renorm-run.js');
const { initCrypto, readShardIndex, entityText } = await import('./lib/registry-renorm-shard.js');
const { GIANT_MIN_BYTES } = await import('./lib/registry-renorm-core.js');
const { GIANT_ID, sha, smallRec, giantRec, censusOf, buildRegistry, fakeS3 } = await import('./registry-renorm-fixtures.mjs');

/** Build a scratch case: registry with [small, giant, small] plus artifact dir. */
async function scenario() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogb-run-'));
    const registryDir = path.join(root, 'cache', 'registry');
    const texts = [smallRec('kaggle-dataset--x--keep0'), giantRec(GIANT_ID), smallRec('kaggle-dataset--x--keep1')];
    const shardPath = await buildRegistry(registryDir, texts);
    return { root, registryDir, shardPath, texts, artifactDir: path.join(root, 'op-gr-b'), before: sha(shardPath) };
}

const base = (s, extra = {}) => ({
    bucket: 'test-bucket', registryDir: s.registryDir, artifactDir: s.artifactDir,
    flagEnabled: true, snapshotMaxBytes: 512 * 1024 * 1024,
    context: { run_id: '1', run_attempt: '1', head_sha: 'deadbeef' }, ...extra,
});
const cleanup = (s) => fs.rmSync(s.root, { recursive: true, force: true });

test('R1 flag unset: inert -- nothing read, nothing written, no artifact dir', async () => {
    const s = await scenario();
    try {
        const r = await runRenorm(base(s, { s3: fakeS3(), censusDoc: censusOf([GIANT_ID]), flagEnabled: false }));
        assert.equal(r.outcome, OUTCOME.INERT);
        assert.equal(fs.existsSync(s.artifactDir), false, 'an inert step must not even create its artifact dir');
        assert.equal(sha(s.shardPath), s.before);
    } finally { cleanup(s); }
});

test('R2 completion marker present: skips, and rewrites nothing', async () => {
    const s = await scenario();
    try {
        const s3 = fakeS3({ marker: { run_id: '999', shards_rewritten: 1 } });
        const r = await runRenorm(base(s, { s3, censusDoc: censusOf([GIANT_ID]) }));
        assert.equal(r.outcome, OUTCOME.SKIPPED_MARKER_PRESENT);
        assert.equal(r.marker.run_id, '999');
        assert.equal(sha(s.shardPath), s.before, 'a skip must leave the registry byte-identical');
        assert.equal(s3.puts.length, 0, 'a skip must not re-write the marker');
    } finally { cleanup(s); }
});

test('R3 marker unreadable: abandons rather than assume it has not run', async () => {
    const s = await scenario();
    try {
        const boom = new Error('AccessDenied'); boom.name = 'AccessDenied'; boom.$metadata = { httpStatusCode: 403 };
        const r = await runRenorm(base(s, { s3: fakeS3({ headError: boom }), censusDoc: censusOf([GIANT_ID]) }));
        assert.equal(r.outcome, OUTCOME.ABANDONED);
        assert.match(r.reason, /marker unreadable/);
        assert.equal(sha(s.shardPath), s.before);
    } finally { cleanup(s); }
});

test('R4 census names an id that is not giant: MISMATCH -> zero rewrites', async () => {
    const s = await scenario();
    try {
        const s3 = fakeS3();
        const r = await runRenorm(base(s, { s3, censusDoc: censusOf([GIANT_ID, 'kaggle-dataset--absent--id']) }));
        assert.equal(r.outcome, OUTCOME.ABANDONED);
        assert.equal(sha(s.shardPath), s.before, 'THE invariant: a mismatch rewrites nothing');
        assert.equal(s3.puts.length, 0, 'no marker may be written on an abandon');
        const m = JSON.parse(fs.readFileSync(path.join(s.artifactDir, 'dry-run-manifest.json'), 'utf8'));
        assert.equal(m.status, 'ABANDONED');
        assert.deepEqual(m.reconciliation.missing, ['kaggle-dataset--absent--id']);
    } finally { cleanup(s); }
});

test('R5 a giant the census does not name: MISMATCH -> zero rewrites', async () => {
    const s = await scenario();
    try {
        const r = await runRenorm(base(s, { s3: fakeS3(), censusDoc: censusOf(['kaggle-dataset--other--thing']) }));
        assert.equal(r.outcome, OUTCOME.ABANDONED);
        assert.equal(sha(s.shardPath), s.before);
        const m = JSON.parse(fs.readFileSync(path.join(s.artifactDir, 'dry-run-manifest.json'), 'utf8'));
        assert.deepEqual(m.reconciliation.extra, [GIANT_ID]);
    } finally { cleanup(s); }
});

test('R6 snapshot over budget: abandons BEFORE mutating', async () => {
    const s = await scenario();
    try {
        const r = await runRenorm(base(s, { s3: fakeS3(), censusDoc: censusOf([GIANT_ID]), snapshotMaxBytes: 16 }));
        assert.equal(r.outcome, OUTCOME.ABANDONED);
        assert.match(r.reason, /pre-image snapshot would exceed/);
        assert.equal(sha(s.shardPath), s.before, 'no pre-image => no rewrite, ever');
    } finally { cleanup(s); }
});

test('R7 MATCH: transforms the cohort, preserves everything else, verifies, marks done', async () => {
    const s = await scenario();
    try {
        const s3 = fakeS3();
        const r = await runRenorm(base(s, { s3, censusDoc: censusOf([GIANT_ID]) }));
        assert.equal(r.outcome, OUTCOME.VERIFIED, 'the happy path must actually reach VERIFIED');

        // Record count invariant, and the giant is gone.
        assert.equal(r.shards[0].entity_count_before, 3);
        assert.equal(r.shards[0].entity_count_after, 3);
        assert.equal(r.verification.giant_records_remaining.length, 0);
        assert.ok(r.verification.max_record_bytes_after < GIANT_MIN_BYTES);
        assert.ok(r.accounting.bytes_reclaimed_total > 30 * 1024 * 1024);

        // Untouched records are byte-identical; the giant carries the stamps.
        initCrypto();
        const after = readShardIndex(s.shardPath);
        const got = [];
        for (const e of after.entries) got.push((await entityText(after, e)).toString('utf8'));
        assert.equal(got[0], s.texts[0], 'neighbour record 0 must be byte-identical');
        assert.equal(got[2], s.texts[2], 'neighbour record 2 must be byte-identical');
        const fixed = JSON.parse(got[1]);
        assert.ok(fixed.tags.every((t) => typeof t === 'string'));
        assert.equal(fixed.tags.length, 64);
        assert.equal(fixed.tags_policy, 'kaggle/tags/list-cap/1');
        assert.equal(fixed.tags_truncated, true);
        assert.equal(fixed.tags_projected, 'kaggle-tag-dto-name/1');
        assert.equal(fixed.name, 'g', 'a non-governed field must survive the round trip');

        // Pre-image snapshot exists and is hashed.
        const sums = JSON.parse(fs.readFileSync(path.join(s.artifactDir, 'pre-image', 'SHA256SUMS.json'), 'utf8'));
        assert.equal(sums.shards[0].sha256, s.before, 'the pre-image must hash to the ORIGINAL shard');
        assert.equal(sha(path.join(s.artifactDir, 'pre-image', 'part-000.bin')), s.before);

        // Completion marker written exactly once, and only now.
        assert.equal(s3.puts.length, 1);
        assert.equal(s3.puts[0].Key, 'state/op-gr-b/renorm-complete.json');

        // The refresh census must be honest about what 1/4 cannot observe.
        const v = JSON.parse(fs.readFileSync(path.join(s.artifactDir, 'verification.json'), 'utf8'));
        assert.equal(v.status, 'VERIFIED');
        assert.ok(v.refresh_census.some((c) => c.observable_here === false && /3\/4 aggregate/.test(c.stage)),
            'later-stage refreshes must be recorded as expectations, naming the stage');
        assert.ok(v.refresh_census.some((c) => /GHA cache global-registry/.test(c.copy)),
            'the authoritative carrier must be named in the refresh census');
    } finally { cleanup(s); }
});

test('R8 idempotence without the marker: a second pass finds no giants and abandons', async () => {
    const s = await scenario();
    try {
        await runRenorm(base(s, { s3: fakeS3(), censusDoc: censusOf([GIANT_ID]) }));
        const afterFirst = sha(s.shardPath);
        // Marker deliberately still absent: this proves the STRUCTURAL guard.
        const r = await runRenorm(base(s, { s3: fakeS3(), censusDoc: censusOf([GIANT_ID]) }));
        assert.equal(r.outcome, OUTCOME.ABANDONED);
        assert.equal(sha(s.shardPath), afterFirst, 'a second pass must not touch an already-repaired registry');
    } finally { cleanup(s); }
});
