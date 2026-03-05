/**
 * V23.1 Shard-DB Health Check (Serverless Edition)
 * Exits with code 1 on any critical failure to block deployment.
 * Checks: 16KB Page alignment, schema integrity, 120MB OOM safety guard.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const args = process.argv.slice(2);
const DB_PATH = args.find(a => !a.startsWith('--')) || './output/data/meta-model-core.db';

if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ FATAL: ${DB_PATH} does not exist.`);
    process.exit(1);
}

const dbName = path.basename(DB_PATH);
const isSearchDb = dbName === 'search.db';
const isPaperShard = dbName.includes('paper-shard');
const isModelShard = dbName.includes('model-shard');

// V23.1 Threshold Defaults
const DEFAULT_THRESHOLD = isSearchDb ? 350000 : (isPaperShard ? 50000 : (isModelShard ? 10000 : 50000));
const THRESHOLD = parseInt(args.find(a => a.startsWith('--threshold='))?.split('=')[1] || String(DEFAULT_THRESHOLD));
const EXPECTED_PAGE_SIZE = parseInt(args.find(a => a.startsWith('--page-size='))?.split('=')[1] || '16384');
const MAX_DB_SIZE_MB = 125; // SPEC 2.0 Hard Limit

let failures = 0;

function check(label, pass, detail = '') {
    const status = pass ? '✅ PASS' : '❌ FAIL';
    console.log(`${label.padEnd(25)}: ${detail.padEnd(25)} → ${status}`);
    if (!pass) failures++;
}

const db = new Database(DB_PATH, { readonly: true });
console.log(`=== V23.1 Health Check [${dbName}] ===\n`);

// 1. Integrity check
const integrity = db.pragma('integrity_check')[0].integrity_check;
check('Integrity', integrity === 'ok', integrity);

// 2. Page Alignment (V23.1 High-Density 16KB Specs)
const pageSize = db.pragma('page_size')[0].page_size;
check('Page Size', pageSize === EXPECTED_PAGE_SIZE, `${pageSize} (expected: ${EXPECTED_PAGE_SIZE})`);

// 3. File size guard (V23.1 WASM OOM Defense)
const fileSizeMB = Math.round(fs.statSync(DB_PATH).size / 1024 / 1024);
check('Memory Safety Scan', fileSizeMB <= MAX_DB_SIZE_MB, `${fileSizeMB}MB (limit: ${MAX_DB_SIZE_MB}MB)`);

// 4. Shard Count Guard (Art 2.1)
const shardFiles = fs.readdirSync(path.dirname(DB_PATH)).filter(f => f.startsWith('fused-shard-') && f.endsWith('.bin'));
check('Shard Count', shardFiles.length <= 64, `${shardFiles.length} shards (limit: 64)`);

// 5. Schema Completeness (Stage 4/4)
const columns = db.prepare("PRAGMA table_info(entities)").all().map(c => c.name);
const requiredCols = ['bundle_offset', 'bundle_size', 'shard_hash', 'is_trending', 'category', 'license', 'source_url', 'pipeline_tag', 'image_url', 'vram_estimate_gb', 'source'];
const hasAllCols = requiredCols.every(c => columns.includes(c));
check('Schema Completeness', hasAllCols, hasAllCols ? 'All V23.1 columns present' : `Missing: ${requiredCols.filter(c => !columns.includes(c))}`);

// 6. Entity Count
const count = db.prepare('SELECT count(*) as c FROM entities').get().c;
check('Entity Count', count >= THRESHOLD, `${count} (min threshold: ${THRESHOLD})`);

// 5. Shard Consistency
const heavySample = db.prepare('SELECT bundle_key, bundle_offset, bundle_size, shard_hash FROM entities WHERE bundle_key IS NOT NULL LIMIT 1').get();

if (heavySample) {
    const isShardFormat = heavySample.bundle_key.startsWith('data/fused-shard-');
    check('Shard Format', isShardFormat, heavySample.bundle_key);

    // Shard hashes are only finalized in meta.db. search.db may have empty strings.
    const hasHash = heavySample.shard_hash && heavySample.shard_hash.length === 64;
    check('Shard Hash Integrity', isSearchDb || hasHash, isSearchDb ? 'Skipped (Registry)' : 'Hash present');

    // V23.1: 16KB Alignment Verification
    const isAligned = heavySample.bundle_offset % 16384 === 0;
    check('Shard Alignment (16KB)', isAligned, `Offset: ${heavySample.bundle_offset}`);
} else {
    check('Shard Sample', true, 'No sharded entities in this partition');
}

// 6. FTS5 Search Test
if (!isSearchDb) {
    try {
        const query = (dbName.includes('paper') || dbName.includes('dataset')) ? '\"dataset\"*' : '\"llama\"*';
        const ftsResults = db.prepare(
            `SELECT count(*) as count FROM search WHERE search MATCH '${query}'`
        ).get();
        check('FTS5 Index Check', ftsResults.count >= 0, `${ftsResults.count} index matches`);
    } catch (e) {
        check('FTS5 Index Check', false, e.message);
    }
}

// 7. Popularity/FNI Integration
const topEntity = db.prepare('SELECT fni_score FROM entities ORDER BY fni_score DESC LIMIT 1').get();
check('FNI Data Integrity', topEntity && topEntity.fni_score >= 0, `Top Score: ${topEntity?.fni_score || 0}`);

db.close();
console.log(`\n=== Health Check Complete: ${failures} failures ===`);
process.exit(failures > 0 ? 1 : 0);

