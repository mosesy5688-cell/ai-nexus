// scripts/factory/rankings-db-handoff-manifest.test.mjs
//
// Hermetic node:test contract suite for the rankings-DB authority repair: the TWO
// cross-stage carriers (SEAM_A "rankings-satellite" 3/4 aggregate-rankings -> 3/4
// finalize, SEAM_B "rankings-db" 3/4 finalize -> 4/4 vfs-pack-db), the COMPLETE-SET
// integrity/identity verifier, and the FAIL-CLOSED pack-finalizer publication gate.
//
// NO network, NO R2, NO @aws-sdk. Real temp dirs + REAL SQLite rankings DBs produced by
// the REAL producer (rankings-db-exporter.exportRankingsDbs) and the REAL fail-closed
// consumer (pack-finalizer.finalizePack), so no assertion re-implements product logic.
//
// ANTI-VACUITY MAP (removing/weakening a guard reds >= 1 NAMED test):
//   * EXACT-10 set floor at generate      -> (S2) 9 members => RANKINGS_DB_SET_MISSING;
//                                            drop checkExactDbSet => green-on-partial.
//   * EXACT-10 set floor (extras)         -> (S13) an 11th rankings-*.db => RANKINGS_DB_SET_EXTRA;
//                                            a count>=10 test would pass it.
//   * any-one-file boolean shortcut       -> (S5)+(S15) 1 valid DB must FAIL; restoring
//                                            `.some(f => f.startsWith('rankings-'))` reds both.
//   * fail-closed BEFORE any write        -> (S2b) finalizePack THROWS and writes NO
//                                            shards_manifest.json on a partial set.
//   * flag is a verification RESULT       -> (S6) finalizePack sets partitions.rankings_dbs
//                                            === true (boolean) ONLY after the full check set.
//   * absent flag is not a negative       -> (S6c) verifyPublishedFlag rejects an ABSENT key
//                                            (RANKINGS_FLAG_ABSENT) and a `false` value.
//   * per-file sha256                     -> (S4a) same-LENGTH tamper => HASH_MISMATCH;
//                                            a size-only check would pass it.
//   * SQLite magic                        -> (S4b) a same-size non-SQLite payload =>
//                                            SQLITE_MAGIC_INVALID.
//   * PRAGMA quick_check                  -> (S4c) an internally corrupted page fails;
//                                            dropping the pragma greens a corrupt DB.
//   * schema derived from the producer     -> (S4d) a dropped index / renamed column reds;
//                                            a hand-copied constant would silently drift.
//   * per-DB provenance + identity         -> (S3a) foreign factory_run_id => IDENTITY_RUN_MISMATCH;
//                                            (S3b) mixed identity across members =>
//                                            IDENTITY_INCONSISTENT; (S3c) attempt from the
//                                            future => IDENTITY_ATTEMPT_FUTURE.
//   * descriptor provenance (SEAM_A/B)     -> (S3d) foreign producer_run_id =>
//                                            DESC_PRODUCER_RUN_MISMATCH; (S9) a missing/
//                                            malformed descriptor => DESC_* fail-loud.
//   * exact staging-prefix derivation      -> (S3e) fixed / mutable-latest / two-level prefix
//                                            => DESC_PREFIX_MISMATCH.
//   * cross-carrier head-SHA family bind   -> (S3f) rankings-db vs cycle-output disagreement
//                                            => SIBLING_*_MISMATCH; dropping it lets a
//                                            foreign-head rankings set promote at 4/4.
//   * `.db` IS a classified member here    -> (S10a) classifyRankingsMember('data/rankings-all.db')
//                                            == 'rankings_db' and it is sha256-verified; while
//                                            (S10b) the FROZEN cycle-output carrier still
//                                            throws UNCLASSIFIED_MEMBER for a stray .db.
//   * DB set cannot mask missing JSON      -> (S11) 10 DBs + zero ranking page JSONs =>
//                                            REQUIRED_CLASS_BELOW_FLOOR (ranking_pages).
//   * rankings_group == filename group     -> (S12) swapped group metadata =>
//                                            GROUP_METADATA_MISMATCH.
//   * promotion is byte-identical          -> (S14) recovered staging -> destination copy has
//                                            IDENTICAL per-file sha256 + set_sha256.
//   * mutable fixed key is never authority -> (S8) a foreign DB at the destination is wiped/
//                                            rejected; it can never satisfy the authority.
//   * exporter EXACT-10 + identity floors  -> (S2c) an empty group => RANKINGS_GROUP_EMPTY
//                                            naming the group + counts; (S7b) missing identity
//                                            env => RANKINGS_IDENTITY_ENV_INVALID (never an
//                                            empty identity silently written into a DB).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
    SCHEMA_VERSION, CARRIERS, HandoffManifestError, carrierConfig, buildStagingPrefix,
    computeSetSha256, classifyRankingsMember, listCarrierFiles, checkExactDbSet,
    generateManifest, verifyDirAgainstManifest, verifyDescriptor, verifySiblingDescriptors,
    verifyPublishedFlag, verifyProjection,
    inspectShardsManifest, verifyShardsManifestSibling, verifyShardsManifestDescriptorFields,
} from './rankings-db-handoff-manifest.mjs';
import {
    verifyRankingsDbFile, verifyRankingsDbSet, assertRankingsDbSet, RankingsDbVerifyError,
    expectedEntityColumns, expectedIndexes, expectedTables, manifestRankingsIndex,
    verifyOptsFromEnv, SQLITE_MAGIC,
} from './lib/rankings-db-verifier.js';
import { exportRankingsDbs, resolveRankingsIdentity, prepareRankingsGroups } from './lib/rankings-db-exporter.js';
import { finalizePack } from './lib/pack-finalizer.js';
import {
    RANKINGS_GROUPS, RANKINGS_DB_COUNT, RANKINGS_DB_NAMES, RANKINGS_CATEGORIES,
    RANKINGS_ENTITY_TYPES, rankingsDbName, rankingsGroupFromDbName,
} from '../../src/constants/rankings-groups.js';
// The FROZEN sibling carrier, imported READ-ONLY to prove it still refuses a stray .db.
import { generateManifest as generateCycleManifest } from './cycle-output-handoff-manifest.mjs';

const RUN_ID = '900100200';
const ATTEMPT = '2';
const HEAD = 'a'.repeat(40);
const FOREIGN_HEAD = 'b'.repeat(40);
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

let TMP_SEQ = 0;
const TMP_DIRS = [];
function mkTmp() {
    const d = path.join(os.tmpdir(), `rankings-db-handoff-${process.pid}-${Date.now()}-${TMP_SEQ++}`);
    fs.mkdirSync(d, { recursive: true });
    TMP_DIRS.push(d);
    return d;
}
function zst(nBytes = 24, seed = 'x') {
    const pad = Buffer.alloc(Math.max(0, nBytes - 4));
    for (let i = 0; i < pad.length; i += 1) pad[i] = (seed.charCodeAt(i % seed.length) + i) & 0xff;
    return Buffer.concat([ZSTD_MAGIC, pad]);
}
function sha256(abs) { return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); }

/** Minimal entity set per group. `hf-` ids pass the #1925 model-qualification filter. */
function makeGroups(perGroup = 2, over = {}) {
    const groups = {};
    for (const g of RANKINGS_GROUPS) {
        groups[g] = Array.from({ length: perGroup }, (_, i) => ({
            id: `hf-model--${g}-${i}`, slug: `${g}-${i}`, name: `${g} ${i}`,
            type: 'model', author: 'a', summary: 's', fni_score: 90 - i, has_gguf: false,
        }));
    }
    return { ...groups, ...over };
}

/** Produce a REAL 10-DB set into `<dir>/data` via the REAL exporter. */
async function realDbSet(over = {}, identity = {}) {
    const dir = mkTmp();
    const saved = { id: process.env.RANKINGS_RUN_ID, at: process.env.RANKINGS_RUN_ATTEMPT, sha: process.env.RANKINGS_HEAD_SHA };
    process.env.RANKINGS_RUN_ID = identity.runId ?? RUN_ID;
    process.env.RANKINGS_RUN_ATTEMPT = identity.attempt ?? ATTEMPT;
    process.env.RANKINGS_HEAD_SHA = identity.headSha ?? HEAD;
    try { await exportRankingsDbs(makeGroups(2, over), dir); }
    finally {
        process.env.RANKINGS_RUN_ID = saved.id; process.env.RANKINGS_RUN_ATTEMPT = saved.at; process.env.RANKINGS_HEAD_SHA = saved.sha;
        if (saved.id === undefined) delete process.env.RANKINGS_RUN_ID;
        if (saved.at === undefined) delete process.env.RANKINGS_RUN_ATTEMPT;
        if (saved.sha === undefined) delete process.env.RANKINGS_HEAD_SHA;
    }
    return dir; // dir/data/rankings-<group>.db x10
}

/** Add the SEAM_A cache-side members (ranking page JSONs + category_stats). */
function addSatelliteCache(dir, { pages = true, categoryStats = true, sidecars = true } = {}) {
    fs.mkdirSync(path.join(dir, 'cache', 'rankings'), { recursive: true });
    if (pages) {
        for (const g of RANKINGS_GROUPS) {
            const gd = path.join(dir, 'cache', 'rankings', g);
            fs.mkdirSync(gd, { recursive: true });
            fs.writeFileSync(path.join(gd, 'p1.json.zst'), zst(40, g));
            if (sidecars) fs.writeFileSync(path.join(gd, 'p1.json.zst.meta.json'), '{"checksum":"deadbeef"}');
        }
    }
    if (categoryStats) fs.writeFileSync(path.join(dir, 'cache', 'category_stats.json.zst'), zst(64, 'cs'));
    return dir;
}

function ctx(over = {}) {
    return { carrierType: 'rankings-db', producerRunId: RUN_ID, producerAttempt: ATTEMPT, headSha: HEAD, createdAt: '1970-01-01T00:00:00.000Z', ...over };
}
function descFor(manifest) {
    return {
        schema_version: SCHEMA_VERSION, carrier_type: manifest.carrier_type,
        producer_run_id: manifest.producer_run_id, producer_attempt: manifest.producer_attempt,
        exact_staging_prefix: manifest.exact_staging_prefix,
        manifest_sha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
        set_sha256: manifest.set_sha256, head_sha: manifest.head_sha, created_at: manifest.created_at_utc,
    };
}
/** The 4/4 cross-workflow consumer supplies NO runAttempt and NO headSha. */
function cur4of4(over = {}) { return { carrierType: 'rankings-db', producerRunId: RUN_ID, ...over }; }
function fullOpts(over = {}) {
    return { expectRunId: RUN_ID, expectHeadSha: HEAD, maxAttempt: ATTEMPT, ...over };
}
/** Minimal finalizePack harness: no meta DBs, stub inject/summary. */
async function runFinalizePack(shardDir, partitionCounts = {}, env = {}) {
    const saved = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    try {
        await finalizePack({}, {}, -1, shardDir, mkTmp(), { packed: 7 }, partitionCounts,
            async () => {}, () => {}, 'build-1');
    } finally {
        for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    return partitionCounts;
}

test.after(() => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// ==========================================================================
// A. Constants + config: the single source and the two carriers
// ==========================================================================
test('(A1) RANKINGS_GROUPS is the frozen ordered EXACT-10 single source', () => {
    assert.equal(RANKINGS_DB_COUNT, 10);
    assert.equal(RANKINGS_GROUPS.length, 10);
    assert.deepEqual([...RANKINGS_GROUPS], ['all', ...RANKINGS_CATEGORIES, ...RANKINGS_ENTITY_TYPES]);
    assert.ok(Object.isFrozen(RANKINGS_GROUPS));
    assert.equal(new Set(RANKINGS_GROUPS).size, 10, 'no duplicate group');
    assert.deepEqual([...RANKINGS_DB_NAMES], RANKINGS_GROUPS.map((g) => `rankings-${g}.db`));
    assert.equal(rankingsDbName('model'), 'rankings-model.db');
    assert.throws(() => rankingsDbName('prompt'), /RANKINGS_GROUP_UNKNOWN/);
    assert.equal(rankingsGroupFromDbName('rankings-all.db'), 'all');
    assert.equal(rankingsGroupFromDbName('rankings-prompt.db'), null, 'an unknown group is never invented');
});

test('(A2) exactly two carriers, distinct prefix roots, distinct producer jobs, EXACT-10 floors', () => {
    assert.deepEqual(Object.keys(CARRIERS).sort(), ['rankings-db', 'rankings-satellite']);
    const a = carrierConfig('rankings-satellite');
    const b = carrierConfig('rankings-db');
    assert.equal(a.prefixRoot, 'state/_handoff/rankings-satellite');
    assert.equal(b.prefixRoot, 'state/_handoff/rankings-db');
    assert.equal(a.producerJob, 'aggregate-rankings');
    assert.equal(b.producerJob, 'finalize');
    assert.notEqual(a.prefixRoot, b.prefixRoot);
    for (const c of [a, b]) {
        assert.equal(c.exactDbSet, true);
        assert.equal(c.assertMemberEligibility, true);
        assert.equal(c.classes.find((x) => x.name === 'rankings_db').min, RANKINGS_DB_COUNT);
    }
    // The staging prefix is derived from (carrier, run, attempt) only -- no mutable latest.
    assert.equal(buildStagingPrefix('rankings-db', RUN_ID, 2), `state/_handoff/rankings-db/${RUN_ID}/attempt-2/`);
    assert.throws(() => carrierConfig('nope'), /CARRIER_UNKNOWN/);
});

test('(A3) schema expectations are DERIVED from the producer RANKINGS_SCHEMA (no hand-copied list)', () => {
    assert.deepEqual([...expectedTables()].sort(), ['entities', 'site_metadata']);
    assert.deepEqual([...expectedIndexes()].sort(), ['idx_fni', 'idx_license_type', 'idx_ollama', 'idx_pipeline', 'idx_type']);
    assert.equal(expectedEntityColumns().length, 34);
    assert.ok(expectedEntityColumns().includes('hosted_on_checked_at'));
    assert.equal(SQLITE_MAGIC.length, 16);
    assert.equal(SQLITE_MAGIC.charCodeAt(15), 0, 'the 16th header byte is NUL');
});

// ==========================================================================
// S1 / S7 -- R2-ONLY success (GHA cache write denied => no accelerator at all)
// ==========================================================================
test('(S1) CACHE_WRITE_DENIED + MISS + R2_ONLY = SUCCESS: a staging tree restored from R2 alone verifies, promotes and re-verifies', async () => {
    const src = await realDbSet();
    // Simulate the exact-staging restore: a /tmp stage holding ONLY the R2 members.
    const stage = mkTmp();
    fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(src, 'data', n), path.join(stage, 'data', n));
    const manifest = generateManifest(stage, ctx());
    assert.equal(manifest.member_count, RANKINGS_DB_COUNT);
    assert.equal(manifest.rankings_db_count, RANKINGS_DB_COUNT);
    assert.equal(verifyDirAgainstManifest(stage, manifest).ok, true);
    // staged check set passes with the manifest bound
    const staged = verifyRankingsDbSet(path.join(stage, 'data'), fullOpts({ manifest, memberPrefix: 'data/' }));
    assert.equal(staged.ok, true, staged.reason);
    assert.equal(staged.count, RANKINGS_DB_COUNT);
    // promote (COPY) into a fresh destination, then RE-VERIFY at the destination
    const dest = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(stage, 'data', n), path.join(dest, n));
    const promoted = verifyRankingsDbSet(dest, fullOpts({ manifest, memberPrefix: 'data/' }));
    assert.equal(promoted.ok, true, promoted.reason);
    assert.deepEqual(promoted.identity, { runId: RUN_ID, attempt: Number(ATTEMPT), headSha: HEAD });
});

test('(S7) GHA_CACHE_DENIED + EXACT_RANKINGS_R2_HANDOFF = SUCCESS: the descriptor round-trip is the whole correctness path', async () => {
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const manifest = generateManifest(stage, ctx());
    const desc = descFor(manifest);
    // producer-side (same run: attempt + head bound)
    const prod = verifyDescriptor(desc, { carrierType: 'rankings-db', producerRunId: RUN_ID, runAttempt: ATTEMPT, headSha: HEAD });
    assert.equal(prod.ok, true, prod.reason);
    assert.equal(prod.staging_prefix, `state/_handoff/rankings-db/${RUN_ID}/attempt-${ATTEMPT}/`);
    // 4/4 cross-workflow consumer (no attempt, no head of its own) still binds run + prefix
    const cons = verifyDescriptor(desc, cur4of4());
    assert.equal(cons.ok, true, cons.reason);
    assert.equal(cons.head_sha, HEAD, 'the descriptor CARRIES the 3/4 head sha to the 4/4 consumer');
    assert.equal(cons.producer_attempt, Number(ATTEMPT));
});

// ==========================================================================
// S2 -- PARTIAL SET fails, and fails BEFORE any write
// ==========================================================================
test('(S2) PARTIAL_SET = FAIL: 9 of 10 members reds generate, verify AND the DB check set', async () => {
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const complete = generateManifest(stage, ctx());
    fs.rmSync(path.join(stage, 'data', 'rankings-model.db'));
    assert.throws(() => generateManifest(stage, ctx()), (e) => e instanceof HandoffManifestError
        && e.code === 'RANKINGS_DB_SET_MISSING' && /rankings-model\.db/.test(e.message));
    const v = verifyDirAgainstManifest(stage, complete);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'FILE_MISSING');
    const s = verifyRankingsDbSet(path.join(stage, 'data'), fullOpts());
    assert.equal(s.ok, false);
    assert.equal(s.code, 'RANKINGS_DB_SET_MISSING');
    assert.match(s.reason, /9\/10 present/);
    assert.throws(() => assertRankingsDbSet(path.join(stage, 'data'), fullOpts()), RankingsDbVerifyError);
});

test('(S2b) PARTIAL_SET = FAIL_BEFORE_PUBLIC_WRITE: finalizePack THROWS and writes NO shards_manifest.json', async () => {
    const src = await realDbSet();
    const shardDir = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(src, 'data', n), path.join(shardDir, n));
    fs.rmSync(path.join(shardDir, 'rankings-dataset.db'));
    const counts = {};
    await assert.rejects(() => runFinalizePack(shardDir, counts), (e) => e instanceof RankingsDbVerifyError
        && e.code === 'RANKINGS_DB_SET_MISSING');
    assert.equal(fs.existsSync(path.join(shardDir, 'shards_manifest.json')), false,
        'the manifest (the only publication artifact this function writes) must NOT exist');
    assert.equal('rankings_dbs' in counts, false, 'the flag is never written on a partial set');
});

test('(S2c) exporter EXACT-10 floor: an empty group fails LOUD naming the group AND the per-group counts', () => {
    assert.throws(() => prepareRankingsGroups(makeGroups(2, { paper: [] })),
        (e) => /RANKINGS_GROUP_EMPTY/.test(e.message) && /\bpaper\b/.test(e.message)
            && /per-group counts/.test(e.message) && /paper=0/.test(e.message));
    // an entity type outside the single source can never sneak a DB in
    assert.throws(() => prepareRankingsGroups(makeGroups(2, { prompt: [{ id: 'x' }] })), /RANKINGS_GROUP_UNEXPECTED/);
    // the #1925 model filter emptying the group is ALSO a loud failure (not a silent skip)
    assert.throws(() => prepareRankingsGroups(makeGroups(2, { model: [{ id: 'gh-nope', slug: 'n' }] })),
        (e) => /RANKINGS_GROUP_EMPTY/.test(e.message) && /model=0\(of 1\)/.test(e.message));
    assert.equal(prepareRankingsGroups(makeGroups(2)).size, RANKINGS_DB_COUNT);
});

// ==========================================================================
// S3 -- FOREIGN RUN / ATTEMPT / HEAD (DB-borne AND descriptor-borne)
// ==========================================================================
test('(S3a) FOREIGN_RUN_OR_ATTEMPT = FAIL: a foreign factory_run_id / head_sha in the DBs reds the set', async () => {
    const foreign = await realDbSet({}, { runId: '111222333', headSha: FOREIGN_HEAD });
    const r = verifyRankingsDbSet(path.join(foreign, 'data'), fullOpts());
    assert.equal(r.ok, false);
    assert.equal(r.code, 'IDENTITY_RUN_MISMATCH');
    const h = verifyRankingsDbSet(path.join(foreign, 'data'), fullOpts({ expectRunId: '111222333' }));
    assert.equal(h.ok, false);
    assert.equal(h.code, 'IDENTITY_HEAD_MISMATCH');
});

test('(S3b) mixed identity across members = IDENTITY_INCONSISTENT (one foreign member is enough)', async () => {
    const good = await realDbSet();
    const foreign = await realDbSet({}, { runId: '111222333', headSha: FOREIGN_HEAD });
    const dest = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(good, 'data', n), path.join(dest, n));
    fs.copyFileSync(path.join(foreign, 'data', 'rankings-tool.db'), path.join(dest, 'rankings-tool.db'));
    const r = verifyRankingsDbSet(dest, {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'IDENTITY_INCONSISTENT');
    assert.match(r.reason, /rankings-tool\.db/);
});

test('(S3c) an attempt from the FUTURE = IDENTITY_ATTEMPT_FUTURE', async () => {
    const src = await realDbSet({}, { attempt: '5' });
    const r = verifyRankingsDbSet(path.join(src, 'data'), fullOpts({ maxAttempt: '2' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'IDENTITY_ATTEMPT_FUTURE');
    assert.equal(verifyRankingsDbSet(path.join(src, 'data'), fullOpts({ maxAttempt: '5' })).ok, true);
});

test('(S3d) descriptor provenance: foreign run / carrier / attempt / head reds fail-loud', async () => {
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const desc = descFor(generateManifest(stage, ctx()));
    assert.equal(verifyDescriptor(desc, cur4of4({ producerRunId: '777' })).code, 'DESC_PRODUCER_RUN_MISMATCH');
    assert.equal(verifyDescriptor(desc, cur4of4({ carrierType: 'rankings-satellite' })).code, 'DESC_CARRIER_MISMATCH');
    assert.equal(verifyDescriptor({ ...desc, producer_attempt: 0 }, cur4of4()).code, 'DESC_ATTEMPT_INVALID');
    assert.equal(verifyDescriptor(desc, { ...cur4of4(), runAttempt: '1' }).code, 'DESC_ATTEMPT_FUTURE');
    assert.equal(verifyDescriptor({ ...desc, head_sha: 'nope' }, cur4of4()).code, 'DESC_HEAD_SHA_INVALID');
    assert.equal(verifyDescriptor(desc, { ...cur4of4(), headSha: FOREIGN_HEAD }).code, 'DESC_HEAD_SHA_MISMATCH');
});

test('(S3e) exact staging-prefix derivation: fixed / mutable-latest / two-level prefixes are REFUSED', async () => {
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const desc = descFor(generateManifest(stage, ctx()));
    for (const bad of [
        'state/satellite-rankings/',                                  // the MUTABLE FIXED key
        `state/_handoff/rankings-db/${RUN_ID}/attempt-latest/`,        // mutable latest
        `state/_handoff/rankings-db/${RUN_ID}/`,                       // attempt stripped
        `state/_handoff/rankings-db/${RUN_ID}/9/attempt-${ATTEMPT}/`,  // two-level
    ]) {
        const r = verifyDescriptor({ ...desc, exact_staging_prefix: bad }, cur4of4());
        assert.equal(r.ok, false, `must refuse ${bad}`);
        assert.equal(r.code, 'DESC_PREFIX_MISMATCH');
    }
});

test('(S3f) cross-carrier family bind: rankings-db and cycle-output must share run + attempt + head', async () => {
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const rank = descFor(generateManifest(stage, ctx()));
    const sibling = { carrier_type: 'cycle-output-authority', finalize_run_id: RUN_ID, producer_attempt: Number(ATTEMPT), head_sha: HEAD };
    assert.equal(verifySiblingDescriptors(rank, sibling).ok, true);
    assert.equal(verifySiblingDescriptors(rank, { ...sibling, head_sha: FOREIGN_HEAD }).code, 'SIBLING_HEAD_SHA_MISMATCH');
    assert.equal(verifySiblingDescriptors(rank, { ...sibling, finalize_run_id: '777' }).code, 'SIBLING_RUN_MISMATCH');
    assert.equal(verifySiblingDescriptors(rank, { ...sibling, producer_attempt: 9 }).code, 'SIBLING_ATTEMPT_MISMATCH');
    assert.equal(verifySiblingDescriptors(rank, { ...sibling, head_sha: 'zz' }).code, 'SIBLING_HEAD_SHA_INVALID');
    assert.equal(verifySiblingDescriptors({ ...rank, carrier_type: 'rankings-satellite' }, sibling).code, 'SIBLING_CARRIER_MISMATCH');
});

// ==========================================================================
// S4 -- HASH / SQLITE / SCHEMA integrity
// ==========================================================================
test('(S4a) HASH_OR_SQLITE_FAIL = FAIL: a SAME-LENGTH byte tamper reds (a size-only check would pass it)', async () => {
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const manifest = generateManifest(stage, ctx());
    const target = path.join(stage, 'data', 'rankings-all.db');
    const before = fs.statSync(target).size;
    const buf = fs.readFileSync(target);
    buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff; // flip a byte in the trailing page
    fs.writeFileSync(target, buf);
    assert.equal(fs.statSync(target).size, before, 'size is UNCHANGED -- only the hash can catch this');
    assert.equal(verifyDirAgainstManifest(stage, manifest).code, 'HASH_MISMATCH');
    const s = verifyRankingsDbSet(path.join(stage, 'data'), fullOpts({ manifest, memberPrefix: 'data/' }));
    assert.equal(s.ok, false);
    assert.equal(s.code, 'HASH_MISMATCH');
});

test('(S4b) a non-SQLite payload of the SAME size = SQLITE_MAGIC_INVALID', async () => {
    const src = await realDbSet();
    const dest = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(src, 'data', n), path.join(dest, n));
    const target = path.join(dest, 'rankings-paper.db');
    fs.writeFileSync(target, Buffer.alloc(fs.statSync(target).size, 0x41));
    const r = verifyRankingsDbSet(dest, {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SQLITE_MAGIC_INVALID');
    // a zero-byte member is caught even earlier
    fs.writeFileSync(target, Buffer.alloc(0));
    assert.equal(verifyRankingsDbSet(dest, {}).code, 'DB_EMPTY');
});

test('(S4c) an internally CORRUPTED page (valid magic, valid size) is caught by PRAGMA quick_check / read', async () => {
    const src = await realDbSet(undefined);
    const dest = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(src, 'data', n), path.join(dest, n));
    const target = path.join(dest, 'rankings-tool.db');
    const buf = fs.readFileSync(target);
    assert.ok(buf.length > 4096, 'fixture must have more than one page');
    buf.fill(0xff, 4096, Math.min(buf.length, 4096 + 2048)); // shred page 2, keep header + size
    fs.writeFileSync(target, buf);
    assert.equal(fs.readFileSync(target).slice(0, 16).toString('latin1'), SQLITE_MAGIC, 'magic still intact');
    const r = verifyRankingsDbSet(dest, {});
    assert.equal(r.ok, false, 'a structurally corrupt DB must never verify');
    assert.ok(['SQLITE_QUICK_CHECK_FAILED', 'SQLITE_READ_FAILED', 'SQLITE_OPEN_FAILED', 'SCHEMA_TABLE_MISSING', 'SCHEMA_INDEX_MISSING', 'SCHEMA_COLUMN_MISMATCH', 'META_KEY_MISSING'].includes(r.code),
        `unexpected code ${r.code}: ${r.reason}`);
});

test('(S4d) schema assertion: a dropped index and a renamed column both red', async () => {
    const { default: Database } = await import('better-sqlite3');
    const src = await realDbSet();
    const dest = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(src, 'data', n), path.join(dest, n));
    const dropIdx = new Database(path.join(dest, 'rankings-all.db'));
    dropIdx.exec('DROP INDEX idx_ollama');
    dropIdx.close();
    let r = verifyRankingsDbSet(dest, {});
    assert.equal(r.code, 'SCHEMA_INDEX_MISSING');
    assert.match(r.reason, /idx_ollama/);
    const renameCol = new Database(path.join(dest, 'rankings-all.db'));
    renameCol.exec('CREATE INDEX idx_ollama ON entities(ollama_compatible)');
    renameCol.exec('ALTER TABLE entities RENAME COLUMN forks TO forkz');
    renameCol.close();
    r = verifyRankingsDbSet(dest, {});
    assert.equal(r.code, 'SCHEMA_COLUMN_MISMATCH');
});

test('(S4e) a manifest that omits (or over-declares) a rankings member reds -- never count-only', async () => {
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const manifest = generateManifest(stage, ctx());
    const short = { ...manifest, files: manifest.files.filter((f) => !f.relative_path.endsWith('rankings-all.db')) };
    const r = verifyRankingsDbSet(path.join(stage, 'data'), fullOpts({ manifest: short, memberPrefix: 'data/' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MANIFEST_MEMBER_COUNT_MISMATCH');
    assert.equal(manifestRankingsIndex(manifest, 'data/').size, RANKINGS_DB_COUNT);
    assert.equal(manifestRankingsIndex(null), null);
    // set_sha256 tamper + manifest self-hash framing
    assert.equal(verifyDirAgainstManifest(stage, { ...manifest, set_sha256: 'f'.repeat(64) }).code, 'SET_HASH_MISMATCH');
    assert.equal(verifyDirAgainstManifest(stage, { ...manifest, manifest_sha256: 'f'.repeat(64) }).code, 'MANIFEST_SELF_HASH');
    assert.equal(computeSetSha256(manifest.files), manifest.set_sha256);
});

// ==========================================================================
// S5 / S15 -- the any-one-file boolean shortcut is DEAD
// ==========================================================================
test('(S5) ANY_FILE_BOOLEAN_SHORTCUT = FAIL: ONE valid rankings DB can never satisfy the set', async () => {
    const src = await realDbSet();
    const dest = mkTmp();
    fs.copyFileSync(path.join(src, 'data', 'rankings-model.db'), path.join(dest, 'rankings-model.db'));
    // the OLD shortcut was `readdirSync(dir).some(f => f.startsWith('rankings-') && f.endsWith('.db'))`
    assert.equal(fs.readdirSync(dest).some((f) => f.startsWith('rankings-') && f.endsWith('.db')), true,
        'the OLD shortcut would have returned TRUE here');
    const r = verifyRankingsDbSet(dest, {});
    assert.equal(r.ok, false, 'the NEW complete-set verification must refuse it');
    assert.equal(r.code, 'RANKINGS_DB_SET_MISSING');
    assert.match(r.reason, /1\/10 present/);
});

test('(S15) ANY_ONE_DB_BOOLEAN_SHORTCUT = RED_ON_REVERT: pack-finalizer carries the throwing gate, not `.some()`', async () => {
    const srcText = fs.readFileSync(new URL('./lib/pack-finalizer.js', import.meta.url), 'utf8');
    // Match on EXECUTABLE lines only: the repaired file DOCUMENTS the removed shortcut in
    // a comment, so a raw whole-file grep would false-fire. Comment lines are stripped.
    const code = srcText.split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
    assert.ok(/assertRankingsDbSet\(shardDir, verifyOptsFromEnv\(\)\);/.test(code),
        'the THROWING complete-set gate must be the only thing that sets the flag');
    assert.ok(/partitionCounts\.rankings_dbs = true;/.test(code));
    assert.equal(/rankings_dbs\s*=\s*false/.test(code), false, 'the flag is NEVER written false');
    // the reverted shortcut shape must be absent from EXECUTABLE code in ANY form
    assert.equal(/\.some\(/.test(code), false,
        'reintroducing an any-one-file `.some()` shortcut must red this test');
    assert.equal(/rankings/.test(code.replace(/rankings-db-verifier|rankings_dbs/g, '')), false,
        'the ONLY executable rankings references are the verifier import and the flag assignment');
    assert.equal(/try\s*\{[^}]*rankings[^}]*\}\s*catch\s*\{\s*\}/.test(code), false,
        'the flag must not be computed inside a swallowing try/catch');
    // and behaviourally: 1 DB present => finalizePack throws
    const src = await realDbSet();
    const shardDir = mkTmp();
    fs.copyFileSync(path.join(src, 'data', 'rankings-all.db'), path.join(shardDir, 'rankings-all.db'));
    await assert.rejects(() => runFinalizePack(shardDir), RankingsDbVerifyError);
});

// ==========================================================================
// S6 -- COMPLETE SET => the manifest flag becomes true (a verification RESULT)
// ==========================================================================
test('(S6) COMPLETE_SET = MANIFEST_FLAG_TRUE: finalizePack writes partitions.rankings_dbs === true', async () => {
    const src = await realDbSet();
    const shardDir = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(src, 'data', n), path.join(shardDir, n));
    const counts = await runFinalizePack(shardDir, {}, {
        RANKINGS_EXPECT_RUN_ID: RUN_ID, RANKINGS_EXPECT_HEAD_SHA: HEAD, RANKINGS_MAX_ATTEMPT: ATTEMPT,
    });
    assert.equal(counts.rankings_dbs, true);
    assert.equal(typeof counts.rankings_dbs, 'boolean', 'the flag is a real boolean, never a truthy count');
    const written = JSON.parse(fs.readFileSync(path.join(shardDir, 'shards_manifest.json'), 'utf8'));
    assert.equal(written.partitions.rankings_dbs, true);
    assert.equal(verifyPublishedFlag(written).ok, true);
});

test('(S6b) finalizePack honours the env-supplied authority binding (manifest sha + foreign identity red)', async () => {
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const manifest = generateManifest(stage, ctx());
    const manifestPath = path.join(mkTmp(), 'rankings-db-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const shardDir = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(stage, 'data', n), path.join(shardDir, n));
    // env-bound success
    const ok = await runFinalizePack(shardDir, {}, {
        RANKINGS_DB_MANIFEST: manifestPath, RANKINGS_MEMBER_PREFIX: 'data/',
        RANKINGS_EXPECT_RUN_ID: RUN_ID, RANKINGS_EXPECT_HEAD_SHA: HEAD, RANKINGS_MAX_ATTEMPT: ATTEMPT,
    });
    assert.equal(ok.rankings_dbs, true);
    // a FOREIGN expected run id must throw even though the set is complete + intact
    const shardDir2 = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(stage, 'data', n), path.join(shardDir2, n));
    await assert.rejects(() => runFinalizePack(shardDir2, {}, {
        RANKINGS_DB_MANIFEST: manifestPath, RANKINGS_MEMBER_PREFIX: 'data/', RANKINGS_EXPECT_RUN_ID: '424242',
    }), (e) => e.code === 'IDENTITY_RUN_MISMATCH');
    assert.equal(fs.existsSync(path.join(shardDir2, 'shards_manifest.json')), false);
    assert.equal(verifyOptsFromEnv({ RANKINGS_MEMBER_PREFIX: 'data/' }).memberPrefix, 'data/');
});

test('(S6c) an ABSENT partitions.rankings_dbs key is NEVER a verified negative', () => {
    assert.equal(verifyPublishedFlag({ partitions: {} }).code, 'RANKINGS_FLAG_ABSENT');
    assert.equal(verifyPublishedFlag({ partitions: { rankings_dbs: false } }).code, 'RANKINGS_FLAG_NOT_TRUE');
    assert.equal(verifyPublishedFlag({ partitions: { rankings_dbs: 1 } }).code, 'RANKINGS_FLAG_NOT_TRUE');
    assert.equal(verifyPublishedFlag({ partitions: { rankings_dbs: 'true' } }).code, 'RANKINGS_FLAG_NOT_TRUE');
    assert.equal(verifyPublishedFlag({}).code, 'SHARDS_MANIFEST_NO_PARTITIONS');
    assert.equal(verifyPublishedFlag(null).code, 'SHARDS_MANIFEST_MALFORMED');
    assert.equal(verifyPublishedFlag({ partitions: { rankings_dbs: true } }).ok, true);
});

test('(S7b) exporter identity policy: missing/malformed identity env fails LOUD (never an empty identity in a DB)', () => {
    assert.throws(() => resolveRankingsIdentity({}), /RANKINGS_IDENTITY_ENV_INVALID/);
    assert.throws(() => resolveRankingsIdentity({ RANKINGS_RUN_ID: '1', RANKINGS_RUN_ATTEMPT: '0', RANKINGS_HEAD_SHA: HEAD }), /RANKINGS_RUN_ATTEMPT/);
    assert.throws(() => resolveRankingsIdentity({ RANKINGS_RUN_ID: '1', RANKINGS_RUN_ATTEMPT: '1', RANKINGS_HEAD_SHA: 'short' }), /RANKINGS_HEAD_SHA/);
    assert.deepEqual(resolveRankingsIdentity({ RANKINGS_RUN_ID: '5', RANKINGS_RUN_ATTEMPT: '3', RANKINGS_HEAD_SHA: HEAD.toUpperCase() }),
        { runId: '5', attempt: '3', headSha: HEAD });
});

// ==========================================================================
// S8 -- the mutable fixed key can never become the authority
// ==========================================================================
test('(S8) MUTABLE_FIXED_KEY_HAS_FOREIGN_DB = IGNORED, CANNOT_BECOME_AUTHORITY', async () => {
    const authority = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(authority, 'data'), path.join(stage, 'data'), { recursive: true });
    const manifest = generateManifest(stage, ctx());
    // A destination pre-poisoned with a FOREIGN-cycle DB (what the mutable fixed prefix
    // state/satellite-rankings/* could hand over: cross-cycle overwritable, identity-free).
    const foreign = await realDbSet({}, { runId: '111222333', headSha: FOREIGN_HEAD });
    const dest = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(foreign, 'data', n), path.join(dest, n));
    const poisoned = verifyRankingsDbSet(dest, fullOpts({ manifest, memberPrefix: 'data/' }));
    assert.equal(poisoned.ok, false, 'foreign content can never pass the authority manifest');
    assert.equal(poisoned.code, 'HASH_MISMATCH');
    // promotion wipes rankings-*.db then copies the verified set -> destination re-verifies
    for (const f of fs.readdirSync(dest)) if (/^rankings-.*\.db$/.test(f)) fs.rmSync(path.join(dest, f));
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(stage, 'data', n), path.join(dest, n));
    assert.equal(verifyRankingsDbSet(dest, fullOpts({ manifest, memberPrefix: 'data/' })).ok, true);
});

// ==========================================================================
// S9 -- no exact descriptor => fail at 3/4 finalize
// ==========================================================================
test('(S9) NO_EXACT_SEAM_A_DESCRIPTOR = FAIL_AT_3_OF_4_FINALIZE (nothing may be inferred)', () => {
    const cur = { carrierType: 'rankings-satellite', producerRunId: RUN_ID, runAttempt: ATTEMPT, headSha: HEAD };
    assert.equal(verifyDescriptor(null, cur).code, 'DESC_MALFORMED');
    assert.equal(verifyDescriptor({}, cur).code, 'DESC_FIELD_MISSING');
    const base = {
        schema_version: 1, carrier_type: 'rankings-satellite', producer_run_id: RUN_ID,
        producer_attempt: Number(ATTEMPT),
        exact_staging_prefix: `state/_handoff/rankings-satellite/${RUN_ID}/attempt-${ATTEMPT}/`,
        manifest_sha256: 'c'.repeat(64), set_sha256: 'd'.repeat(64), head_sha: HEAD, created_at: 'now',
    };
    assert.equal(verifyDescriptor(base, cur).ok, true);
    for (const k of Object.keys(base)) {
        if (k === 'schema_version') continue;
        const stripped = { ...base }; delete stripped[k];
        assert.equal(verifyDescriptor(stripped, cur).ok, false, `descriptor.${k} must be required`);
    }
    assert.equal(verifyDescriptor({ ...base, carrier_type: 'nope' }, cur).code, 'CARRIER_UNKNOWN');
    assert.equal(verifyDescriptor({ ...base, set_sha256: 'zz' }, cur).code, 'DESC_SET_SHA_INVALID');
    assert.equal(verifyDescriptor({ ...base, manifest_sha256: 'zz' }, cur).code, 'DESC_MANIFEST_SHA_INVALID');
});

// ==========================================================================
// S10 -- .db classification here vs the FROZEN cycle-output carrier
// ==========================================================================
test('(S10a) DB_FILE_INSIDE_CYCLE_OUTPUT: the NEW carrier CLASSIFIES and HASH-VERIFIES a .db member', async () => {
    assert.equal(classifyRankingsMember('data/rankings-all.db'), 'rankings_db');
    assert.equal(classifyRankingsMember('cache/rankings/all/p1.json.zst'), 'authoritative');
    assert.equal(classifyRankingsMember('cache/rankings/all/p1.json.zst.meta.json'), 'optional');
    assert.throws(() => classifyRankingsMember('data/stray.bin'), /UNCLASSIFIED_MEMBER/);
    assert.throws(() => classifyRankingsMember('cache/stray.bin'), /UNCLASSIFIED_MEMBER/);
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const members = listCarrierFiles(stage, carrierConfig('rankings-db'));
    assert.equal(members.length, RANKINGS_DB_COUNT);
    const manifest = generateManifest(stage, ctx());
    for (const f of manifest.files) {
        assert.match(f.relative_path, /^data\/rankings-[a-z-]+\.db$/);
        assert.equal(f.sha256, sha256(path.join(stage, f.relative_path)), 'every .db member is sha256-bound');
        assert.ok(f.size_bytes > 256, 'a .db member clears the uploader non-.zst floor');
    }
    assert.equal(checkExactDbSet(members).ok, true);
});

test('(S10b) the FROZEN cycle-output carrier still REFUSES a stray .db under output/cache/**', () => {
    const dir = mkTmp();
    const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
    write('cache/mesh/graph.json.zst', zst(24, 'g'));
    write('cache/search-core.json.zst', zst(24, 'c'));
    write('cache/category_stats.json.zst', zst(24, 't'));
    write('cache/knowledge/index.json.zst', zst(24, 'k'));
    write('cache/trending.json.zst', zst(24, 'r'));
    write('cache/rankings/all.json.zst', zst(24, 'a'));
    write('cache/search-manifest.json', '{"totalShards":3}');
    write('cache/fni-thresholds.json', '{"scorePercentiles":{"p50":1}}');
    write('cache/assertions/_summary.json', '{"assertions_empty_evidence":0}');
    const cycleCtx = { carrierType: 'cycle-output-authority', finalizeRunId: RUN_ID, upstreamRunId: 'U', producerAttempt: ATTEMPT, headSha: HEAD };
    assert.ok(generateCycleManifest(dir, cycleCtx).files.length > 0, 'the frozen carrier accepts its own set');
    write('cache/rankings-all.db', Buffer.alloc(4096, 0x42));
    assert.throws(() => generateCycleManifest(dir, cycleCtx), (e) => e.code === 'UNCLASSIFIED_MEMBER',
        'a .db under output/cache/** must still fail loud in the FROZEN carrier');
});

// ==========================================================================
// S11 -- the DB set cannot mask missing ranking JSON pages (SEAM_A)
// ==========================================================================
test('(S11) TEN_DBS_PRESENT_BUT_RANKING_JSON_MISSING = JSON_COMPLETENESS_FAILS', async () => {
    const satCtx = ctx({ carrierType: 'rankings-satellite' });
    // complete set (10 DBs + 10 page JSONs + category_stats) generates fine
    const good = addSatelliteCache(await realDbSet());
    const m = generateManifest(good, satCtx);
    assert.equal(m.required_file_classes.find((c) => c.name === 'rankings_db').count, RANKINGS_DB_COUNT);
    assert.equal(m.required_file_classes.find((c) => c.name === 'ranking_pages').count, RANKINGS_DB_COUNT);
    assert.equal(m.required_file_classes.find((c) => c.name === 'category_stats').count, 1);
    assert.equal(verifyDirAgainstManifest(good, m).ok, true);
    // the produce-time .meta.json sidecars are EXCLUDED members (regenerable accelerator)
    assert.equal(m.files.some((f) => f.relative_path.endsWith('.meta.json')), false);
    // 10 DBs but NO ranking page JSONs => below floor, even though the DB class is full
    const noJson = addSatelliteCache(await realDbSet(), { pages: false });
    assert.throws(() => generateManifest(noJson, satCtx), (e) => e.code === 'REQUIRED_CLASS_BELOW_FLOOR'
        && /ranking_pages/.test(e.message));
    // and a missing category_stats is equally fatal
    const noStats = addSatelliteCache(await realDbSet(), { categoryStats: false });
    assert.throws(() => generateManifest(noStats, satCtx), (e) => e.code === 'REQUIRED_CLASS_BELOW_FLOOR'
        && /category_stats/.test(e.message));
    // verify-side: deleting the page JSONs from a verified tree reds too
    const stripped = addSatelliteCache(await realDbSet());
    const sm = generateManifest(stripped, satCtx);
    fs.rmSync(path.join(stripped, 'cache', 'rankings'), { recursive: true, force: true });
    assert.equal(verifyDirAgainstManifest(stripped, sm).code, 'FILE_MISSING');
});

// ==========================================================================
// S12 / S13 -- group metadata + extras
// ==========================================================================
test('(S12) WRONG_GROUP_METADATA = FAIL: site_metadata.rankings_group must equal the filename group', async () => {
    const src = await realDbSet();
    const dest = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(src, 'data', n), path.join(dest, n));
    // swap two DBs' bytes => each file's internal group no longer matches its name
    const a = path.join(dest, 'rankings-model.db');
    const b = path.join(dest, 'rankings-paper.db');
    const ba = fs.readFileSync(a); const bb = fs.readFileSync(b);
    fs.writeFileSync(a, bb); fs.writeFileSync(b, ba);
    const r = verifyRankingsDbSet(dest, {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'GROUP_METADATA_MISMATCH');
    const one = verifyRankingsDbFile(a, 'model');
    assert.equal(one.ok, false);
    assert.equal(one.code, 'GROUP_METADATA_MISMATCH');
});

test('(S13) EXTRA_RANKINGS_DB = FAIL at generate, verify AND the DB check set (never count>=10)', async () => {
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const clean = generateManifest(stage, ctx());
    // an 11th rankings DB (e.g. a retired rankings-prompt.db from an older cycle)
    fs.copyFileSync(path.join(stage, 'data', 'rankings-all.db'), path.join(stage, 'data', 'rankings-prompt.db'));
    assert.equal(fs.readdirSync(path.join(stage, 'data')).length, RANKINGS_DB_COUNT + 1);
    assert.throws(() => generateManifest(stage, ctx()), (e) => e.code === 'RANKINGS_DB_SET_EXTRA' && /rankings-prompt\.db/.test(e.message));
    assert.equal(verifyDirAgainstManifest(stage, clean).code, 'FILE_EXTRA');
    const s = verifyRankingsDbSet(path.join(stage, 'data'), {});
    assert.equal(s.ok, false);
    assert.equal(s.code, 'RANKINGS_DB_SET_EXTRA');
    // and the smuggle-through-the-manifest direction is refused as well
    const smuggled = { ...clean, files: [...clean.files, { relative_path: 'data/rankings-prompt.db', size_bytes: 1, sha256: 'e'.repeat(64) }] };
    assert.equal(verifyDirAgainstManifest(stage, smuggled).code, 'RANKINGS_DB_SET_EXTRA');
});

// ==========================================================================
// H1-H4 -- REVIEW HARDENING ROUND
// ==========================================================================
test('(H1a) PROJECTION re-verify: an ORPHAN ranking page in an exclusive scope FAILS', async () => {
    const src = addSatelliteCache(await realDbSet());
    const satCtx = ctx({ carrierType: 'rankings-satellite' });
    const manifest = generateManifest(src, satCtx);
    // the freshly promoted projection verifies (every member present + byte-identical)
    const clean = verifyProjection(src, manifest);
    assert.equal(clean.ok, true, clean.reason);
    assert.equal(clean.member_count, manifest.files.length);
    assert.equal(clean.scope_count, 2);
    // plant a STALE page from a previous attempt (totalPages shrank): a MERGE promotion
    // would keep it and publish it unverified inside the cycle-output carrier.
    const orphan = path.join(src, 'cache', 'rankings', 'all', 'p40.json.zst');
    fs.writeFileSync(orphan, zst(40, 'orphan'));
    const r = verifyProjection(src, manifest);
    assert.equal(r.ok, false, 'an orphan inside an exclusive scope must FAIL');
    assert.equal(r.code, 'PROJECTION_ORPHAN_MEMBER');
    assert.match(r.reason, /p40\.json\.zst/);
    // and an EXTRA rankings DB in the other exclusive scope is caught the same way
    fs.rmSync(orphan);
    fs.copyFileSync(path.join(src, 'data', 'rankings-all.db'), path.join(src, 'data', 'rankings-prompt.db'));
    assert.equal(verifyProjection(src, manifest).code, 'PROJECTION_ORPHAN_MEMBER');
});

test('(H1b) PROJECTION re-verify covers the PAGE half, not only the DBs (missing/tampered page reds)', async () => {
    const satCtx = ctx({ carrierType: 'rankings-satellite' });
    const src = addSatelliteCache(await realDbSet());
    const manifest = generateManifest(src, satCtx);
    // a MISSING page member reds even though all 10 DBs are perfect
    const page = path.join(src, 'cache', 'rankings', 'tool', 'p1.json.zst');
    const saved = fs.readFileSync(page);
    fs.rmSync(page);
    let r = verifyProjection(src, manifest);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PROJECTION_MEMBER_MISSING');
    assert.match(r.reason, /cache\/rankings\/tool\/p1\.json\.zst/);
    // a SAME-LENGTH tampered page reds on sha256
    const tampered = Buffer.from(saved); tampered[tampered.length - 1] ^= 0xff;
    fs.writeFileSync(page, tampered);
    assert.equal(fs.statSync(page).size, saved.length);
    r = verifyProjection(src, manifest);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'HASH_MISMATCH');
    // a missing category_stats reds too
    fs.writeFileSync(page, saved);
    fs.rmSync(path.join(src, 'cache', 'category_stats.json.zst'));
    assert.equal(verifyProjection(src, manifest).code, 'PROJECTION_MEMBER_MISSING');
    // OUT-OF-SCOPE siblings are IGNORED: the live workspace legitimately holds more
    // (output/data also carries meta.db/bundles at 3/4; output/cache the whole tree).
    fs.writeFileSync(path.join(src, 'cache', 'category_stats.json.zst'), zst(64, 'cs'));
    fs.writeFileSync(path.join(src, 'data', 'meta.db'), Buffer.alloc(4096, 0x42));
    fs.mkdirSync(path.join(src, 'cache', 'mesh'), { recursive: true });
    fs.writeFileSync(path.join(src, 'cache', 'mesh', 'graph.json.zst'), zst(40, 'g'));
    assert.equal(verifyProjection(src, manifest).ok, true, 'non-scope siblings must not red the projection');
    // an UNCLASSIFIED member inside an exclusive scope is a STRUCTURED fail, not a throw
    fs.writeFileSync(path.join(src, 'cache', 'rankings', 'all', 'stray.bin'), Buffer.alloc(32, 1));
    const u = verifyProjection(src, manifest);
    assert.equal(u.ok, false);
    assert.equal(u.code, 'UNCLASSIFIED_MEMBER');
});

test('(H2) verifyOptsFromEnv: REQUIRE_IDENTITY makes an EMPTY expectation a LOUD failure', async () => {
    const { verifyOptsFromEnv: fromEnv } = await import('./lib/rankings-db-verifier.js');
    const full = { RANKINGS_EXPECT_RUN_ID: RUN_ID, RANKINGS_EXPECT_HEAD_SHA: HEAD, RANKINGS_MAX_ATTEMPT: ATTEMPT };
    // without the flag the OLD permissive shape is retained (used by non-workflow callers)
    assert.equal(fromEnv({}).expectRunId, '');
    // under the flag, EVERY empty identity expectation throws a DISTINCT code
    for (const k of ['RANKINGS_EXPECT_RUN_ID', 'RANKINGS_EXPECT_HEAD_SHA', 'RANKINGS_MAX_ATTEMPT']) {
        const env = { ...full, RANKINGS_REQUIRE_IDENTITY: '1' };
        delete env[k];
        assert.throws(() => fromEnv(env), (e) => e.code === 'IDENTITY_BINDING_REQUIRED_BUT_EMPTY' && e.message.includes(k),
            `an empty ${k} must never be silently accepted as "no expectation"`);
        // an explicitly EMPTY string is the real $GITHUB_OUTPUT failure mode, not just absent
        assert.throws(() => fromEnv({ ...full, [k]: '', RANKINGS_REQUIRE_IDENTITY: '1' }),
            (e) => e.code === 'IDENTITY_BINDING_REQUIRED_BUT_EMPTY');
    }
    // fully supplied => passes through, identity-bound
    const ok = fromEnv({ ...full, RANKINGS_REQUIRE_IDENTITY: '1' });
    assert.equal(ok.expectRunId, RUN_ID);
    assert.equal(ok.expectHeadSha, HEAD);
    assert.equal(ok.maxAttempt, ATTEMPT);
    // the flag does NOT require the manifest: producer pre-checks run before it exists
    assert.equal(ok.manifest, undefined);
});

test('(H2b) a REQUIRED-but-empty identity binding fails finalizePack (no structure-only publish)', async () => {
    const src = await realDbSet();
    const shardDir = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(src, 'data', n), path.join(shardDir, n));
    // a complete, intact, structurally perfect set + REQUIRE_IDENTITY but a lost
    // $GITHUB_OUTPUT (empty expectations) must THROW rather than pass structure-only.
    await assert.rejects(() => runFinalizePack(shardDir, {}, {
        RANKINGS_REQUIRE_IDENTITY: '1', RANKINGS_EXPECT_RUN_ID: '', RANKINGS_EXPECT_HEAD_SHA: '', RANKINGS_MAX_ATTEMPT: '',
    }), (e) => e.code === 'IDENTITY_BINDING_REQUIRED_BUT_EMPTY');
    assert.equal(fs.existsSync(path.join(shardDir, 'shards_manifest.json')), false);
});

test('(H3) CLI stdout contract: verify-descriptor emits exactly ONE tab line, diagnostics on stderr', async () => {
    const src = await realDbSet();
    const stage = mkTmp();
    fs.cpSync(path.join(src, 'data'), path.join(stage, 'data'), { recursive: true });
    const manifest = generateManifest(stage, ctx());
    const descPath = path.join(mkTmp(), 'handoff.json');
    fs.writeFileSync(descPath, JSON.stringify(descFor(manifest)));
    const MODP = new URL('./rankings-db-handoff-manifest.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const stdout = execFileSync(process.execPath, [MODP, 'verify-descriptor', descPath, '--carrier=rankings-db'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HANDOFF_PRODUCER_RUN_ID: RUN_ID, HANDOFF_RUN_ATTEMPT: '', HANDOFF_HEAD_SHA: '' },
    });
    // EXACTLY one line (a trailing newline only) -- the workflow `cut -f<n>` idiom and the
    // defensive `| tail -n1` both depend on this; an extra stdout line would corrupt a prefix.
    assert.equal(stdout.split('\n').filter((l) => l !== '').length, 1, `stdout must be one line, got ${JSON.stringify(stdout)}`);
    assert.equal(stdout.endsWith('\n'), true);
    // FIELD ORDER pinned exactly as every call site cuts it: 1=prefix 2=set_sha 3=head 4=attempt
    const fields = stdout.trim().split('\t');
    assert.equal(fields.length, 4);
    assert.equal(fields[0], `state/_handoff/rankings-db/${RUN_ID}/attempt-${ATTEMPT}/`);
    assert.equal(fields[1], manifest.set_sha256);
    assert.equal(fields[2], HEAD);
    assert.equal(fields[3], String(Number(ATTEMPT)));
    // the human diagnostic goes to STDERR, so it can never be cut as a field
    assert.equal(stdout.includes('[RANKINGS-DB-HANDOFF]'), false);
    // and EVERY rankings verify-descriptor CONSUMER uses the SAME defensive last-line idiom.
    // Scoped to the rankings carriers on purpose: pre-existing non-rankings consumers (e.g.
    // the vfs-derived handoff) legitimately still cut fields from a raw $OUT, so a blanket
    // repo-wide assertion would be a false positive rather than a real lock.
    const aggYml = fs.readFileSync(new URL('../../.github/workflows/factory-aggregate.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const uplYml = fs.readFileSync(new URL('../../.github/workflows/factory-upload.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const seen = {};
    for (const [name, yml] of [['aggregate', aggYml], ['upload', uplYml]]) {
        const lines = yml.split('\n');
        seen[name] = 0;
        lines.forEach((line, i) => {
            // a CONSUMER = a command substitution capturing rankings verify-descriptor stdout
            if (/^\s*#/.test(line)) return;
            if (!/OUT=\$\(/.test(line) || !/verify-descriptor/.test(line) || !/--carrier=rankings-(db|satellite)/.test(line)) return;
            seen[name] += 1;
            const win = lines.slice(i, i + 8);
            assert.ok(win.some((l) => /DESC_LINE=\$\(printf '%s' "\$OUT" \| tail -n1\)/.test(l)),
                `${name}:${i + 1} rankings verify-descriptor consumer must derive DESC_LINE via | tail -n1`);
            for (const l of win) {
                if (!/cut -f/.test(l) || /^\s*#/.test(l)) continue;
                assert.match(l, /DESC_LINE/,
                    `${name}:${i + 1} rankings field cut must read DESC_LINE, not raw multi-line $OUT: ${l.trim()}`);
            }
        });
    }
    // ENUMERATED, so a NEW consumer that skips the idiom cannot hide behind a passing loop.
    assert.deepEqual(seen, { aggregate: 1, upload: 2 },
        'expected exactly 1 rankings verify-descriptor consumer in aggregate (SEAM_A) and 2 in upload (SEAM_B promote + publication gate)');
});

test('(H4) sibling bind consults the FROZEN cycle-output key `finalize_run_id` (shape change must surface)', () => {
    const frozen = fs.readFileSync(new URL('./cycle-output-handoff-manifest.mjs', import.meta.url), 'utf8');
    // PIN the frozen carrier's CURRENT descriptor shape: it validates finalize_run_id and
    // has NO producer_run_id. If that ever changes, this reds instead of silently accepting.
    assert.match(frozen, /'carrier_type', 'finalize_run_id', 'producer_attempt'/,
        'the frozen cycle-output descriptor must still declare finalize_run_id as required');
    assert.equal(/'producer_run_id'/.test(frozen), false,
        'the frozen carrier must still NOT use producer_run_id (the `??` fallback order depends on it)');
    // and the producing workflow step must still WRITE that key
    const aggYml = fs.readFileSync(new URL('../../.github/workflows/factory-aggregate.yml', import.meta.url), 'utf8');
    assert.match(aggYml, /carrier_type:'cycle-output-authority',finalize_run_id:String\(process\.env\.HANDOFF_FINALIZE_RUN_ID\)/);
    // BEHAVIOURAL: the frozen SHAPE (finalize_run_id only) is the path actually consulted
    const rank = { carrier_type: 'rankings-db', producer_run_id: RUN_ID, producer_attempt: Number(ATTEMPT), head_sha: HEAD };
    const frozenShape = { carrier_type: 'cycle-output-authority', finalize_run_id: RUN_ID, producer_attempt: Number(ATTEMPT), head_sha: HEAD };
    const res = verifySiblingDescriptors(rank, frozenShape);
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.producer_run_id, RUN_ID, 'the run id must be recovered from finalize_run_id');
    // a sibling carrying NEITHER spelling is refused (never defaulted/inferred)
    const neither = { ...frozenShape }; delete neither.finalize_run_id;
    assert.equal(verifySiblingDescriptors(rank, neither).code, 'SIBLING_FIELD_MISSING');
    // a FOREIGN run id under the frozen spelling still reds (the fallback is not a bypass)
    assert.equal(verifySiblingDescriptors(rank, { ...frozenShape, finalize_run_id: '777' }).code, 'SIBLING_RUN_MISMATCH');
});

// ==========================================================================
// D1-D6 -- RANKINGS-PUBLICATION-SIBLING (D-395): shards_manifest.json
// ==========================================================================
/** A realistic shards_manifest.json (the shape pack-finalizer writes). */
function shardsManifest(over = {}) {
    return {
        build_id: 'build-abc',
        shards: { 'data/fused-shard-000.bin': 'a'.repeat(64) },
        partitions: { meta_shards: 96, rankings_dbs: true, total_entities: 551000, ...over },
    };
}
function writeSm(dir, obj, name = 'shards_manifest.json') {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
}

test('(D1) sibling accepts ONLY a manifest that parses AND declares rankings_dbs === true', () => {
    const dir = mkTmp();
    const good = writeSm(dir, shardsManifest());
    const r = inspectShardsManifest(good);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.sha256, sha256(good));
    assert.equal(r.size_bytes, fs.statSync(good).size);
    // ABSENT flag and `false` are BOTH refused -- the SAME contract D9b enforces
    const absent = writeSm(dir, { build_id: 'x', partitions: { meta_shards: 96 } }, 'sm-absent.json');
    assert.equal(inspectShardsManifest(absent).code, 'RANKINGS_FLAG_ABSENT');
    const isFalse = writeSm(dir, shardsManifest({ rankings_dbs: false }), 'sm-false.json');
    assert.equal(inspectShardsManifest(isFalse).code, 'RANKINGS_FLAG_NOT_TRUE');
    const truthy = writeSm(dir, shardsManifest({ rankings_dbs: 1 }), 'sm-one.json');
    assert.equal(inspectShardsManifest(truthy).code, 'RANKINGS_FLAG_NOT_TRUE');
});

test('(D2) sibling MISSING / EMPTY / UNPARSEABLE all red', () => {
    const dir = mkTmp();
    assert.equal(inspectShardsManifest(path.join(dir, 'nope.json')).code, 'SHARDS_MANIFEST_ABSENT');
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, Buffer.alloc(0));
    assert.equal(inspectShardsManifest(empty).code, 'SHARDS_MANIFEST_EMPTY');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{"partitions":{"rankings_dbs":true');   // truncated JSON
    assert.equal(inspectShardsManifest(bad).code, 'SHARDS_MANIFEST_UNPARSEABLE');
});

test('(D3) sibling TRUNCATED and SAME-LENGTH TAMPERED both red (size vs hash are distinct checks)', () => {
    const dir = mkTmp();
    const p = writeSm(dir, shardsManifest());
    const sha = sha256(p);
    const size = fs.statSync(p).size;
    assert.equal(verifyShardsManifestSibling(p, { sha256: sha, size }).ok, true);
    // TRUNCATED: still valid-looking prefix but shorter -> caught (parse or size)
    const body = fs.readFileSync(p);
    fs.writeFileSync(p, body.subarray(0, body.length - 12));
    const trunc = verifyShardsManifestSibling(p, { sha256: sha, size });
    assert.equal(trunc.ok, false);
    assert.ok(['SHARDS_MANIFEST_UNPARSEABLE', 'SHARDS_MANIFEST_SIZE_MISMATCH', 'SHARDS_MANIFEST_HASH_MISMATCH'].includes(trunc.code), trunc.code);
    // SAME-LENGTH TAMPER that stays valid JSON with the flag still true: ONLY the hash
    // can catch it. A size-only (or semantics-only) check would pass this.
    const tampered = shardsManifest();
    tampered.build_id = 'build-XYZ';                       // same length as 'build-abc'
    const p2 = writeSm(dir, tampered, 'sm-tamper.json');
    assert.equal(fs.statSync(p2).size, size, 'fixture must be the SAME length');
    assert.equal(inspectShardsManifest(p2).ok, true, 'still parses and flag is still true');
    const t = verifyShardsManifestSibling(p2, { sha256: sha, size });
    assert.equal(t.ok, false);
    assert.equal(t.code, 'SHARDS_MANIFEST_HASH_MISMATCH');
});

test('(D4) sibling HASH MISMATCH and SIZE MISMATCH are reported distinctly', () => {
    const dir = mkTmp();
    const p = writeSm(dir, shardsManifest());
    const sha = sha256(p);
    const size = fs.statSync(p).size;
    assert.equal(verifyShardsManifestSibling(p, { sha256: 'f'.repeat(64), size }).code, 'SHARDS_MANIFEST_HASH_MISMATCH');
    assert.equal(verifyShardsManifestSibling(p, { sha256: sha, size: size + 1 }).code, 'SHARDS_MANIFEST_SIZE_MISMATCH');
    // an UPPERCASE declared sha is normalised, not spuriously rejected
    assert.equal(verifyShardsManifestSibling(p, { sha256: sha.toUpperCase(), size }).ok, true);
});

test('(D5) descriptor MISSING EITHER new field reds (and malformed values red)', () => {
    const base = { shards_manifest_sha256: 'c'.repeat(64), shards_manifest_size: 4096 };
    assert.equal(verifyShardsManifestDescriptorFields(base).ok, true);
    for (const k of ['shards_manifest_sha256', 'shards_manifest_size']) {
        const stripped = { ...base }; delete stripped[k];
        const r = verifyShardsManifestDescriptorFields(stripped);
        assert.equal(r.ok, false, `descriptor.${k} must be required`);
        assert.equal(r.code, 'DESC_FIELD_MISSING');
        assert.match(r.reason, new RegExp(k));
        // an explicitly EMPTY value is the real lost-variable mode, not just absent
        assert.equal(verifyShardsManifestDescriptorFields({ ...base, [k]: '' }).code, 'DESC_FIELD_MISSING');
    }
    assert.equal(verifyShardsManifestDescriptorFields({ ...base, shards_manifest_sha256: 'nope' }).code, 'DESC_SHARDS_MANIFEST_SHA_INVALID');
    assert.equal(verifyShardsManifestDescriptorFields({ ...base, shards_manifest_size: 0 }).code, 'DESC_SHARDS_MANIFEST_SIZE_INVALID');
    assert.equal(verifyShardsManifestDescriptorFields({ ...base, shards_manifest_size: -4 }).code, 'DESC_SHARDS_MANIFEST_SIZE_INVALID');
    assert.equal(verifyShardsManifestDescriptorFields(null).code, 'DESC_MALFORMED');
});

test('(D7) descriptor binding is LOAD-BEARING: a well-formed but WRONG sha or size DIVERGES', () => {
    const dir = mkTmp();
    const p = writeSm(dir, shardsManifest());
    const sha = sha256(p);
    const size = fs.statSync(p).size;
    const good = { shards_manifest_sha256: sha, shards_manifest_size: size };
    // three-way agreement passes and RETURNS the DESCRIPTOR-parsed values
    const ok = verifyShardsManifestDescriptorFields(good, { sha256: sha, size });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.sha256, sha);
    assert.equal(ok.size_bytes, size);
    // (1) a valid-FORMAT but WRONG sha must DIVERGE (this is the counterexample the old
    // presence+syntax check accepted: 64-hex, so every syntactic gate passed)
    const wrongSha = 'd'.repeat(64);
    assert.notEqual(wrongSha, sha);
    const rs = verifyShardsManifestDescriptorFields({ ...good, shards_manifest_sha256: wrongSha }, { sha256: sha, size });
    assert.equal(rs.ok, false);
    assert.equal(rs.code, 'DESC_SHARDS_MANIFEST_SHA_DIVERGED');
    // the OLD contract (no expectation supplied) would have PASSED it -- proving the gap was real
    assert.equal(verifyShardsManifestDescriptorFields({ ...good, shards_manifest_sha256: wrongSha }).ok, true,
        'presence+syntax alone accepts a false identity -- exactly why the expectation is required');
    // (2) a valid POSITIVE but WRONG size must DIVERGE
    const rz = verifyShardsManifestDescriptorFields({ ...good, shards_manifest_size: size + 1 }, { sha256: sha, size });
    assert.equal(rz.ok, false);
    assert.equal(rz.code, 'DESC_SHARDS_MANIFEST_SIZE_DIVERGED');
    assert.equal(verifyShardsManifestDescriptorFields({ ...good, shards_manifest_size: size + 1 }).ok, true);
    // malformed still reports its OWN (distinct) codes, not a divergence
    assert.equal(verifyShardsManifestDescriptorFields({ ...good, shards_manifest_sha256: 'nope' }, { sha256: sha, size }).code, 'DESC_SHARDS_MANIFEST_SHA_INVALID');
    assert.equal(verifyShardsManifestDescriptorFields({ ...good, shards_manifest_size: 0 }, { sha256: sha, size }).code, 'DESC_SHARDS_MANIFEST_SIZE_INVALID');
    // case-insensitive on the sha, and an EMPTY expectation is "not supplied" at module level
    // (the workflow supplies a hard empty-guard of its own -- locked statically)
    assert.equal(verifyShardsManifestDescriptorFields(good, { sha256: sha.toUpperCase(), size }).ok, true);
});

test('(D8) THE COUNTEREXAMPLE: local file + durable sibling both perfect, descriptor lies => RED', () => {
    const dir = mkTmp();
    // the local file and the durable sibling are byte-identical and semantically valid
    const local = writeSm(dir, shardsManifest());
    const durable = path.join(dir, 'sibling-copy.json');
    fs.copyFileSync(local, durable);
    const localSha = sha256(local);
    const localSize = fs.statSync(local).size;
    assert.equal(inspectShardsManifest(local).ok, true);
    assert.equal(inspectShardsManifest(durable).ok, true);
    assert.equal(sha256(durable), localSha, 'sibling is byte-identical to the local file');
    // ...but the DESCRIPTOR declares a different, well-formed identity
    const lyingDescriptor = { shards_manifest_sha256: 'e'.repeat(64), shards_manifest_size: localSize + 512 };
    // STEP 1 of the corrected flow: the descriptor must be reconciled with the local values.
    const fields = verifyShardsManifestDescriptorFields(lyingDescriptor, { sha256: localSha, size: localSize });
    assert.equal(fields.ok, false, 'a lying descriptor must never reach the sibling verification');
    assert.equal(fields.code, 'DESC_SHARDS_MANIFEST_SHA_DIVERGED');
    // STEP 2 proof that the ENFORCED identity comes from the DESCRIPTOR, not the locals: if the
    // divergence gate were absent, the descriptor-parsed values would be used downstream and the
    // durable sibling would then FAIL its own verification -- so either way the cycle fails closed.
    const asIfTrusted = verifyShardsManifestDescriptorFields(lyingDescriptor);
    assert.equal(asIfTrusted.ok, true, 'syntax-only acceptance (the defect)');
    const sib = verifyShardsManifestSibling(durable, { sha256: asIfTrusted.sha256, size: asIfTrusted.size_bytes });
    assert.equal(sib.ok, false, 'the descriptor-parsed identity must not verify the real sibling');
    assert.equal(sib.code, 'SHARDS_MANIFEST_HASH_MISMATCH');
    // and the pre-fix behaviour that made it invisible: verifying with the LOCAL values passes,
    // which is precisely why the local values must NOT be the enforced identity.
    assert.equal(verifyShardsManifestSibling(durable, { sha256: localSha, size: localSize }).ok, true);
});

test('(D9) THREE-WAY AGREEMENT (local file == descriptor == durable sibling) => PASS end-to-end', () => {
    const dir = mkTmp();
    const local = writeSm(dir, shardsManifest());
    const localSha = sha256(local);
    const localSize = fs.statSync(local).size;
    // the durable read-back copy
    const durable = path.join(dir, 'rb.json');
    fs.copyFileSync(local, durable);
    // the descriptor, written FROM the local computation and read back
    const descriptor = { shards_manifest_sha256: localSha, shards_manifest_size: localSize };
    // (a)+(b) parse the identity out of the read-back descriptor + require agreement
    const parsed = verifyShardsManifestDescriptorFields(descriptor, { sha256: localSha, size: localSize });
    assert.equal(parsed.ok, true, parsed.reason);
    // (c) the durable sibling is verified with the DESCRIPTOR-PARSED values
    const sib = verifyShardsManifestSibling(durable, { sha256: parsed.sha256, size: parsed.size_bytes });
    assert.equal(sib.ok, true, sib.reason);
    // (d) the values handed to the consumers are the descriptor-parsed ones
    assert.equal(parsed.sha256, localSha);
    assert.equal(parsed.size_bytes, localSize);
    // and a consumer re-verifying its own local copy against them passes
    assert.equal(verifyShardsManifestSibling(local, { sha256: parsed.sha256, size: parsed.size_bytes }).ok, true);
});

test('(D6) FIX-4 RECOVERY END-TO-END: manifest + 10 DBs + run/attempt/head all consistent => PASS', async () => {
    // (a) producer side: a fresh pack tree -- 10 verified DBs + the manifest pack-finalizer wrote
    const src = await realDbSet();
    const producer = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(src, 'data', n), path.join(producer, n));
    const smPath = writeSm(producer, shardsManifest());
    const authoritySha = sha256(smPath);
    const authoritySize = fs.statSync(smPath).size;
    const stage = mkTmp();
    fs.cpSync(producer, path.join(stage, 'data'), { recursive: true, filter: (s) => !s.endsWith('shards_manifest.json') });
    const manifest = generateManifest(stage, ctx());
    const descriptor = { ...descFor(manifest), shards_manifest_sha256: authoritySha, shards_manifest_size: authoritySize };
    assert.equal(verifyShardsManifestDescriptorFields(descriptor).ok, true);

    // (b) simulate FIX-4: rm -rf output/data/ then restore ONLY the .db members.
    const outputData = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(stage, 'data', n), path.join(outputData, n));
    assert.equal(fs.existsSync(path.join(outputData, 'shards_manifest.json')), false,
        'FIX-4 restores .db/warm/term_index ONLY -- the manifest is genuinely gone');
    // the D9b gate would legitimately refuse here (that is the bug, not a gate defect)
    assert.equal(inspectShardsManifest(path.join(outputData, 'shards_manifest.json')).code, 'SHARDS_MANIFEST_ABSENT');

    // (c) sibling recovery from the exact attempt prefix, then RE-VERIFY
    fs.copyFileSync(smPath, path.join(outputData, 'shards_manifest.json'));
    const rec = verifyShardsManifestSibling(path.join(outputData, 'shards_manifest.json'),
        { sha256: descriptor.shards_manifest_sha256, size: descriptor.shards_manifest_size });
    assert.equal(rec.ok, true, rec.reason);

    // (d) the FULL post-recovery state is consistent: exact 10-set + integrity + ONE identity
    const dbs = verifyRankingsDbSet(outputData, fullOpts({ manifest, memberPrefix: 'data/' }));
    assert.equal(dbs.ok, true, dbs.reason);
    assert.deepEqual(dbs.identity, { runId: RUN_ID, attempt: Number(ATTEMPT), headSha: HEAD });
    // (e) and the D9b contract now passes on the recovered tree
    const flag = verifyPublishedFlag(JSON.parse(fs.readFileSync(path.join(outputData, 'shards_manifest.json'), 'utf8')));
    assert.equal(flag.ok, true);
});

// ==========================================================================
// S14 -- exact recovery then promotion is byte-identical
// ==========================================================================
test('(S14) EXACT_RECOVERY_THEN_PROMOTION = OUTPUT_DATA_HASH_IDENTICAL', async () => {
    const producer = await realDbSet();
    const producerStage = mkTmp();
    fs.cpSync(path.join(producer, 'data'), path.join(producerStage, 'data'), { recursive: true });
    const manifest = generateManifest(producerStage, ctx());
    // "restore-dir" the exact staging into a consumer-side /tmp stage
    const recovered = mkTmp();
    fs.cpSync(path.join(producerStage, 'data'), path.join(recovered, 'data'), { recursive: true });
    assert.equal(verifyDirAgainstManifest(recovered, manifest).set_sha256, manifest.set_sha256);
    // promote into output/data (COPY, no rename) and prove byte identity per member
    const outputData = mkTmp();
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(recovered, 'data', n), path.join(outputData, n));
    for (const f of manifest.files) {
        const base = f.relative_path.slice('data/'.length);
        assert.equal(sha256(path.join(outputData, base)), f.sha256, `${base} must be byte-identical to the authority`);
        assert.equal(fs.statSync(path.join(outputData, base)).size, f.size_bytes);
    }
    // the promoted tree recomputes the SAME set hash
    const promotedFiles = RANKINGS_DB_NAMES.map((n) => ({ relative_path: `data/${n}`, sha256: sha256(path.join(outputData, n)) }));
    assert.equal(computeSetSha256(promotedFiles), manifest.set_sha256);
    // idempotence: promoting twice changes nothing
    for (const n of RANKINGS_DB_NAMES) fs.copyFileSync(path.join(recovered, 'data', n), path.join(outputData, n));
    assert.equal(computeSetSha256(RANKINGS_DB_NAMES.map((n) => ({ relative_path: `data/${n}`, sha256: sha256(path.join(outputData, n)) }))), manifest.set_sha256);
    assert.equal(verifyRankingsDbSet(outputData, fullOpts({ manifest, memberPrefix: 'data/' })).ok, true);
});
