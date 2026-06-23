#!/usr/bin/env node
/**
 * W3-O1 (Founder D-90 point 10) built-.node binding verifier.
 *
 * PROVES the per-drop parse-accounting actually crosses the NAPI boundary into
 * Node — Cargo build alone is NOT proof. Where the built
 * `stream-aggregator-rust.node` exists, it:
 *   1. asserts the protocol export `PARSE_ACCOUNTING_PROTOCOL === 1`;
 *   2. crafts a MINIMAL NXVF shard with exactly ONE offset-boundary drop +
 *      one good entity, runs the REAL `fuseShard`, and asserts
 *      `parseAccounting.protocolVersion === 1`, a `dropRecords` array exists,
 *      and `dropRecords.length === droppedEntityCount === 1`.
 *
 * Exit codes: 0 = bound + verified; 1 = bound but a contract assertion FAILED;
 * 2 = the .node is absent (runnable anywhere — never a false failure).
 * NOT wired into any workflow — run manually post-native-build.
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const NODE_PATH = path.resolve(
    new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    '../../rust/stream-aggregator/stream-aggregator-rust.node'
);

function fail(msg) { console.error(`[W3-O1 VERIFY] FAIL: ${msg}`); process.exit(1); }
function absent(msg) { console.error(`[W3-O1 VERIFY] SKIP (exit 2): ${msg}`); process.exit(2); }

const HEADER_SIZE = 29;
/** Build a minimal NXVF V4.1 shard (no AES; raw-JSON payloads). */
function buildShard(entries) {
    let body = Buffer.alloc(0);
    const table = [];
    for (const e of entries) {
        if (e.override) { table.push(e.override); }
        else {
            const off = HEADER_SIZE + body.length;
            table.push([off, e.payload.length]);
            body = Buffer.concat([body, e.payload]);
        }
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

if (!fs.existsSync(NODE_PATH)) absent(`stream-aggregator-rust.node not built at ${NODE_PATH}`);

let mod;
try { mod = require(NODE_PATH); } catch (e) { fail(`require failed: ${e.message}`); }

// 1. Protocol export.
if (mod.PARSE_ACCOUNTING_PROTOCOL !== 1) {
    fail(`PARSE_ACCOUNTING_PROTOCOL !== 1 (got ${JSON.stringify(mod.PARSE_ACCOUNTING_PROTOCOL)})`);
}
if (typeof mod.fuseShard !== 'function') fail('fuseShard export missing');

// 2. REAL fuse_shard on a crafted shard with one offset-boundary drop.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w3o1-verify-'));
const shardPath = path.join(tmp, 'part-000.bin');
const outPath = path.join(tmp, 'out.json.zst');
const shard = buildShard([
    { payload: Buffer.from('{"id":"a","fni_score":1.0}', 'utf-8') },
    { override: [9_000_000, 16] }, // offset past EOF -> offset-boundary drop
]);
fs.writeFileSync(shardPath, shard);

try {
    const res = mod.fuseShard(shardPath, JSON.stringify(['a']), '', '', outPath);
    const acc = res && res.parseAccounting;
    if (!acc) fail('result.parseAccounting missing');
    if (acc.protocolVersion !== 1) fail(`parseAccounting.protocolVersion !== 1 (got ${acc.protocolVersion})`);
    if (!Array.isArray(acc.dropRecords)) fail('parseAccounting.dropRecords is not an array');
    if (acc.droppedEntityCount !== 1) fail(`droppedEntityCount !== 1 (got ${acc.droppedEntityCount})`);
    if (acc.dropRecords.length !== acc.droppedEntityCount) {
        fail(`dropRecords.length (${acc.dropRecords.length}) !== droppedEntityCount (${acc.droppedEntityCount})`);
    }
    const rec = acc.dropRecords[0];
    if (rec.errorClass !== 'offset_boundary') fail(`errorClass != offset_boundary (got ${rec.errorClass})`);
    if (rec.payloadFingerprint !== null) fail('offset-boundary record must have null payloadFingerprint');
    if (rec.fingerprintStatus !== 'unavailable_no_payload') fail(`fingerprintStatus wrong (got ${rec.fingerprintStatus})`);
    if (acc.declaredEntityCount !== acc.parsedEntityCount + acc.droppedEntityCount) {
        fail('conservation broken: declared != parsed + dropped');
    }
    console.log('[W3-O1 VERIFY] PASS: protocol=1, real fuse_shard carried 1 drop record across NAPI (conserved).');
    process.exit(0);
} catch (e) {
    fail(`fuse_shard invocation error: ${e.message}`);
} finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
