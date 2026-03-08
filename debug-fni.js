
import sqlite3 from 'sqlite3';
import path from 'path';

async function checkFni(dbName) {
    const dbPath = path.join(process.cwd(), 'data', dbName);
    console.log(`\nChecking ${dbName}...`);

    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error(`Error opening ${dbName}:`, err.message);
                return resolve();
            }
            db.all("SELECT id, name, type, fni_score, fni FROM entities LIMIT 5", [], (err, rows) => {
                if (err) {
                    // Try to list tables if entities doesn't exist
                    db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err2, tables) => {
                        console.error(`Error querying ${dbName}:`, err.message);
                        if (tables) console.log("Available tables:", tables.map(t => t.name).join(', '));
                        db.close();
                        resolve();
                    });
                } else {
                    console.table(rows);
                    db.close();
                    resolve();
                }
            });
        });
    });
}

async function run() {
    await checkFni('meta.db');
    await checkFni('content.db');
}

run();
