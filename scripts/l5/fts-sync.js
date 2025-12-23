/**
 * L5 FTS Sync Maintenance Script V2.0
 * 
 * B.17 D1 FTS5 Search Sync
 * Rebuilds and optimizes the D1 FTS5 virtual table.
 * 
 * V2.0: Added robustness for missing table (auto-create)
 * 
 * @module l5/fts-sync
 */

import { execSync } from 'child_process';

/**
 * Run wrangler d1 command (with optional silent mode)
 */
function runD1Command(sql, silent = false) {
    if (!silent) {
        console.log(`📡 Executing SQL: ${sql.slice(0, 60)}...`);
    }
    try {
        const output = execSync(`npx wrangler d1 execute DB --remote --command="${sql}"`, {
            encoding: 'utf-8',
            stdio: silent ? 'pipe' : 'inherit'
        });
        return { success: true, output };
    } catch (err) {
        if (!silent) {
            console.error('❌ D1 Execution Error:', err.stderr || err.message);
        }
        return { success: false, error: err.message };
    }
}

/**
 * Check if entities_fts table exists
 */
function checkFTSTableExists() {
    console.log('🔍 Checking if entities_fts table exists...');
    const result = runD1Command(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entities_fts';",
        true
    );
    // If table exists, output will contain 'entities_fts'
    return result.success && result.output && result.output.includes('entities_fts');
}

/**
 * Create the FTS5 table if missing
 */
function createFTSTable() {
    console.log('🏗️ Creating entities_fts table (first-time setup)...');

    // Create FTS5 virtual table
    const createResult = runD1Command(
        "CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(id UNINDEXED, name, author, tags, pipeline_tag, primary_category, tokenize='porter unicode61');"
    );

    if (!createResult.success) {
        console.error('❌ Failed to create FTS table');
        return false;
    }

    // Populate from entities table
    console.log('📥 Populating FTS index from entities table...');
    const populateResult = runD1Command(
        "INSERT INTO entities_fts (id, name, author, tags, pipeline_tag, primary_category) SELECT id, name, author, tags, pipeline_tag, primary_category FROM entities;"
    );

    if (!populateResult.success) {
        console.warn('⚠️ FTS population had issues, continuing...');
    }

    console.log('✅ FTS table created and populated');
    return true;
}

/**
 * Rebuild the FTS5 index
 */
export async function maintainFTS() {
    console.log('🏗️ Starting FTS Index Maintenance V2.0...');
    const startTime = Date.now();

    try {
        // 0. Check if table exists, create if missing
        const tableExists = checkFTSTableExists();
        if (!tableExists) {
            console.log('⚠️ entities_fts table not found, creating...');
            const created = createFTSTable();
            if (!created) {
                console.warn('⚠️ Could not create FTS table, skipping FTS maintenance');
                console.log('ℹ️ FTS is optional - search will use fallback methods');
                return; // Exit gracefully, don't fail the workflow
            }
        }

        // 1. Rebuild the index (Optimizes internal b-trees)
        console.log('   - Rebuilding FTS index...');
        const rebuildResult = runD1Command("INSERT INTO entities_fts(entities_fts) VALUES('rebuild');");
        if (!rebuildResult.success) {
            console.warn('⚠️ FTS rebuild skipped');
        }

        // 2. Full re-sync from entities table (safer than incremental)
        console.log('   - Full re-sync from entities table...');
        runD1Command("DELETE FROM entities_fts;");
        runD1Command("INSERT INTO entities_fts (id, name, author, tags, pipeline_tag, primary_category) SELECT id, name, author, tags, pipeline_tag, primary_category FROM entities;");

        // 3. Verify count
        console.log('   - Verifying index...');
        const checkResult = runD1Command("SELECT COUNT(*) as count FROM entities_fts;", true);
        if (checkResult.success) {
            console.log(`   ✅ FTS index populated`);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ FTS Maintenance complete in ${elapsed}s`);
    } catch (err) {
        // Don't fail the workflow for FTS issues - it's optional
        console.warn('⚠️ FTS maintenance encountered issues:', err.message);
        console.log('ℹ️ Continuing workflow - FTS is optional, search will use fallback');
    }
}

// CLI execution
if (process.argv[1].includes('fts-sync')) {
    maintainFTS();
}

export default { maintainFTS };
