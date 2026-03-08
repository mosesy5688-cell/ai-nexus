
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'public', 'api', 'vfs-proxy', 'meta-model-core.db');
// If not there, check data/
const altPath = path.join(process.cwd(), 'data', 'meta-model-core.db');

const check = (p) => {
    try {
        console.log(`Checking DB: ${p}`);
        const db = new Database(p, { readonly: true });
        const row = db.prepare("SELECT name, fni_score FROM entities WHERE fni_score > 0 LIMIT 5").all();
        console.table(row);
        db.close();
    } catch (e) {
        console.log(`Failed: ${e.message}`);
    }
};

check(dbPath);
check(altPath);
check(path.join(process.cwd(), 'public', 'meta-model-core.db'));
