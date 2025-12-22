/**
 * L5 D1 Relations Sync Script
 * 
 * B.1.1 500K Scale Optimization
 * Syncs relations from JSON to D1 via wrangler batch execution
 * Runs in GitHub Actions Sidecar (no timeout limits)
 * 
 * @module l5/relations-sync-d1
 */

import fs from 'fs';
import { execSync } from 'child_process';

const BATCH_SIZE = 500; // D1 batch limit
const DB_NAME = 'ai-nexus-db';

/**
 * Escape single quotes for SQL
 */
function escapeSql(str) {
    if (!str) return 'NULL';
    return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Build INSERT statement for a batch
 */
function buildBatchInsert(relations) {
    const values = relations.map(r =>
        `(${escapeSql(r.source_id)}, ${escapeSql(r.target_id)}, ${escapeSql(r.relation_type)}, ${r.confidence || 1.0}, ${escapeSql(r.source_url)})`
    ).join(',\n');

    return `INSERT OR REPLACE INTO entity_relations 
        (source_id, target_id, relation_type, confidence, source_url)
        VALUES ${values};`;
}

/**
 * Sync relations to D1 via wrangler
 */
export async function syncToD1(inputFile) {
    console.log(`📊 Loading relations from ${inputFile}...`);
    const relations = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    console.log(`📦 Loaded ${relations.length} relations`);

    const startTime = Date.now();
    let synced = 0;
    const totalBatches = Math.ceil(relations.length / BATCH_SIZE);

    for (let i = 0; i < relations.length; i += BATCH_SIZE) {
        const batch = relations.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;

        const sql = buildBatchInsert(batch);
        const sqlFile = `/tmp/batch_${batchNum}.sql`;
        fs.writeFileSync(sqlFile, sql);

        try {
            execSync(`npx wrangler d1 execute ${DB_NAME} --file ${sqlFile} --remote`, {
                stdio: 'pipe',
                timeout: 60000 // 60s per batch
            });
            synced += batch.length;

            if (batchNum % 10 === 0 || batchNum === totalBatches) {
                console.log(`   ✅ Batch ${batchNum}/${totalBatches}: ${synced} synced`);
            }
        } catch (err) {
            console.error(`   ❌ Batch ${batchNum} failed:`, err.message);
        }

        // Cleanup
        fs.unlinkSync(sqlFile);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ D1 sync complete: ${synced}/${relations.length} in ${elapsed}s`);

    return { synced, total: relations.length, elapsed_seconds: parseFloat(elapsed) };
}

// CLI execution
if (process.argv[1].includes('relations-sync-d1')) {
    const inputFile = process.argv[2] || 'data/relations.json';

    syncToD1(inputFile)
        .then(result => {
            console.log('\n📊 Result:');
            console.log(`   Synced: ${result.synced}/${result.total}`);
            console.log(`   Time: ${result.elapsed_seconds}s`);
        })
        .catch(err => {
            console.error('❌ Error:', err.message);
            process.exit(1);
        });
}

export default { syncToD1 };
