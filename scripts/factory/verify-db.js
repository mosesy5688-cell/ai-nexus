/**
 * V23.1 Shard-DB Health Check (Universal Sharding Edition)
 * Exits with code 1 on any critical failure to block deployment.
 * Checks: 16KB Page alignment, schema integrity, 120MB OOM safety guard.
 * V23.1+ Upgrade: Performs global entity accounting across all category shards.
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
const dirPath = path.dirname(DB_PATH);
const isSearchDb = dbName === 'search.db';

/**
 * Global Category Thresholds (Total entities across all shards)
 */
const GLOBAL_THRESHOLDS = {
    search: 350000,
    core: 45000,
    paper: 200000, // Actual ~223k
    model: 100000, // Actual ~112k
    dataset: 40000, // Actual ~43k
    ecosystem: 1000, // Actual count is lower
    agent: 800,
    tool: 5000,
    prompt: 4000,
    space: 1000
};

/**
 * Identify category from database filename
 * meta-paper-shard-01.db -> paper
 * meta-dataset.db -> dataset
 */
function getCategory(name) {
    if (name === 'search.db') return 'search';
    if (name.includes('core')) return 'core';
    const match = name.match(/meta-([a-z]+)/);
    return match ? match[1] : null;
}

const category = getCategory(dbName);
const THRESHOLD = GLOBAL_THRESHOLDS[category] || 100;
const EXPECTED_PAGE_SIZE = 16384;
const MAX_DB_SIZE_MB = 125;

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

// 2. Page Alignment
const pageSize = db.pragma('page_size')[0].page_size;
check('Page Size', pageSize === EXPECTED_PAGE_SIZE, `${pageSize} (expected: ${EXPECTED_PAGE_SIZE})`);

// 3. File size guard
const fileSizeMB = Math.round(fs.statSync(DB_PATH).size / 1024 / 1024);
check('Memory Safety Scan', fileSizeMB <= MAX_DB_SIZE_MB, `${fileSizeMB}MB (limit: ${MAX_DB_SIZE_MB}MB)`);

// 4. Schema Completeness
const columns = db.prepare("PRAGMA table_info(entities)").all().map(c => c.name);
const requiredCols = ['bundle_offset', 'bundle_size', 'shard_hash', 'is_trending', 'category', 'license', 'source_url', 'pipeline_tag', 'image_url', 'vram_estimate_gb', 'source'];
const hasAllCols = requiredCols.every(c => columns.includes(c));
check('Schema Completeness', hasAllCols, hasAllCols ? 'All V23.1 columns present' : `Missing: ${requiredCols.filter(c => !columns.includes(c))}`);

// 5. Global Entity Accounting (Universal Sharding Fix)
let totalCount = 0;
if (isSearchDb || dbName.includes('core')) {
    totalCount = db.prepare('SELECT count(*) as c FROM entities').get().c;
} else if (category) {
    // Collect all shards for this category
    const shardFiles = fs.readdirSync(dirPath).filter(f =>
        f.startsWith(`meta-${category}`) && f.endsWith('.db')
    );

    shardFiles.forEach(f => {
        const shardDb = new Database(path.join(dirPath, f), { readonly: true });
        totalCount += shardDb.prepare('SELECT count(*) as c FROM entities').get().c;
        shardDb.close();
    });
}
check('Global Entity Count', totalCount >= THRESHOLD, `${totalCount} across all ${category} shards (min: ${THRESHOLD})`);

// 6. Shard Consistency
const heavySample = db.prepare('SELECT bundle_key, bundle_offset, bundle_size, shard_hash FROM entities WHERE bundle_key IS NOT NULL LIMIT 1').get();
if (heavySample) {
    const isShardFormat = heavySample.bundle_key.startsWith('data/fused-shard-');
    check('Shard Format', isShardFormat, heavySample.bundle_key);
    const hasHash = heavySample.shard_hash && heavySample.shard_hash.length === 64;
    check('Shard Hash Integrity', isSearchDb || hasHash, 'Registry/Hash check');
}

db.close();
console.log(`\n=== Health Check Complete: ${failures} failures ===`);
process.exit(failures > 0 ? 1 : 0);
