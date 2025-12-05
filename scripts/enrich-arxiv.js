/**
 * ArXiv Enrichment Script
 * 
 * Batch enriches AI models with ArXiv academic metadata
 * Usage:
 *   node scripts/enrich-arxiv.js --dry-run --limit=3    # Test run
 *   node scripts/enrich-arxiv.js --local --limit=10     # Local enrichment
 *   node scripts/enrich-arxiv.js --remote               # Production enrichment
 */

import { execSync } from 'child_process';
import { enrichModelWithArxiv } from '../src/lib/adapters/arxiv-enricher.js';

// === Configuration ===
const DB_NAME = 'ai-nexus-db';
const BATCH_SIZE = 10;     // Process 10 models per batch
const BATCH_DELAY = 2000;  // 2s delay between batches
const MODEL_DELAY = 500;   // 500ms delay between models

// === Parse CLI Arguments ===
const args = process.argv.slice(2);
const isRemote = args.includes('--remote');
const isDryRun = args.includes('--dry-run');
const limitArg = args.find(arg => arg.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

console.log(`
🎓 ArXiv Academic Enrichment
==============================
Mode: ${isRemote ? 'REMOTE (Production D1)' : 'LOCAL (Development)'}
Dry Run: ${isDryRun ? 'YES (no database writes)' : 'NO (will update database)'}
Limit: ${limit || 'None (process all eligible models)'}
`);

// === Database Query Helper ===
async function queryD1(sql) {
    const singleLineSQL = sql.replace(/\s+/g, ' ').trim();
    const escapedSQL = singleLineSQL.replace(/"/g, '\\"');

    const remoteFlag = isRemote ? '--remote' : '--local';
    const command = `npx wrangler d1 execute ${DB_NAME} ${remoteFlag} --command="${escapedSQL}" --json`;

    try {
        const output = execSync(command, {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024
        });

        const parsed = JSON.parse(output);

        if (parsed && parsed.length > 0 && parsed[0].results) {
            return parsed[0].results;
        }

        return [];
    } catch (error) {
        console.error('D1 Query Error:', error.message);
        throw error;
    }
}

// === Fetch Models for Enrichment ===
async function fetchModelsForEnrichment() {
    console.log('📦 Fetching models with potential ArXiv references...\n');

    const sql = `
    SELECT id, name, description, source_url, arxiv_id
    FROM models
    WHERE (
      source_url LIKE '%arxiv.org%'
      OR description LIKE '%arXiv:%'
      OR description LIKE '%arxiv.org%'
    )
    AND (arxiv_id IS NULL OR arxiv_id = '')
    ${limit ? `LIMIT ${limit}` : ''}
  `;

    const models = await queryD1(sql);

    // Ensure description is a string
    return models.map(m => ({
        ...m,
        description: m.description || ''
    }));
}

// === Update Model in Database ===
async function updateModelInD1(modelId, enrichmentData) {
    if (isDryRun) {
        console.log(`  [DRY RUN] Would update model ${modelId}`);
        return true;
    }

    // Escape quotes in data
    const escapeQuotes = (str) => str ? str.replace(/'/g, "''") : '';

    const sql = `
    UPDATE models
    SET 
      arxiv_id = '${escapeQuotes(enrichmentData.arxiv_id)}',
      arxiv_category = '${escapeQuotes(enrichmentData.arxiv_category)}',
      arxiv_published = '${escapeQuotes(enrichmentData.arxiv_published)}',
      arxiv_updated = '${escapeQuotes(enrichmentData.arxiv_updated)}'
    WHERE id = '${escapeQuotes(modelId)}'
  `;

    try {
        await queryD1(sql);
        return true;
    } catch (error) {
        console.error(`  ❌ Database update failed:`, error.message);
        return false;
    }
}

// === Main Enrichment Loop ===
async function main() {
    console.log('Starting enrichment process...\n');

    try {
        // Step 1: Fetch models
        const models = await fetchModelsForEnrichment();
        console.log(`Found ${models.length} models with potential ArXiv references\n`);

        if (models.length === 0) {
            console.log('✅ No models need ArXiv enrichment');
            return;
        }

        // Step 2: Process in batches
        let enriched = 0;
        let skipped = 0;
        let failed = 0;

        for (let i = 0; i < models.length; i += BATCH_SIZE) {
            const batch = models.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(models.length / BATCH_SIZE);

            console.log(`\n📦 Batch ${batchNum}/${totalBatches} (models ${i + 1}-${Math.min(i + BATCH_SIZE, models.length)})`);
            console.log('='.repeat(60));

            for (const model of batch) {
                console.log(`\n  Processing: ${model.name}`);
                console.log(`  ID: ${model.id}`);

                try {
                    // Attempt enrichment
                    const enrichmentData = await enrichModelWithArxiv(model);

                    if (!enrichmentData) {
                        console.log('  ⏭️  Skipped (no ArXiv data found or API error)');
                        skipped++;
                        continue;
                    }

                    // Display enrichment data
                    console.log(`  ✅ ArXiv ID: ${enrichmentData.arxiv_id}`);
                    console.log(`  📁 Category: ${enrichmentData.arxiv_category || 'N/A'}`);
                    console.log(`  📅 Published: ${enrichmentData.arxiv_published ? new Date(enrichmentData.arxiv_published).toLocaleDateString() : 'N/A'}`);

                    // Update database
                    const success = await updateModelInD1(model.id, enrichmentData);

                    if (success) {
                        enriched++;
                    } else {
                        failed++;
                    }

                } catch (error) {
                    console.error(`  ❌ Error:`, error.message);
                    failed++;
                }

                // Delay between models
                await new Promise(resolve => setTimeout(resolve, MODEL_DELAY));
            }

            // Delay between batches
            if (i + BATCH_SIZE < models.length) {
                console.log(`\n⏳ Waiting ${BATCH_DELAY}ms before next batch...`);
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }
        }

        // Step 3: Summary
        console.log(`\n
${'='.repeat(60)}
📊 Enrichment Summary
${'='.repeat(60)}
Total models processed: ${models.length}
✅ Successfully enriched: ${enriched}
⏭️  Skipped (no ArXiv data): ${skipped}
❌ Failed: ${failed}
${'='.repeat(60)}
    `);

        if (enriched > 0 && !isDryRun) {
            console.log(`\n✅ ArXiv enrichment complete!`);
            console.log(`Run verification query to check results:\n`);
            console.log(`npx wrangler d1 execute ${DB_NAME} ${isRemote ? '--remote' : '--local'} --file=migrations/0013_verify.sql\n`);
        }

    } catch (error) {
        console.error('\n❌ Fatal error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run main function
main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
