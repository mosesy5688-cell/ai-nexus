
import { getCachedDbConnection, executeSql } from './src/lib/sqlite-engine.js';

async function diagnoseFni() {
    const mockRuntime = { env: { SIMULATE_PRODUCTION: "true" } };
    const dbName = 'meta-model-core.db';

    console.log(`--- Diagnosing FNI Scores in ${dbName} ---`);
    try {
        const engine = await getCachedDbConnection(null, true, dbName);
        const sql = `SELECT id, name, fni_score FROM entities ORDER BY fni_score DESC LIMIT 10`;
        const rows = await executeSql(engine.sqlite3, engine.db, sql);

        console.table(rows);
    } catch (e) {
        console.error("Diagnosis failed:", e);
    }
}

diagnoseFni();
