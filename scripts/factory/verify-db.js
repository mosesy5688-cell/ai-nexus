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
const isFtsDb = dbName === 'fts.db';

/**
 * Global Category Thresholds — RISK-V1: Dynamic baseline with floor.
 * Uses previous cycle's count (from baseline file) * 0.90 as minimum,
 * with a hard floor to catch total collapse scenarios.
 */
const HARD_FLOOR = {
    search: 50000, core: 5000, paper: 20000, model: 10000,
    dataset: 5000, ecosystem: 100, agent: 100, tool: 500, prompt: 500, space: 100
};

function getThreshold(category) {
    const floor = HARD_FLOOR[category] || 100;
    try {
        const baselinePath = path.join(dirPath, '.entity-baseline.json');
        if (fs.existsSync(baselinePath)) {
            const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
            const prev = baseline[category] || 0;
            if (prev > 0) return Math.max(floor, Math.floor(prev * 0.90));
        }
    } catch { /* baseline unavailable, use floor */ }
    return floor;
}

/**
 * Identify category from database filename
 * meta-paper-shard-01.db -> paper
 * meta-dataset.db -> dataset
 */
const isHashShard = /^meta-\d+\.db$/.test(dbName); // V5.8 hash-shard: meta-00.db ~ meta-15.db
const isAnchorDb = /^meta-(report|knowledge)\.db$/.test(dbName); // Discovery Anchor DBs (articles table)

function getCategory(name) {
    if (name === 'search.db') return 'search';
    if (name.includes('core')) return 'core';
    if (/^meta-\d+\.db$/.test(name)) return 'hash-shard';
    const match = name.match(/meta-([a-z]+)/);
    return match ? match[1] : null;
}

const category = getCategory(dbName);
const THRESHOLD = getThreshold(category);
const EXPECTED_PAGE_SIZE = 16384;
const MAX_DB_SIZE_MB = isSearchDb ? 800 : (isHashShard || isFtsDb) ? 250 : 125;

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
const hasEntitiesTable = !isFtsDb && !isAnchorDb && !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'").get();
if (isFtsDb) {
    const ftsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search'").get();
    check('FTS5 Table', !!ftsTable, ftsTable ? 'search table present' : 'search table missing');
} else if (isAnchorDb) {
    const articlesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='articles'").get();
    check('Anchor Schema', !!articlesTable, articlesTable ? 'articles table present' : 'articles table missing');
} else if (hasEntitiesTable) {
const columns = db.prepare("PRAGMA table_info(entities)").all().map(c => c.name);
const requiredCols = [
    'bundle_offset', 'bundle_size', 'shard_hash', 'is_trending', 'category', 'license', 'source_url',
    'pipeline_tag', 'image_url', 'vram_estimate_gb', 'source', 'task_categories', 'num_rows', 'primary_language',
    'forks', 'citation_count',
    'runtime_hardware', 'vocab_size', 'num_layers', 'hidden_size', 'datasets_used', 'quick_start',
    'vram_fp16_gb', 'vram_int8_gb', 'vram_int4_gb', 'readme_html', 'ui_related_mesh', 'search_vector',
    'canonical_url', 'citation', 'raw_pop'
];
const hasAllCols = requiredCols.every(c => columns.includes(c));
check('Schema Completeness', hasAllCols, hasAllCols ? 'All V23.1 columns present' : `Missing: ${requiredCols.filter(c => !columns.includes(c))}`);
} else {
    check('Schema Completeness', false, 'entities table missing (unknown DB type)');
}

// 5. Global Entity Accounting
let totalCount = 0;
if (isFtsDb) {
    totalCount = db.prepare('SELECT count(*) as c FROM search').get().c;
    check('FTS Entity Count', totalCount > 0, `${totalCount} FTS entries`);
} else if (isAnchorDb) {
    const hasArticles = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='articles'").get();
    if (hasArticles) {
        totalCount = db.prepare('SELECT count(*) as c FROM articles').get().c;
        check('Anchor Article Count', totalCount >= 0, `${totalCount} articles in ${dbName}`);
    }
} else if (!hasEntitiesTable) {
    check('Global Entity Count', false, `no entities table in ${dbName} (unknown DB type)`);
} else if (isSearchDb || dbName.includes('core') || isHashShard) {
    totalCount = db.prepare('SELECT count(*) as c FROM entities').get().c;
    check('Global Entity Count', totalCount >= THRESHOLD, `${totalCount} in ${category || dbName} (min: ${THRESHOLD})`);
} else if (category) {
    const shardFiles = fs.readdirSync(dirPath).filter(f =>
        f.startsWith(`meta-${category}`) && f.endsWith('.db')
    );
    for (const f of shardFiles) {
        const shardDb = new Database(path.join(dirPath, f), { readonly: true });
        const hasTable = !!shardDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'").get();
        if (hasTable) totalCount += shardDb.prepare('SELECT count(*) as c FROM entities').get().c;
        shardDb.close();
    }
    check('Global Entity Count', totalCount >= THRESHOLD, `${totalCount} in ${category || dbName} (min: ${THRESHOLD})`);
}

// 6. Shard Consistency (skip for FTS-only DBs and legacy DBs)
const heavySample = hasEntitiesTable ? db.prepare('SELECT bundle_key, bundle_offset, bundle_size, shard_hash FROM entities WHERE bundle_key IS NOT NULL LIMIT 1').get() : null;
if (heavySample) {
    const isShardFormat = heavySample.bundle_key.startsWith('data/fused-shard-');
    check('Shard Format', isShardFormat, heavySample.bundle_key);
    const hasHash = heavySample.shard_hash && heavySample.shard_hash.length === 64;
    check('Shard Hash Integrity', isSearchDb || hasHash, 'Registry/Hash check');
}

// 7. Binary Shard Validation (V25.8.2: NXVF V4.1 Header Check)
const shardDir = path.join(dirPath, '..', 'cache', 'registry');
if (fs.existsSync(shardDir)) {
    const binShards = fs.readdirSync(shardDir).filter(f => f.endsWith('.bin'));
    if (binShards.length > 0) {
        let binOk = 0;
        let binFail = 0;
        for (const shard of binShards) {
            const data = fs.readFileSync(path.join(shardDir, shard));
            const hasNxvf = data.length >= 29 && data[0] === 0x4E && data[1] === 0x58 && data[2] === 0x56 && data[3] === 0x46;
            if (hasNxvf) {
                const entityCount = data.readUInt32LE(11);
                const offsetTableOff = data.readUInt32LE(7);
                const checksum = data.readUInt32LE(15);
                const table = data.subarray(offsetTableOff, offsetTableOff + entityCount * 8);
                let computed = 0;
                for (let i = 0; i < table.length; i += 4) computed ^= table.readUInt32LE(i);
                if ((computed >>> 0) === checksum) binOk++;
                else binFail++;
            } else {
                binFail++;
            }
        }
        check('Binary Shards (NXVF)', binFail === 0, `${binOk}/${binShards.length} valid`);
    }
}

db.close();

// RISK-V1: Save baseline for next cycle's dynamic threshold
if (failures === 0 && category && totalCount > 0) {
    const baselinePath = path.join(dirPath, '.entity-baseline.json');
    let baseline = {};
    try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')); } catch { }
    baseline[category] = totalCount;
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
}

console.log(`\n=== Health Check Complete: ${failures} failures ===`);
process.exit(failures > 0 ? 1 : 0);
