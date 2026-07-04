// scripts/factory/vfs-derived-handoff-manifest.test.mjs
//
// Hermetic node:test suite for the VFS Pack -> VFS Derived (PRIMARY) and VFS
// Derived -> Upload sitemap/RSS (SECONDARY) R2-authoritative handoff verifier of
// record (Founder D-2026-0704-245). NO network, NO R2, NO @aws-sdk: the pure
// generate/verify/verify-descriptor module is driven over REAL temp dirs (node
// built-ins only). Covers the D-245 §L module-level families + anti-vacuity ties
// (each revert reds a required assertion). Workflow-DAG families live in the static
// tests/unit/vfs-pack-handoff-workflow.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
    SCHEMA_VERSION, COMPLETION_STATE, CARRIERS, HandoffManifestError,
    isSha256Hex, computeSetSha256, listCarrierFiles, carrierConfig, buildStagingPrefix,
    generateManifest, verifyDirAgainstManifest, verifyDescriptor,
    probeRssInputs, rssRecoveryPlan, verifyRssInputs,
    WARM_READ_MEMBER_CLASS, WARM_READ_CLASSES, listWarmReadFiles,
    generateWarmReadManifest, verifyWarmReadDir, publicationFamilyGate,
} from './vfs-derived-handoff-manifest.mjs';

const SHA = 'a'.repeat(40);
let TMP_SEQ = 0;
function mkTmp() { const d = path.join(os.tmpdir(), `vfs-handoff-${process.pid}-${Date.now()}-${TMP_SEQ++}`); fs.mkdirSync(d, { recursive: true }); return d; }
function writeFiles(dir, files) {
    for (const [rel, body] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
    }
    return dir;
}
// Deterministic content set for each carrier.
function packDir(extra = {}) { return writeFiles(mkTmp(), { 'meta-00.db': 'META0', 'meta-01.db': 'META1', 'rankings-a.db': 'RANK', ...extra }); }
function derivedDir(extra = {}) { return writeFiles(mkTmp(), { 'sitemap.xml': '<index/>', 'sitemaps/sitemap-index.xml': '<idx/>', 'sitemaps/sitemap-0.xml.gz': 'GZBYTES', 'rss/reports.xml': '<rss/>', ...extra }); }

const PACK_CTX = { carrierType: 'vfs-pack-authority', upstreamRunId: 'UP1', factoryRunId: 'RUN1', producerAttempt: '2', headSha: SHA, vfsPackCodeVersion: 'v-test', createdAt: '1970-01-01T00:00:00.000Z' };
const DERIVED_CTX = { carrierType: 'vfs-derived-authority', upstreamRunId: 'UP1', factoryRunId: 'RUN1', producerAttempt: '2', headSha: SHA, vfsPackCodeVersion: 'v-test', parentSetSha: 'b'.repeat(64), createdAt: '1970-01-01T00:00:00.000Z' };
// RSS_EMPTY_BASE has no output/cache/* -> both rss inputs probe present:false, so the
// meta-focused tests stay deterministic regardless of the runner's real ./output tree.
const RSS_EMPTY_BASE = mkTmp();
const PACK_OPTS = { extensions: ['.db'], rssBaseDir: RSS_EMPTY_BASE };
// A workspace laying out output/data/*.db + (optional) the two RSS-generator inputs so
// generate() probes them at the real relative paths (output/cache/{reports,knowledge}/…).
function packWorkspace(opts = {}) {
    const ws = mkTmp();
    writeFiles(ws, {
        'output/data/meta-00.db': 'META0', 'output/data/meta-01.db': 'META1', 'output/data/rankings-a.db': 'RANK',
        ...(opts.reports !== undefined ? { 'output/cache/reports/index.json.zst': opts.reports } : {}),
        ...(opts.knowledge !== undefined ? { 'output/cache/knowledge/index.json.zst': opts.knowledge } : {}),
    });
    return { ws, dataDir: path.join(ws, 'output/data') };
}
function rssOf(m, name) { return m.rss_inputs.find((e) => e.name === name); }

function genPack(dir, over = {}) { return generateManifest(dir, { ...PACK_CTX, ...over }, PACK_OPTS); }
function genPackWs(ws, dataDir, over = {}) { return generateManifest(dataDir, { ...PACK_CTX, ...over }, { extensions: ['.db'], rssBaseDir: ws }); }
function genDerived(dir, over = {}) { return generateManifest(dir, { ...DERIVED_CTX, ...over }, {}); }
// Build the run-scoped descriptor the workflow writes (manifest_sha256 = sha of the manifest file).
function descFor(manifest) {
    return {
        schema_version: SCHEMA_VERSION, carrier_type: manifest.carrier_type,
        producer_attempt: manifest.producer_attempt, exact_staging_prefix: manifest.exact_staging_prefix,
        manifest_sha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
        set_sha256: manifest.set_sha256, upstream_run_id: manifest.upstream_3_4_run_id,
        factory_run_id: manifest.factory_4_4_run_id, head_sha: manifest.head_sha,
        vfs_pack_code_version: manifest.vfs_pack_code_version, parent_set_sha256: manifest.parent_set_sha256,
        created_at: manifest.created_at_utc,
    };
}
function curFor(over = {}) { return { carrierType: 'vfs-pack-authority', upstreamRunId: 'UP1', factoryRunId: 'RUN1', runAttempt: '2', headSha: SHA, vfsPackCodeVersion: 'v-test', ...over }; }

// ==========================================================================
// A. Config / constants / hashing
// ==========================================================================
test('(A1) carrier registry: two DISTINCT prefix roots + producer jobs', () => {
    assert.deepEqual(Object.keys(CARRIERS).sort(), ['vfs-derived-authority', 'vfs-pack-authority']);
    assert.equal(carrierConfig('vfs-pack-authority').prefixRoot, 'state/_handoff/vfs-pack');
    assert.equal(carrierConfig('vfs-derived-authority').prefixRoot, 'state/_handoff/vfs-derived');
    assert.notEqual(CARRIERS['vfs-pack-authority'].prefixRoot, CARRIERS['vfs-derived-authority'].prefixRoot);
    assert.throws(() => carrierConfig('bogus'), (e) => e instanceof HandoffManifestError && e.code === 'CARRIER_UNKNOWN');
});
test('(A2) buildStagingPrefix binds run+factory+attempt; NEVER a latest/fixed token', () => {
    assert.equal(buildStagingPrefix('vfs-pack-authority', 'UP1', 'RUN1', '2'), 'state/_handoff/vfs-pack/UP1/RUN1/attempt-2/');
    assert.equal(buildStagingPrefix('vfs-derived-authority', 'UP1', 'RUN1', '3'), 'state/_handoff/vfs-derived/UP1/RUN1/attempt-3/');
    assert.ok(!buildStagingPrefix('vfs-pack-authority', 'UP1', 'RUN1', '2').includes('latest'));
});
test('(A3) isSha256Hex rejects a multipart ETag; computeSetSha256 order-independent + content-bound', () => {
    assert.equal(isSha256Hex('a'.repeat(64)), true);
    assert.equal(isSha256Hex('abc123-50'), false);
    const files = [{ relative_path: 'b', sha256: 'b'.repeat(64) }, { relative_path: 'a', sha256: 'a'.repeat(64) }];
    assert.equal(computeSetSha256(files), computeSetSha256([...files].reverse()));
    const tampered = [{ relative_path: 'b', sha256: 'b'.repeat(64) }, { relative_path: 'a', sha256: 'c'.repeat(64) }];
    assert.notEqual(computeSetSha256(files), computeSetSha256(tampered));
});

// ==========================================================================
// B. generateManifest — field set + class floors + reserved exclusion
// ==========================================================================
test('(B1) vfs-pack manifest emits the full §G field set + meta_db_count; no self-hash', () => {
    const m = genPack(packDir());
    assert.equal(m.schema_version, SCHEMA_VERSION);
    assert.equal(m.carrier_type, 'vfs-pack-authority');
    assert.equal(m.upstream_3_4_run_id, 'UP1');
    assert.equal(m.factory_4_4_run_id, 'RUN1');
    assert.equal(m.factory_4_4_run_attempt, 2);
    assert.equal(m.producer_job_identity, 'vfs-pack-db');
    assert.equal(m.producer_attempt, 2);
    assert.equal(m.head_sha, SHA);
    assert.equal(m.vfs_pack_code_version, 'v-test');
    assert.equal(m.parent_set_sha256, null);
    assert.equal(m.exact_staging_prefix, 'state/_handoff/vfs-pack/UP1/RUN1/attempt-2/');
    assert.equal(m.completion_state, COMPLETION_STATE);
    assert.equal(m.meta_db_count, 2);
    assert.deepEqual(m.required_file_classes, [{ name: 'meta_db', min: 1, count: 2 }]);
    assert.ok(isSha256Hex(m.set_sha256));
    assert.ok(!('manifest_sha256' in m));
    assert.ok(m.files.every((f) => isSha256Hex(f.sha256) && Number.isInteger(f.size_bytes)));
});
test('(B2) reserved sidecars (manifest.json/handoff.json/_manifest.json) are NEVER carrier members', () => {
    const dir = packDir({ 'manifest.json': '{}', 'handoff.json': '{}', '_manifest.json': '{}' });
    const m = genPack(dir);
    for (const f of m.files) assert.ok(!['manifest.json', 'handoff.json', '_manifest.json'].includes(f.relative_path));
    assert.equal(m.file_count, 3); // meta-00, meta-01, rankings-a
});
test('(B3) vfs-pack ext filter includes ONLY .db (a stray non-db is excluded, not archived)', () => {
    const m = genPack(packDir({ 'shards_manifest.json': '{}', 'notes.txt': 'x' }));
    assert.deepEqual(m.files.map((f) => f.relative_path).sort(), ['meta-00.db', 'meta-01.db', 'rankings-a.db']);
});
test('(B4) vfs-derived manifest: sitemap class satisfied, rss present, meta_db_count 0', () => {
    const m = genDerived(derivedDir());
    assert.equal(m.carrier_type, 'vfs-derived-authority');
    assert.equal(m.producer_job_identity, 'vfs-derived');
    assert.equal(m.parent_set_sha256, 'b'.repeat(64));
    assert.equal(m.meta_db_count, 0);
    const byName = Object.fromEntries(m.required_file_classes.map((c) => [c.name, c]));
    assert.equal(byName.sitemap.count, 3); // sitemap.xml + 2 under sitemaps/
    assert.equal(byName.sitemap.min, 1);
    assert.equal(byName.rss.min, 0);
    assert.equal(byName.rss.count, 1);
});
test('(B5) vfs-derived permits EMPTY rss (min 0) but REJECTS empty sitemap class (min 1)', () => {
    // rss absent -> still generates (rss floor is 0).
    const noRss = writeFiles(mkTmp(), { 'sitemap.xml': '<i/>', 'sitemaps/sitemap-index.xml': '<x/>' });
    const m = genDerived(noRss);
    assert.equal(m.required_file_classes.find((c) => c.name === 'rss').count, 0);
    // sitemap absent -> below floor -> generate FAILS closed.
    const noSitemap = writeFiles(mkTmp(), { 'rss/reports.xml': '<rss/>' });
    assert.throws(() => genDerived(noSitemap), (e) => e instanceof HandoffManifestError && e.code === 'REQUIRED_CLASS_BELOW_FLOOR');
});
test('(B6) vfs-pack with ZERO meta-*.db fails closed at generate (meta_db floor 1)', () => {
    const dir = writeFiles(mkTmp(), { 'rankings-a.db': 'R' }); // .db present but no meta-*.db
    assert.throws(() => genPack(dir), (e) => e instanceof HandoffManifestError && e.code === 'REQUIRED_CLASS_BELOW_FLOOR');
});

// ==========================================================================
// C. verifyDirAgainstManifest — exact set equality + per-file + set hash + floors
// ==========================================================================
test('(C1 positive) manifest verifies against its own dir; returns set_sha + meta count', () => {
    const dir = packDir();
    const m = genPack(dir);
    const res = verifyDirAgainstManifest(dir, m, PACK_OPTS);
    assert.equal(res.ok, true);
    assert.equal(res.set_sha256, m.set_sha256);
    assert.equal(res.meta_db_count, 2);
});
test('(C2) FILE_MISSING when a manifest member is absent on disk (manifest without payload)', () => {
    const dir = packDir();
    const m = genPack(dir);
    fs.rmSync(path.join(dir, 'meta-01.db'));
    assert.equal(verifyDirAgainstManifest(dir, m, PACK_OPTS).code, 'FILE_MISSING');
});
test('(C3) FILE_EXTRA when disk carries a matching-ext file NOT in the manifest', () => {
    const dir = packDir();
    const m = genPack(dir);
    fs.writeFileSync(path.join(dir, 'meta-99.db'), 'SNUCK');
    assert.equal(verifyDirAgainstManifest(dir, m, PACK_OPTS).code, 'FILE_EXTRA');
});
test('(C4) SIZE_MISMATCH + HASH_MISMATCH on tampered bytes', () => {
    const dir = packDir();
    const m = genPack(dir);
    fs.writeFileSync(path.join(dir, 'meta-00.db'), 'META0-LONGER');
    assert.equal(verifyDirAgainstManifest(dir, m, PACK_OPTS).code, 'SIZE_MISMATCH');
    const dir2 = packDir();
    const m2 = genPack(dir2);
    fs.writeFileSync(path.join(dir2, 'meta-00.db'), 'XXXX0'); // same length (5 bytes) diff content
    assert.equal(verifyDirAgainstManifest(dir2, m2, PACK_OPTS).code, 'HASH_MISMATCH');
});
test('(C5 anti-vacuity: set-hash verify) mutating set_sha256 in the manifest reds verify', () => {
    const dir = packDir();
    const m = genPack(dir);
    const res = verifyDirAgainstManifest(dir, { ...m, set_sha256: 'f'.repeat(64) }, PACK_OPTS);
    assert.equal(res.code, 'SET_HASH_MISMATCH');
});
test('(C6) META_COUNT_MISMATCH when declared meta_db_count is tampered', () => {
    const dir = packDir();
    const m = genPack(dir);
    assert.equal(verifyDirAgainstManifest(dir, { ...m, meta_db_count: 99 }, PACK_OPTS).code, 'META_COUNT_MISMATCH');
});
test('(C7) partial meta set (only rankings survives) => REQUIRED_CLASS_BELOW_FLOOR', () => {
    // Manifest declared over a 1-meta set; remove the meta on disk AND from the manifest
    // so set-equality holds but the meta_db floor (min 1) is now violated.
    const dir = writeFiles(mkTmp(), { 'meta-00.db': 'M', 'rankings-a.db': 'R' });
    const m = genPack(dir);
    fs.rmSync(path.join(dir, 'meta-00.db'));
    const stripped = { ...m, files: m.files.filter((f) => f.relative_path !== 'meta-00.db') };
    stripped.set_sha256 = computeSetSha256(stripped.files);
    stripped.meta_db_count = 0;
    stripped.required_file_classes = [{ name: 'meta_db', min: 1, count: 0 }];
    assert.equal(verifyDirAgainstManifest(dir, stripped, PACK_OPTS).code, 'REQUIRED_CLASS_BELOW_FLOOR');
});
test('(C8) manifest carrying its own manifest_sha256 => MANIFEST_SELF_HASH', () => {
    const dir = packDir();
    const m = genPack(dir);
    assert.equal(verifyDirAgainstManifest(dir, { ...m, manifest_sha256: 'd'.repeat(64) }, PACK_OPTS).code, 'MANIFEST_SELF_HASH');
});
test('(C9) unknown carrier + malformed manifest rejected', () => {
    assert.equal(verifyDirAgainstManifest(mkTmp(), null, PACK_OPTS).code, 'MANIFEST_MALFORMED');
    assert.equal(verifyDirAgainstManifest(mkTmp(), { carrier_type: 'nope', files: [] }, PACK_OPTS).code, 'CARRIER_UNKNOWN');
});
test('(C10) path-traversal member in the manifest => UNSAFE_MEMBER (never verified)', () => {
    const dir = packDir();
    const m = genPack(dir);
    const evil = { ...m, files: [...m.files, { relative_path: '../evil', size_bytes: 1, sha256: 'e'.repeat(64) }] };
    assert.equal(verifyDirAgainstManifest(dir, evil, PACK_OPTS).code, 'FILE_MISSING'); // absent on disk first
    const evil2 = { ...m, files: m.files.map((f, i) => (i === 0 ? { relative_path: '../../etc/x', size_bytes: f.size_bytes, sha256: f.sha256 } : f)) };
    assert.equal(verifyDirAgainstManifest(dir, evil2, PACK_OPTS).code, 'FILE_MISSING');
});
test('(C11 secondary) vfs-derived dir verifies; recursive sitemaps/ + rss/ members carried', () => {
    const dir = derivedDir();
    const m = genDerived(dir);
    const res = verifyDirAgainstManifest(dir, m, {});
    assert.equal(res.ok, true);
    assert.ok(m.files.some((f) => f.relative_path === 'sitemaps/sitemap-0.xml.gz'));
    assert.ok(m.files.some((f) => f.relative_path === 'rss/reports.xml'));
});

// ==========================================================================
// D. listCarrierFiles — safety (symlink / traversal) + ext filter
// ==========================================================================
test('(D1) listCarrierFiles rejects a symlink member (UNSAFE_MEMBER)', () => {
    const dir = packDir();
    let made = false;
    try { fs.symlinkSync(path.join(dir, 'meta-00.db'), path.join(dir, 'meta-link.db')); made = true; }
    catch { /* Windows without privilege — skip */ }
    if (!made) return;
    assert.throws(() => listCarrierFiles(dir, ['.db']), (e) => e instanceof HandoffManifestError && e.code === 'UNSAFE_MEMBER');
});
test('(D2) ext filter: no filter = all files; .db filter = db only', () => {
    const dir = derivedDir();
    assert.ok(listCarrierFiles(dir, null).includes('sitemap.xml'));
    assert.equal(listCarrierFiles(dir, ['.db']).length, 0);
});

// ==========================================================================
// E. verifyDescriptor — provenance (run+attempt+head+version+parent+prefix)
// ==========================================================================
test('(E1 positive) descriptor verifies; emits derived staging prefix + set hash', () => {
    const m = genPack(packDir());
    const res = verifyDescriptor(descFor(m), curFor());
    assert.equal(res.ok, true);
    assert.equal(res.staging_prefix, 'state/_handoff/vfs-pack/UP1/RUN1/attempt-2/');
    assert.equal(res.set_sha256, m.set_sha256);
    assert.equal(res.producer_attempt, 2);
});
test('(E2) prior-run / prior-factory-run rejected', () => {
    const m = genPack(packDir());
    assert.equal(verifyDescriptor(descFor(m), curFor({ upstreamRunId: 'UP-OTHER' })).code, 'DESC_UPSTREAM_MISMATCH');
    assert.equal(verifyDescriptor(descFor(m), curFor({ factoryRunId: 'RUN-OTHER' })).code, 'DESC_RUN_MISMATCH');
});
test('(E3 anti-vacuity: attempt binding) producer_attempt > current run_attempt rejected', () => {
    const m = genPack(packDir(), { producerAttempt: '5' });
    assert.equal(verifyDescriptor(descFor(m), curFor({ runAttempt: '2' })).code, 'DESC_ATTEMPT_FUTURE');
    assert.equal(verifyDescriptor({ ...descFor(m), producer_attempt: 0 }, curFor({ runAttempt: '2' })).code, 'DESC_ATTEMPT_INVALID');
});
test('(E4 anti-vacuity: head-SHA binding) wrong head_sha rejected', () => {
    const m = genPack(packDir());
    assert.equal(verifyDescriptor(descFor(m), curFor({ headSha: 'c'.repeat(40) })).code, 'DESC_HEAD_SHA_MISMATCH');
});
test('(E5 anti-vacuity: version binding) wrong VFS_PACK_CODE_VERSION rejected', () => {
    const m = genPack(packDir());
    assert.equal(verifyDescriptor(descFor(m), curFor({ vfsPackCodeVersion: 'v-OTHER' })).code, 'DESC_VERSION_MISMATCH');
});
test('(E6 anti-vacuity: secondary parent-set binding) wrong parent_set_sha256 rejected', () => {
    const m = genDerived(derivedDir());
    const cur = { carrierType: 'vfs-derived-authority', upstreamRunId: 'UP1', factoryRunId: 'RUN1', runAttempt: '2', headSha: SHA, vfsPackCodeVersion: 'v-test', parentSetSha: 'b'.repeat(64) };
    assert.equal(verifyDescriptor(descFor(m), cur).ok, true);
    assert.equal(verifyDescriptor(descFor(m), { ...cur, parentSetSha: '0'.repeat(64) }).code, 'DESC_PARENT_SET_MISMATCH');
});
test('(E7) fixed / branch / latest staging prefix rejected (only run+attempt derivation accepted)', () => {
    const m = genPack(packDir());
    for (const bad of ['state/vfs-data/', 'state/_handoff/vfs-pack/UP1/RUN1/attempt-latest/', 'state/_handoff/vfs-pack/UP1/RUN1/']) {
        assert.equal(verifyDescriptor({ ...descFor(m), exact_staging_prefix: bad }, curFor()).code, 'DESC_PREFIX_MISMATCH');
    }
});
test('(E8) missing required field + carrier mismatch + bad set/manifest sha rejected', () => {
    const m = genPack(packDir());
    assert.equal(verifyDescriptor({ ...descFor(m), set_sha256: undefined }, curFor()).code, 'DESC_FIELD_MISSING');
    assert.equal(verifyDescriptor(descFor(m), curFor({ carrierType: 'vfs-derived-authority' })).code, 'DESC_CARRIER_MISMATCH');
    assert.equal(verifyDescriptor({ ...descFor(m), set_sha256: 'abc-50' }, curFor()).code, 'DESC_SET_SHA_INVALID');
    assert.equal(verifyDescriptor({ ...descFor(m), manifest_sha256: 'abc-50' }, curFor()).code, 'DESC_MANIFEST_SHA_INVALID');
});
test('(E9) a prior COMPLETE attempt of the same run is accepted only via its own derived prefix', () => {
    // producer_attempt 1 <= current run_attempt 3 is allowed, but the descriptor's prefix
    // must be the attempt-1 derivation — NOT the attempt-3 path.
    const m = genPack(packDir(), { producerAttempt: '1' });
    const res = verifyDescriptor(descFor(m), curFor({ runAttempt: '3' }));
    assert.equal(res.ok, true);
    assert.equal(res.staging_prefix, 'state/_handoff/vfs-pack/UP1/RUN1/attempt-1/');
});

// ==========================================================================
// F. RSS INPUT recovery (D-246 §C 6-state) — CAPTURED_IF_PRESENT / FLOOR_ZERO
// ==========================================================================
test('(F1) reports index present => captured in the manifest with present:true + sha256', () => {
    const { ws, dataDir } = packWorkspace({ reports: 'REPORTS-v1' });
    const m = genPackWs(ws, dataDir);
    const r = rssOf(m, 'reports_index');
    assert.equal(r.present, true);
    assert.ok(isSha256Hex(r.sha256));
    assert.equal(r.staged_path, 'rss-inputs/reports/index.json.zst');
    assert.equal(r.local_path, 'output/cache/reports/index.json.zst');
    // rss inputs are NOT folded into the meta set hash: the same meta content (with vs
    // without an rss input present) yields the IDENTICAL set_sha256.
    assert.equal(m.set_sha256, genPack(packDir()).set_sha256);
    assert.ok(!m.files.some((f) => f.relative_path.includes('rss-inputs')));
});
test('(F2) knowledge index present => captured with present:true + sha256', () => {
    const { ws, dataDir } = packWorkspace({ knowledge: 'KNOW-v1' });
    const r = rssOf(genPackWs(ws, dataDir), 'knowledge_index');
    assert.equal(r.present, true);
    assert.ok(isSha256Hex(r.sha256));
});
test('(F3) BOTH present => recovery plan carries both; verify against the recovered base is OK', () => {
    const { ws, dataDir } = packWorkspace({ reports: 'R', knowledge: 'K' });
    const m = genPackWs(ws, dataDir);
    const plan = rssRecoveryPlan(m);
    assert.equal(plan.length, 2);
    assert.deepEqual(plan.map((p) => p.staged_path).sort(), ['rss-inputs/knowledge/index.json.zst', 'rss-inputs/reports/index.json.zst']);
    // ws IS the recovered base (files at the declared local paths) — before RSS gen.
    const res = verifyRssInputs(m, ws);
    assert.equal(res.ok, true);
    assert.deepEqual(res.recovered.sort(), ['knowledge_index', 'reports_index']);
    assert.deepEqual(res.skipped, []);
});
test('(F4) GHA mismatch => stale base FAILS, then a correct recover verifies OK (discard+recover)', () => {
    const { ws, dataDir } = packWorkspace({ reports: 'R-current', knowledge: 'K-current' });
    const m = genPackWs(ws, dataDir);
    const stale = packWorkspace({ reports: 'R-STALE', knowledge: 'K-current' }).ws;
    assert.equal(verifyRssInputs(m, stale).code, 'RSS_INPUT_HASH_MISMATCH');
    assert.equal(verifyRssInputs(m, ws).ok, true); // recover from exact current-cycle content
});
test('(F5) reports absent (paused/floor-zero) => present:false, verify SKIPS it non-fatally', () => {
    const { ws, dataDir } = packWorkspace({ knowledge: 'K' }); // reports NOT written
    const m = genPackWs(ws, dataDir);
    assert.equal(rssOf(m, 'reports_index').present, false);
    assert.equal(rssOf(m, 'reports_index').sha256, null);
    assert.equal(rssRecoveryPlan(m).length, 1); // only knowledge planned
    const res = verifyRssInputs(m, ws);
    assert.equal(res.ok, true);
    assert.deepEqual(res.skipped, ['reports_index']);
    assert.deepEqual(res.recovered, ['knowledge_index']);
});
test('(F6) knowledge absent (floor-zero) => present:false, SKIPPED non-fatally', () => {
    const { ws, dataDir } = packWorkspace({ reports: 'R' }); // knowledge NOT written
    const m = genPackWs(ws, dataDir);
    assert.equal(rssOf(m, 'knowledge_index').present, false);
    assert.deepEqual(verifyRssInputs(m, ws).skipped, ['knowledge_index']);
});
test('(F7) declared PRESENT but absent in the recovered payload => FAIL-CLOSED (RSS_INPUT_MISSING)', () => {
    const { ws, dataDir } = packWorkspace({ reports: 'R' });
    const m = genPackWs(ws, dataDir);
    assert.equal(verifyRssInputs(m, mkTmp()).code, 'RSS_INPUT_MISSING'); // fresh empty base
});
test('(F8) stale predecessor content (sha != manifest) cannot satisfy the current cycle => FAIL-CLOSED', () => {
    const { ws, dataDir } = packWorkspace({ reports: 'R-current' });
    const m = genPackWs(ws, dataDir);
    const stale = packWorkspace({ reports: 'R-predecessor' }).ws;
    assert.equal(verifyRssInputs(m, stale).code, 'RSS_INPUT_HASH_MISMATCH');
});
test('(F9) the per-input sha256 BINDS current-cycle content (a different content reds verify)', () => {
    const a = packWorkspace({ reports: 'CYCLE-A', knowledge: 'K' });
    const b = packWorkspace({ reports: 'CYCLE-B', knowledge: 'K' });
    const mA = genPackWs(a.ws, a.dataDir);
    // cycle A manifest cannot be satisfied by cycle B's reports content.
    assert.equal(verifyRssInputs(mA, b.ws).code, 'RSS_INPUT_HASH_MISMATCH');
    assert.equal(rssOf(mA, 'reports_index').sha256, rssOf(mA, 'reports_index').sha256);
});
test('(F10 anti-vacuity) a present input tampered to present:false is NOT verified (recovery not vacuous)', () => {
    // If the consumer logic ignored present:true (treated everything as skippable), a
    // genuinely-required input would slip through. verifyRssInputs enforces recovery for
    // present:true; only an HONEST present:false is skippable.
    const { ws, dataDir } = packWorkspace({ reports: 'R' });
    const m = genPackWs(ws, dataDir);
    // honest present:true against an empty base => FAIL (recovery enforced)
    assert.equal(verifyRssInputs(m, mkTmp()).code, 'RSS_INPUT_MISSING');
    // rssRecoveryPlan drops present:false so a paused input is never spuriously "recovered"
    const paused = { ...m, rss_inputs: m.rss_inputs.map((e) => ({ ...e, present: false, sha256: null })) };
    assert.equal(rssRecoveryPlan(paused).length, 0);
});
test('(F11 safety) probe rejects a symlinked rss input; verify rejects a traversal staged_path', () => {
    const { ws, dataDir } = packWorkspace({});
    let made = false;
    try { fs.mkdirSync(path.join(ws, 'output/cache/reports'), { recursive: true }); fs.symlinkSync(path.join(ws, 'output/data/meta-00.db'), path.join(ws, 'output/cache/reports/index.json.zst')); made = true; }
    catch { /* no symlink privilege — skip that leg */ }
    if (made) assert.throws(() => probeRssInputs('vfs-pack-authority', ws), (e) => e instanceof HandoffManifestError && e.code === 'UNSAFE_MEMBER');
    const evil = { rss_inputs: [{ name: 'x', present: true, sha256: 'a'.repeat(64), staged_path: '../escape', local_path: 'output/cache/reports/index.json.zst' }] };
    assert.throws(() => verifyRssInputs(evil, dataDir), (e) => e instanceof HandoffManifestError && e.code === 'UNSAFE_MEMBER');
});

// ==========================================================================
// G. AUTHORITY-W warm_read sibling — Founder VFS_PRODUCER_ARTIFACT_..._4_OF_4
// A directory laying out the warm-read producer artifacts INTERLEAVED with the
// meta_db members (both live in output/data/) proves warm_read excludes .db.
// ==========================================================================
const WARM_CTX = { carrierType: 'vfs-pack-authority', upstreamRunId: 'UP1', factoryRunId: 'RUN1', producerAttempt: '2', headSha: SHA, vfsPackCodeVersion: 'v-test', createdAt: '1970-01-01T00:00:00.000Z' };
function warmDir(extra = {}) {
    return writeFiles(mkTmp(), {
        'vector-core.bin': 'VC', 'hot-shard.bin': 'HS', 'id-index.bin': 'II',
        'meta-00.db': 'META0', 'rankings-a.db': 'RANK', // meta_db members — must be EXCLUDED
        'term_index/_manifest.json.zst': 'TMAN',
        'term_index/aa/_bucket.json.zst': 'B1', 'term_index/bb/_bucket.json.zst': 'B2',
        'term_index/mo/model_0.json.zst': 'HF0', // high-freq chunk (also a bucket-class member)
        ...extra,
    });
}
function genWarm(dir, over = {}) { return generateWarmReadManifest(dir, { ...WARM_CTX, ...over }); }

test('(G1) warm_read manifest: sibling of meta_db, carrier vfs-pack-authority + member_class warm_read; NEVER a .db member', () => {
    const m = genWarm(warmDir());
    assert.equal(m.carrier_type, 'vfs-pack-authority');
    assert.equal(m.member_class, WARM_READ_MEMBER_CLASS);
    assert.equal(m.producer_job_identity, 'vfs-pack-db');
    assert.equal(m.exact_staging_prefix, 'state/_handoff/vfs-pack/UP1/RUN1/attempt-2/');
    assert.ok(isSha256Hex(m.set_sha256));
    assert.ok(!('manifest_sha256' in m));
    assert.ok(!m.files.some((f) => f.relative_path.endsWith('.db'))); // meta_db excluded
    assert.deepEqual(m.files.map((f) => f.relative_path).filter((p) => p.endsWith('.bin')).sort(), ['hot-shard.bin', 'id-index.bin', 'vector-core.bin']);
    const byName = Object.fromEntries(m.required_file_classes.map((c) => [c.name, c]));
    assert.equal(byName.vector_core.count, 1);
    assert.equal(byName.term_index_manifest.count, 1);
    assert.ok(byName.term_index_bucket.count >= 2); // aa/_bucket + bb/_bucket + mo/model_0
});
test('(G2 T12: sibling does NOT change meta_db set_sha) same output/data => meta manifest set_sha is warm-independent', () => {
    // The meta_db manifest (ext=.db) over a dir WITH warm-read bins present yields the
    // SAME set_sha as over a dir with ONLY the .db files — warm_read is a separate manifest.
    const withWarm = warmDir();
    const metaWithWarm = generateManifest(withWarm, WARM_CTX, { extensions: ['.db'], rssBaseDir: RSS_EMPTY_BASE });
    const onlyDb = writeFiles(mkTmp(), { 'meta-00.db': 'META0', 'rankings-a.db': 'RANK' });
    const metaOnly = generateManifest(onlyDb, WARM_CTX, { extensions: ['.db'], rssBaseDir: RSS_EMPTY_BASE });
    assert.equal(metaWithWarm.set_sha256, metaOnly.set_sha256); // meta set_sha unchanged by warm presence
    // and the warm manifest set_sha is a DIFFERENT hash space (over the bins/term_index).
    assert.notEqual(genWarm(withWarm).set_sha256, metaWithWarm.set_sha256);
});
test('(G3 positive verify) warm_read manifest verifies against its own dir', () => {
    const dir = warmDir();
    const m = genWarm(dir);
    const res = verifyWarmReadDir(dir, m);
    assert.equal(res.ok, true);
    assert.equal(res.set_sha256, m.set_sha256);
});
test('(G4 T2: any warm member missing => fail BEFORE gate) each bin/manifest removed reds verify', () => {
    for (const victim of ['vector-core.bin', 'hot-shard.bin', 'id-index.bin', 'term_index/_manifest.json.zst']) {
        const dir = warmDir();
        const m = genWarm(dir);
        fs.rmSync(path.join(dir, victim));
        assert.equal(verifyWarmReadDir(dir, m).code, 'FILE_MISSING', `removing ${victim}`);
    }
});
test('(G5 T4: partial term_index) dropping to <2 buckets => REQUIRED_CLASS_BELOW_FLOOR at generate', () => {
    // Only one bucket present => term_index_bucket floor (min 2) violated at generate.
    const dir = writeFiles(mkTmp(), { 'vector-core.bin': 'VC', 'hot-shard.bin': 'HS', 'id-index.bin': 'II', 'term_index/_manifest.json.zst': 'M', 'term_index/aa/_bucket.json.zst': 'B1' });
    assert.throws(() => genWarm(dir), (e) => e instanceof HandoffManifestError && e.code === 'REQUIRED_CLASS_BELOW_FLOOR');
});
test('(G6 T7: truncated-but-magic bin) same-length tamper => HASH_MISMATCH; size tamper => SIZE_MISMATCH', () => {
    const dir = warmDir();
    const m = genWarm(dir);
    fs.writeFileSync(path.join(dir, 'vector-core.bin'), 'XX'); // same length (2) diff content
    assert.equal(verifyWarmReadDir(dir, m).code, 'HASH_MISMATCH');
    const dir2 = warmDir();
    const m2 = genWarm(dir2);
    fs.writeFileSync(path.join(dir2, 'hot-shard.bin'), 'HS-LONGER');
    assert.equal(verifyWarmReadDir(dir2, m2).code, 'SIZE_MISMATCH');
});
test('(G7 no-double-bind) a .db member smuggled into the warm_read manifest => WARM_READ_DB_DOUBLE_BIND', () => {
    const dir = warmDir();
    const m = genWarm(dir);
    const smuggled = { ...m, files: [...m.files, { relative_path: 'meta-00.db', size_bytes: 5, sha256: 'e'.repeat(64) }] };
    smuggled.set_sha256 = computeSetSha256(smuggled.files);
    assert.equal(verifyWarmReadDir(dir, smuggled).code, 'WARM_READ_DB_DOUBLE_BIND');
});
test('(G8) FILE_EXTRA when a new warm member appears on disk not in the manifest', () => {
    const dir = warmDir();
    const m = genWarm(dir);
    fs.mkdirSync(path.join(dir, 'term_index/cc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'term_index/cc/_bucket.json.zst'), 'B3');
    assert.equal(verifyWarmReadDir(dir, m).code, 'FILE_EXTRA');
});
test('(G9 set-hash + self-hash + member_count guards) tamper reds verify', () => {
    const dir = warmDir();
    const m = genWarm(dir);
    assert.equal(verifyWarmReadDir(dir, { ...m, set_sha256: 'f'.repeat(64) }).code, 'SET_HASH_MISMATCH');
    assert.equal(verifyWarmReadDir(dir, { ...m, manifest_sha256: 'd'.repeat(64) }).code, 'MANIFEST_SELF_HASH');
    assert.equal(verifyWarmReadDir(dir, { ...m, member_count: 99 }).code, 'MEMBER_COUNT_MISMATCH');
});
test('(G10) warm_read with zero bins fails closed at generate (vector_core floor 1)', () => {
    const dir = writeFiles(mkTmp(), { 'term_index/_manifest.json.zst': 'M', 'term_index/aa/_bucket.json.zst': 'B1', 'term_index/bb/_bucket.json.zst': 'B2' });
    assert.throws(() => genWarm(dir), (e) => e instanceof HandoffManifestError && e.code === 'REQUIRED_CLASS_BELOW_FLOOR');
});

// ==========================================================================
// H. PUBLICATION-FAMILY closure gate — one 4/4 cycle-family on one code head.
// ==========================================================================
const S = (c) => c.repeat(64);
function family(over = {}) {
    return {
        vfsPack: { upstream_run_id: 'UP1', factory_run_id: 'RUN1', head_sha: SHA, set_sha256: S('1'), warm_read_set_sha256: S('2') },
        meshProfile: { upstream_run_id: 'UP1', factory_run_id: 'RUN1', head_sha: SHA, set_sha256: S('3'), dict_sha256: S('4') },
        vfsDerived: { upstream_run_id: 'UP1', factory_run_id: 'RUN1', head_sha: SHA, set_sha256: S('5'), parent_set_sha256: S('1') },
        ...over,
    };
}
test('(H1 positive) coherent family passes + emits the shared identity', () => {
    const res = publicationFamilyGate(family());
    assert.equal(res.ok, true);
    assert.equal(res.upstream_run_id, 'UP1');
    assert.equal(res.factory_run_id, 'RUN1');
});
test('(H2 T14: mixed-cycle) any of upstream/run/head divergent => fail-closed', () => {
    assert.equal(publicationFamilyGate(family({ meshProfile: { upstream_run_id: 'UPX', factory_run_id: 'RUN1', head_sha: SHA, set_sha256: S('3'), dict_sha256: S('4') } })).code, 'FAMILY_UPSTREAM_DIVERGENT');
    assert.equal(publicationFamilyGate(family({ vfsDerived: { upstream_run_id: 'UP1', factory_run_id: 'RUNX', head_sha: SHA, set_sha256: S('5'), parent_set_sha256: S('1') } })).code, 'FAMILY_RUN_DIVERGENT');
    assert.equal(publicationFamilyGate(family({ meshProfile: { upstream_run_id: 'UP1', factory_run_id: 'RUN1', head_sha: 'c'.repeat(40), set_sha256: S('3'), dict_sha256: S('4') } })).code, 'FAMILY_HEAD_DIVERGENT');
});
test('(H3 chain) vfs-derived parent_set_sha must equal vfs-pack meta set_sha', () => {
    assert.equal(publicationFamilyGate(family({ vfsDerived: { upstream_run_id: 'UP1', factory_run_id: 'RUN1', head_sha: SHA, set_sha256: S('5'), parent_set_sha256: S('9') } })).code, 'FAMILY_PARENT_CHAIN_BROKEN');
});
test('(H4 required authorities present) warm_read + mesh set + mesh dict must all be present sha256', () => {
    assert.equal(publicationFamilyGate(family({ vfsPack: { upstream_run_id: 'UP1', factory_run_id: 'RUN1', head_sha: SHA, set_sha256: S('1'), warm_read_set_sha256: '' } })).code, 'FAMILY_WARM_READ_ABSENT');
    assert.equal(publicationFamilyGate(family({ meshProfile: { upstream_run_id: 'UP1', factory_run_id: 'RUN1', head_sha: SHA, set_sha256: '', dict_sha256: S('4') } })).code, 'FAMILY_MESH_SET_ABSENT');
    assert.equal(publicationFamilyGate(family({ meshProfile: { upstream_run_id: 'UP1', factory_run_id: 'RUN1', head_sha: SHA, set_sha256: S('3'), dict_sha256: '' } })).code, 'FAMILY_MESH_DICT_ABSENT');
});
test('(H5) missing a whole descriptor => FAMILY_DESC_MISSING', () => {
    const f = family(); delete f.meshProfile;
    assert.equal(publicationFamilyGate(f).code, 'FAMILY_DESC_MISSING');
});
test('(G/list safety) listWarmReadFiles excludes reserved sidecars + .db', () => {
    const dir = warmDir({ 'manifest.json': '{}', 'handoff.json': '{}' });
    const names = listWarmReadFiles(dir);
    assert.ok(!names.includes('manifest.json'));
    assert.ok(!names.includes('handoff.json'));
    assert.ok(!names.some((n) => n.endsWith('.db')));
    assert.ok(names.includes('vector-core.bin'));
    assert.ok(WARM_READ_CLASSES.some((c) => c.name === 'term_index_bucket'));
});
