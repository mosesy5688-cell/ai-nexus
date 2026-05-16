#!/usr/bin/env node
/**
 * Shard-Meta Consistency Verifier (V27.2 fail-loud gate)
 *
 * Pre-upload defense gate: meta-NN.db and fused-shard-NNN.bin are written
 * in the same pack-db.js loop and MUST be deterministic products of the
 * same build. If they disagree, the chain has a write-side bug and bad
 * state must not reach R2.
 *
 * What this checks:
 *   1. Each fused-shard-NNN.bin is internally consistent (NXVF V4.1 header
 *      matches file size: offsetTableOffset + entityCount * 8 == fileSize).
 *   2. Each meta-NN.db row with bundle_key='data/fused-shard-NNN.bin' has
 *      (bundle_offset, bundle_size) present in that shard's offset table.
 *
 * Bad-row diagnostic to separate root-cause hypotheses:
 *   - kind=overflow: bundle_offset + bundle_size > shard fileSize.
 *   - kind=offset-not-in-table: (offset, size) is not in the shard's
 *     offset table at all.
 *   - realLocation field tells whether the same (offset, size) appears in
 *     a DIFFERENT shard's offset table (=> meta-DB and ShardWriter
 *     disagreed mid-loop), or in NO shard (=> meta row was inserted but
 *     writeEntity was never called for it).
 *
 * Exit codes:
 *   0 = all rows reference valid (offset, size) pairs in their shard
 *   1 = at least one inconsistency found (build halted)
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const SHARD_DIR = process.env.SHARD_DIR || './output/data';
const REPORT_PATH = process.env.VERIFIER_REPORT
    || path.join(SHARD_DIR, 'shard-meta-verifier-report.json');

function parseShardHeader(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const header = Buffer.alloc(29);
        const n = fs.readSync(fd, header, 0, 29, 0);
        if (n < 29) return { fatal: `short header (${n} bytes)` };
        const magic = header.slice(0, 4).toString('ascii');
        if (magic !== 'NXVF') return { fatal: `bad magic '${magic}'` };
        const version = header.readUInt8(4);
        if (version !== 0x41) return { fatal: `bad version 0x${version.toString(16)}` };
        const slotId = header.readUInt16LE(5);
        const offsetTableOffset = header.readUInt32LE(7);
        const entityCount = header.readUInt32LE(11);
        const stat = fs.fstatSync(fd);
        const expectedSize = offsetTableOffset + entityCount * 8;
        if (stat.size !== expectedSize) {
            return { fatal: `fileSize=${stat.size} != offsetTableOffset+entityCount*8=${expectedSize}` };
        }
        const table = Buffer.alloc(entityCount * 8);
        fs.readSync(fd, table, 0, entityCount * 8, offsetTableOffset);
        const validPairs = new Set();
        for (let i = 0; i < entityCount; i++) {
            const off = table.readUInt32LE(i * 8);
            const sz = table.readUInt32LE(i * 8 + 4);
            validPairs.add(`${off}-${sz}`);
        }
        return { fileSize: stat.size, slotId, entityCount, validPairs };
    } finally {
        fs.closeSync(fd);
    }
}

function loadShards() {
    const shards = {};
    const errors = [];
    const files = fs.readdirSync(SHARD_DIR).filter(f => /^fused-shard-\d+\.bin$/.test(f));
    for (const f of files) {
        const key = `data/${f}`;
        const parsed = parseShardHeader(path.join(SHARD_DIR, f));
        if (parsed.fatal) {
            errors.push({ shard: key, error: parsed.fatal });
            continue;
        }
        shards[key] = parsed;
    }
    return { shards, errors };
}

function loadMetaRows() {
    const files = fs.readdirSync(SHARD_DIR).filter(f => /^meta-\d+\.db$/.test(f));
    const rows = [];
    for (const f of files) {
        const db = new Database(path.join(SHARD_DIR, f), { readonly: true });
        const stmt = db.prepare(
            "SELECT id, slug, bundle_key, bundle_offset, bundle_size FROM entities WHERE bundle_key LIKE 'data/fused-shard-%'"
        );
        for (const r of stmt.iterate()) rows.push({ metaDb: f, ...r });
        db.close();
    }
    return { files, rows };
}

function main() {
    console.log('[VERIFIER] Pre-upload shard-meta consistency check starting...');
    if (!fs.existsSync(SHARD_DIR)) {
        console.error(`[VERIFIER] FATAL: ${SHARD_DIR} not found`);
        process.exit(1);
    }

    const { shards, errors: shardErrors } = loadShards();
    const shardCount = Object.keys(shards).length;
    const totalShardEntities = Object.values(shards).reduce((s, x) => s + x.entityCount, 0);
    console.log(`[VERIFIER] Indexed ${shardCount} shard binaries (${shardErrors.length} self-inconsistent, ${totalShardEntities} entities total)`);

    const pairToShards = new Map();
    for (const [k, s] of Object.entries(shards)) {
        for (const p of s.validPairs) {
            const list = pairToShards.get(p) || [];
            list.push(k);
            pairToShards.set(p, list);
        }
    }

    const { files: metaFiles, rows } = loadMetaRows();
    console.log(`[VERIFIER] Scanned ${metaFiles.length} meta DBs; ${rows.length} entity rows reference shard binaries`);

    const bad = [];
    for (const r of rows) {
        const shard = shards[r.bundle_key];
        if (!shard) {
            bad.push({ ...r, kind: 'shard-missing', detail: `${r.bundle_key} not on disk` });
            continue;
        }
        const pairKey = `${r.bundle_offset}-${r.bundle_size}`;
        const endOffset = r.bundle_offset + r.bundle_size;
        const realLocation = pairToShards.get(pairKey) || [];
        if (endOffset > shard.fileSize) {
            bad.push({ ...r, kind: 'overflow',
                detail: `endOffset=${endOffset} > fileSize=${shard.fileSize} (delta +${endOffset - shard.fileSize})`,
                realLocation });
            continue;
        }
        if (!shard.validPairs.has(pairKey)) {
            bad.push({ ...r, kind: 'offset-not-in-table',
                detail: `(offset=${r.bundle_offset}, size=${r.bundle_size}) not in this shard's offset table`,
                realLocation });
        }
    }

    const writtenElsewhere = bad.filter(b => b.realLocation && b.realLocation.length && !b.realLocation.includes(b.bundle_key));
    const writtenNowhere = bad.filter(b => !b.realLocation || b.realLocation.length === 0);

    const summary = {
        timestamp: new Date().toISOString(),
        shardCount,
        totalShardEntities,
        shardSelfInconsistent: shardErrors,
        metaFileCount: metaFiles.length,
        totalRowsScanned: rows.length,
        badRowCount: bad.length,
        kindCounts: bad.reduce((m, b) => { m[b.kind] = (m[b.kind] || 0) + 1; return m; }, {}),
        writtenElsewhereCount: writtenElsewhere.length,
        writtenNowhereCount: writtenNowhere.length,
        firstBadRows: bad.slice(0, 100),
    };
    fs.writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2));

    if (shardErrors.length === 0 && bad.length === 0) {
        console.log(`[VERIFIER] PASS: ${rows.length} rows all reference valid (offset, size) pairs.`);
        return;
    }

    if (shardErrors.length > 0) {
        console.error(`[VERIFIER] FAIL: ${shardErrors.length} shard binaries self-inconsistent:`);
        for (const e of shardErrors.slice(0, 10)) console.error(`  ${e.shard}: ${e.error}`);
    }
    if (bad.length > 0) {
        console.error(`[VERIFIER] FAIL: ${bad.length} entity rows reference offsets not present in target shard.`);
        console.error(`  - ${writtenElsewhere.length} bad rows: (offset,size) DOES exist in a DIFFERENT shard's offset table`);
        console.error(`      => meta-DB.bundle_key and ShardWriter.currentName diverged mid-loop (pack-db.js bug)`);
        console.error(`  - ${writtenNowhere.length} bad rows: (offset,size) does NOT exist in ANY shard's offset table`);
        console.error(`      => meta-DB row inserted but writeEntity() never recorded that pair (different pack-db.js bug,`);
        console.error(`         OR shard file was truncated between writeEntity and finalize)`);
        console.error('[VERIFIER] First 10 bad rows (full list in report):');
        for (const b of bad.slice(0, 10)) {
            const loc = (b.realLocation && b.realLocation.length)
                ? `actuallyIn=[${b.realLocation.join(',')}]`
                : 'notInAnyShard';
            console.error(`  [${b.metaDb}] id=${b.id} slug=${b.slug} bundle_key=${b.bundle_key} ${b.kind}: ${b.detail} ${loc}`);
        }
    }

    console.error(`[VERIFIER] Report: ${REPORT_PATH}`);
    console.error('[VERIFIER] BUILD HALTED — inconsistent local state must not reach R2.');
    process.exit(1);
}

main();
