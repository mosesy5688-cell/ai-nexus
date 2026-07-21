#!/usr/bin/env node
/**
 * D-375 PRODUCER_OMIT_ZERO_RELATION_FRAME built-.node binding verifier.
 *
 * PROVES the alt-linker producer-omit actually crosses the NAPI boundary into Node
 * on the SAME built satellite-tasks-rust.node — Cargo build / a Rust #[test] alone is
 * NOT proof the shipped binary carries it. Where the built .node exists, it exercises
 * BOTH real FFI producer paths over a fixture with a zero-relation category (empty
 * tags) + a non-empty category (shared tags), and asserts:
 *   1. computeAltRelations(Buffer)          (legacy Buffer-input path)
 *   2. computeAltRelationsFromDir(dir, out)  (direct NXVF-shard path)
 * both OMIT the zero-relation payload frame (no empty-cat.json.zst in categoriesData)
 * yet keep it in the meta census at relation_count=0; the emitted real frame is a
 * valid zstd frame >= 16 bytes; and totalRelations == the summed non-empty relations.
 *
 * Exit codes: 0 = bound + verified; 1 = bound but a contract assertion FAILED;
 * 2 = the .node is absent (runnable anywhere — never a false failure).
 * Wired into rust-build.yml VERIFY job (Alt-Linker Omit NAPI Binding Gate).
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

const require = createRequire(import.meta.url);
const NODE_PATH = path.resolve(
    new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    '../../rust/satellite-tasks/satellite-tasks-rust.node'
);

function fail(msg) { console.error(`[ALT-OMIT VERIFY] FAIL: ${msg}`); process.exit(1); }
function absent(msg) { console.error(`[ALT-OMIT VERIFY] SKIP (exit 2): ${msg}`); process.exit(2); }

const ZSTD_MAGIC_LE = 0xFD2FB528;
const HEADER_SIZE = 29;
/** Build a minimal NXVF V4.1 shard (no AES; raw-JSON payloads). */
function buildShard(entries) {
    let body = Buffer.alloc(0);
    const table = [];
    for (const e of entries) {
        const off = HEADER_SIZE + body.length;
        table.push([off, e.payload.length]);
        body = Buffer.concat([body, e.payload]);
    }
    const otOffset = HEADER_SIZE + body.length;
    let checksum = 0;
    for (const [off, size] of table) { checksum = (checksum ^ off ^ size) >>> 0; }
    const head = Buffer.alloc(HEADER_SIZE);
    head.write('NXVF', 0, 'ascii');
    head.writeUInt32LE(otOffset >>> 0, 7);
    head.writeUInt32LE(entries.length >>> 0, 11);
    head.writeUInt32LE(checksum >>> 0, 15);
    const ot = Buffer.alloc(table.length * 8);
    table.forEach(([off, size], i) => { ot.writeUInt32LE(off >>> 0, i * 8); ot.writeUInt32LE(size >>> 0, i * 8 + 4); });
    return Buffer.concat([head, body, ot]);
}

// Fixture: 2 zero-relation entities (empty tags -> no Jaccard edges) in "empty-cat"
// + 2 identical-tag entities (Jaccard 1.0 -> relations) in "real-cat".
const ENTITIES = [
    { id: 'e1', primary_category: 'empty-cat', tags: [], fni_score: 1 },
    { id: 'e2', primary_category: 'empty-cat', tags: [], fni_score: 1 },
    { id: 'r1', primary_category: 'real-cat', tags: ['nlp', 'text'], fni_score: 1 },
    { id: 'r2', primary_category: 'real-cat', tags: ['nlp', 'text'], fni_score: 1 },
];

function zstdDecode(buf) {
    if (typeof zlib.zstdDecompressSync !== 'function') fail('zlib.zstdDecompressSync unavailable (need Node >= 22.15)');
    return zlib.zstdDecompressSync(buf);
}

/** Assert the omit contract on a real FFI result. napi maps snake_case struct fields
 *  to camelCase (categoriesData/compressedData/relationCount/metaData/totalRelations);
 *  the JSON INSIDE metaData keeps its serde snake_case (relation_count/entity_count). */
function assertOmit(result, label) {
    if (!result) fail(`${label}: result null/undefined`);
    const cd = result.categoriesData;
    if (!Array.isArray(cd)) fail(`${label}: categoriesData not an array`);
    const files = cd.map((c) => c.filename);
    if (files.includes('empty-cat.json.zst')) fail(`${label}: empty-cat frame must be OMITTED (got ${JSON.stringify(files)})`);
    const real = cd.find((c) => c.filename === 'real-cat.json.zst');
    if (!real) fail(`${label}: real-cat frame absent (got ${JSON.stringify(files)})`);
    const rbuf = Buffer.from(real.compressedData);
    if (rbuf.length < 16) fail(`${label}: real frame ${rbuf.length}B < 16B floor`);
    if (rbuf.readUInt32LE(0) !== ZSTD_MAGIC_LE) fail(`${label}: real frame lacks zstd magic`);

    const meta = JSON.parse(zstdDecode(Buffer.from(result.metaData)).toString('utf-8'));
    if (!Array.isArray(meta.categories)) fail(`${label}: meta.categories not an array`);
    const em = meta.categories.find((c) => c.category === 'empty-cat');
    if (!em) fail(`${label}: empty-cat absent from census (must remain)`);
    if (em.relation_count !== 0) fail(`${label}: empty-cat census relation_count ${em.relation_count} != 0`);
    if (em.entity_count !== 2) fail(`${label}: empty-cat census entity_count ${em.entity_count} != 2`);
    const rm = meta.categories.find((c) => c.category === 'real-cat');
    if (!rm || !(rm.relation_count > 0)) fail(`${label}: real-cat census missing or zero relations`);

    const summed = cd.reduce((s, c) => s + (c.relationCount || 0), 0);
    if (result.totalRelations !== summed) fail(`${label}: totalRelations ${result.totalRelations} != summed non-empty ${summed}`);
    if (!(result.totalRelations > 0)) fail(`${label}: totalRelations must be > 0`);
    console.log(`[ALT-OMIT VERIFY] ${label}: OMIT ok (empty frame absent, census kept, totalRelations=${result.totalRelations})`);
}

if (!fs.existsSync(NODE_PATH)) absent(`satellite-tasks-rust.node not built at ${NODE_PATH}`);

let mod;
try { mod = require(NODE_PATH); } catch (e) { fail(`require failed: ${e.message}`); }
if (typeof mod.computeAltRelations !== 'function') fail('computeAltRelations export missing');
if (typeof mod.computeAltRelationsFromDir !== 'function') fail('computeAltRelationsFromDir export missing');

// 1. Legacy Buffer-input path.
try {
    const res = mod.computeAltRelations(Buffer.from(JSON.stringify(ENTITIES)));
    assertOmit(res, 'computeAltRelations');
} catch (e) { fail(`computeAltRelations invocation error: ${e.message}`); }

// 2. Direct NXVF-shard path.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-omit-verify-'));
const shardDir = path.join(tmp, 'shards');
const outDir = path.join(tmp, 'out');
fs.mkdirSync(shardDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
    path.join(shardDir, 'part-000.bin'),
    buildShard(ENTITIES.map((e) => ({ payload: Buffer.from(JSON.stringify(e), 'utf-8') })))
);
try {
    const res = mod.computeAltRelationsFromDir(shardDir, outDir);
    assertOmit(res, 'computeAltRelationsFromDir');
    console.log('[ALT-OMIT VERIFY] PASS: both FFI producer paths omit the zero-relation frame + keep the census.');
    process.exit(0);
} catch (e) {
    fail(`computeAltRelationsFromDir invocation error: ${e.message}`);
} finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
