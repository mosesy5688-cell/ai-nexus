/**
 * V19.0 content.db Verification Script (CI-Safe)
 * Exits with code 1 on any critical failure to block deployment.
 * Checks: page alignment, entity count, type distribution, FTS5, data quality
 */
import Database from 'better-sqlite3';
import fs from 'fs';

const DB_PATH = process.argv[2] || './data/content.db';
let failures = 0;

function check(label, pass, detail = '') {
    const status = pass ? '✅ PASS' : '❌ FAIL';
    console.log(`${label}: ${detail} → ${status}`);
    if (!pass) failures++;
}

// 0. File existence
if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ FATAL: ${DB_PATH} does not exist.`);
    process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
console.log('=== V19.0 content.db Health Check ===\n');

// 1. Integrity check
const integrity = db.pragma('integrity_check')[0].integrity_check;
check('Integrity', integrity === 'ok', integrity);

// 2. Page Alignment
const pageSize = db.pragma('page_size')[0].page_size;
check('Page Size', pageSize === 8192, `${pageSize} (expected: 8192)`);

// 3. Entity Count
const count = db.prepare('SELECT count(*) as c FROM entities').get().c;
check('Entity Count', count > 80000, `${count} (expected: >80000)`);

// 4. File size guard
const fileSizeMB = Math.round(fs.statSync(DB_PATH).size / 1024 / 1024);
check('File Size', fileSizeMB < 600, `${fileSizeMB}MB (limit: 600MB)`);

// 5. Type Distribution
const types = db.prepare('SELECT type, count(*) as c FROM entities GROUP BY type ORDER BY c DESC').all();
console.log('\nType Distribution:');
types.forEach(t => console.log(`  ${t.type}: ${t.c}`));
check('Type Diversity', types.length >= 3, `${types.length} types`);

// 6. FTS5 Search Test
try {
    const ftsResults = db.prepare(
        "SELECT e.id, e.name, e.type FROM search s JOIN entities e ON e.rowid = s.rowid WHERE search MATCH '\"llama\"*' LIMIT 5"
    ).all();
    check('FTS5 Search', ftsResults.length > 0, `${ftsResults.length} results for "llama"`);
    ftsResults.forEach(r => console.log(`  [${r.type}] ${r.name} (${r.id})`));
} catch (e) {
    check('FTS5 Search', false, e.message);
}

// 7. Data quality: top entities must have names
const topEntities = db.prepare('SELECT name, type, fni_score FROM entities ORDER BY fni_score DESC LIMIT 5').all();
const hasNames = topEntities.every(e => e.name && e.name.length > 0);
check('Data Quality (names)', hasNames, `Top ${topEntities.length} entities all have names`);
console.log('\nTop 5 by FNI:');
topEntities.forEach(e => console.log(`  [${e.type}] ${e.name} — FNI: ${e.fni_score}`));

db.close();
console.log(`\n=== Health Check Complete: ${failures} failures ===`);
process.exit(failures > 0 ? 1 : 0);
