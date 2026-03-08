
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'meta.db');

try {
    const db = new Database(dbPath, { readonly: true });
    console.log('Successfully opened meta.db');

    // Check data
    const rows = db.prepare("SELECT id, name, type, fni_score, downloads FROM entities WHERE fni_score > 0 LIMIT 10").all();
    if (rows.length > 0) {
        console.log('Top items with FNI > 0:');
        console.table(rows);
    } else {
        console.log('No items found with fni_score > 0. Checking first 10 items instead:');
        const firstRows = db.prepare("SELECT id, name, type, fni_score, downloads FROM entities LIMIT 10").all();
        console.table(firstRows);
    }

    db.close();
} catch (e) {
    console.error('Error:', e.message);
}
