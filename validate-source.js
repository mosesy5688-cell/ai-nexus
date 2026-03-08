
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'meta.db');

try {
    const db = new Database(dbPath, { readonly: true });

    const types = ['model', 'dataset', 'agent', 'tool', 'paper', 'space', 'prompt'];

    console.log('--- Data Audit ---');
    for (const type of types) {
        console.log(`\nType: ${type.toUpperCase()}`);

        // Dynamic column check
        const info = db.prepare("PRAGMA table_info(entities)").all();
        const cols = info.map(c => c.name);

        const metrics = ['fni_score', 'downloads', 'stars', 'likes', 'citations'].filter(c => cols.includes(c));

        const qParts = metrics.map(c => `COUNT(CASE WHEN ${c} > 0 THEN 1 END) as with_${c}`).join(', ');
        const sql = `SELECT COUNT(*) as total, ${qParts} FROM entities WHERE type = ?`;

        const stats = db.prepare(sql).get(type);
        console.table(stats);

        const sampleSql = `SELECT name, ${metrics.join(', ')} FROM entities WHERE type = ? AND (${metrics.map(c => `${c} > 0`).join(' OR ')}) LIMIT 3`;
        try {
            const sample = db.prepare(sampleSql).all(type);
            console.log('Samples:');
            console.table(sample);
        } catch (e) { }
    }

    db.close();
} catch (e) {
    console.error('Error:', e.message);
}
