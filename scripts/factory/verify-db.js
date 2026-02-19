/**
 * V19.2 content.db Health Check (Stable 1.0 Ratified)
 * Exits with code 1 on any critical failure to block deployment.
 * Checks: Stable page size, schema integrity, sharded bundle consistency.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

const DB_PATH = process.argv[2] || './output/data/content.db';
let failures = 0;

function check(label, pass, detail = '') {
    const status = pass ? '✅ PASS' : '❌ FAIL';
    console.log(`${label.padEnd(25)}: ${detail.padEnd(25)} → ${status}`);
    if (!pass) failures++;
}

// 0. File existence
if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ FATAL: ${DB_PATH} does not exist.`);
    process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
console.log('=== V19.2 content.db Health Check (Frozen Stable 1.0) ===\n');

// 1. Integrity check
const integrity = db.pragma('integrity_check')[0].integrity_check;
check('Integrity', integrity === 'ok', integrity);

// 2. Page Alignment (Stable 1.0 Specs)
const pageSize = db.pragma('page_size')[0].page_size;
check('Page Size', pageSize === 4096, `${pageSize} (expected: 4096)`);

// 3. File size guard (Art 2.2 Scale Guard)
const fileSizeMB = Math.round(fs.statSync(DB_PATH).size / 1024 / 1024);
check('File Size Scan', fileSizeMB < 700, `${fileSizeMB}MB (limit: 700MB)`);

// 4. Shard Count Guard (Art 2.1)
const shardFiles = fs.readdirSync(path.dirname(DB_PATH)).filter(f => f.startsWith('fused-shard-') && f.endsWith('.bin'));
check('Shard Count', shardFiles.length <= 64, `${shardFiles.length} shards (limit: 64)`);

// 5. Schema Completeness (Stage 4/4)
const columns = db.prepare("PRAGMA table_info(entities)").all().map(c => c.name);
const requiredCols = ['bundle_offset', 'bundle_size', 'shard_hash', 'is_trending'];
const hasAllCols = requiredCols.every(c => columns.includes(c));
check('Schema Completeness', hasAllCols, hasAllCols ? 'All V19.2 columns present' : `Missing: ${requiredCols.filter(c => !columns.includes(c))}`);

// 6. Entity Count
const count = db.prepare('SELECT count(*) as c FROM entities').get().c;
check('Entity Count', count > 80000, `${count} (expected: >80000)`);

// 5. Shard Consistency
const heavySample = db.prepare('SELECT bundle_key, bundle_offset, bundle_size, shard_hash FROM entities WHERE bundle_key IS NOT NULL LIMIT 1').get();
if (heavySample) {
    const isShardFormat = heavySample.bundle_key.startsWith('data/fused-shard-');
    check('Shard Format', isShardFormat, heavySample.bundle_key);
    check('Shard Hash Integrity', heavySample.shard_hash && heavySample.shard_hash.length === 64, 'Hash present');

    // Security Choice B: 8KB Alignment Verification
    const isAligned = heavySample.bundle_offset % 8192 === 0;
    check('Shard Alignment (8KB)', isAligned, `Offset: ${heavySample.bundle_offset}`);
} else {
    check('Shard Sample', false, 'No sharded entities found!');
}

// 6. FTS5 Search Test
try {
    const ftsResults = db.prepare(
        "SELECT e.id, e.name, e.type FROM search s JOIN entities e ON e.rowid = s.rowid WHERE search MATCH '\"llama\"*' LIMIT 5"
    ).all();
    check('FTS5 Search', ftsResults.length > 0, `${ftsResults.length} results for "llama"`);
} catch (e) {
    check('FTS5 Search', false, e.message);
}

// 7. Trending & Sorting Stability
const topEntity = db.prepare('SELECT name, fni_score, is_trending FROM entities ORDER BY fni_score DESC LIMIT 1').get();
check('Popularity Sorting', topEntity && topEntity.fni_score > 0, `Top: ${topEntity?.name} (${topEntity?.fni_score})`);
check('Trending Injection', topEntity && (topEntity.is_trending === 0 || topEntity.is_trending === 1), 'Flag verified');

db.close();
console.log(`\n=== Health Check Complete: ${failures} failures ===`);
process.exit(failures > 0 ? 1 : 0);
