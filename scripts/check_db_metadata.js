
import Database from 'better-sqlite3';
const db = new Database('G:/ai-nexus/data/content.db');
const rows = db.prepare('SELECT name, summary, stars, tags FROM entities WHERE stars > 0 OR summary != "" LIMIT 10').all();
console.log(JSON.stringify(rows, null, 2));
