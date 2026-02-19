/**
 * V19.0 content.db Data Quality Check
 */
import Database from 'better-sqlite3';

const db = new Database('./data/content.db', { readonly: true });

// 1. Check blank names
const blanks = db.prepare("SELECT count(*) as c FROM entities WHERE name IS NULL OR name = ''").get();
console.log(`Blank names: ${blanks.c} of 168315`);

// 2. Top entities with names
const top = db.prepare("SELECT id, name, type, fni_score, stars, downloads FROM entities WHERE name != '' ORDER BY fni_score DESC LIMIT 5").all();
console.log('\nTop 5 entities with names:');
top.forEach(e => console.log(`  [${e.type}] ${e.name} | FNI: ${e.fni_score} | Stars: ${e.stars} | DL: ${e.downloads}`));

// 3. FNI score distribution
const fniStats = db.prepare("SELECT count(CASE WHEN fni_score > 0 THEN 1 END) as has_fni, count(CASE WHEN fni_score = 0 OR fni_score IS NULL THEN 1 END) as no_fni FROM entities").get();
console.log(`\nFNI populated: ${fniStats.has_fni} | FNI missing: ${fniStats.no_fni}`);

// 4. FTS5 with named entities
const fts = db.prepare("SELECT e.id, e.name, e.type FROM search s JOIN entities e ON e.rowid = s.rowid WHERE search MATCH '\"gpt\"*' AND e.name != '' LIMIT 5").all();
console.log(`\nFTS5 "gpt" (named only): ${fts.length} results`);
fts.forEach(r => console.log(`  [${r.type}] ${r.name}`));

// 5. Check field mapping
const sample = db.prepare("SELECT * FROM entities LIMIT 1").get();
console.log('\nSample entity columns:', Object.keys(sample).join(', '));

db.close();
