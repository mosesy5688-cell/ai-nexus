/**
 * L5 FTS Sync Maintenance Script
 * 
 * B.17 D1 FTS5 Search Sync
 * Rebuilds and optimizes the D1 FTS5 virtual table.
 * 
 * @module l5/fts-sync
 */

import { execSync } from 'child_process';

/**
 * Run wrangler d1 command
 */
function runD1Command(sql) {
    console.log(`📡 Executing SQL: ${sql.slice(0, 50)}...`);
    try {
        const output = execSync(`npx wrangler d1 execute DB --remote --command="${sql}"`, { encoding: 'utf-8' });
        return output;
    } catch (err) {
        console.error('❌ D1 Execution Error:', err.stderr || err.message);
        throw err;
    }
}

/**
 * Rebuild the FTS5 index
 */
export async function maintainFTS() {
    console.log('🏗️ Starting FTS Index Maintenance...');
    const startTime = Date.now();

    try {
        // 1. Rebuild the index (Optimizes internal b-trees)
        console.log('   - Rebuilding FTS index...');
        runD1Command("INSERT INTO entities_fts(entities_fts) VALUES('rebuild');");

        // 2. Clean up deleted entries (If any lingered)
        console.log('   - Running FTS clean...');
        runD1Command("INSERT INTO entities_fts(entities_fts) VALUES('delete-all');");
        runD1Command("INSERT INTO entities_fts (id, name, author, tags, pipeline_tag, primary_category) SELECT id, name, author, tags, pipeline_tag, primary_category FROM entities;");

        // 3. Verify Integrity
        console.log('   - Verifying index integrity...');
        const check = runD1Command("SELECT COUNT(*) as count FROM entities_fts;");
        console.log(`   ✅ Integrity Check: ${check.trim()}`);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ FTS Maintenance complete in ${elapsed}s`);
    } catch (err) {
        console.error('❌ FTS maintenance failed:', err.message);
        process.exit(1);
    }
}

// CLI execution
if (process.argv[1].includes('fts-sync')) {
    maintainFTS();
}

export default { maintainFTS };
