/**
 * Enhanced GitHub Data Enrichment Script
 * 
 * Usage:
 *   node scripts/enrich-github-enhanced.js [--remote] [--limit=100] [--dry-run]
 */

import { CONFIG, metrics, sleep } from './github/gh-config.js';
import {
    loadCheckpoint,
    saveCheckpoint,
    clearCheckpoint,
    queryD1WithRetry,
    updateModelGitHubData
} from './github/gh-db.js';
import { enrichWithFallback, checkRateLimit } from './github/gh-service.js';

// Parse command line arguments
const args = process.argv.slice(2);
const isRemote = args.includes('--remote');
const isDryRun = args.includes('--dry-run');
const limitMatch = args.find(arg => arg.startsWith('--limit='));
const limit = limitMatch ? parseInt(limitMatch.split('=')[1]) : null;

/**
 * Check if we need to run enrichment (smart skip)
 */
async function countModelsNeedingEnrichment() {
    try {
        const sql = `
            SELECT COUNT(*) as count
            FROM models
            WHERE source_url IS NOT NULL 
              AND source_url LIKE '%github.com%'
              AND github_stars IS NULL;
        `;
        const result = await queryD1WithRetry(sql, isRemote);
        return result[0]?.count || 0;
    } catch (error) {
        console.error('❌ Failed to count models:', error.message);
        return 0;
    }
}

/**
 * Fetch models in small batches using OFFSET pagination
 */
async function* fetchModelsInBatches(checkpoint, batchSize = CONFIG.BATCH_SIZE) {
    let offset = 0;
    const processedIds = new Set(checkpoint.processedIds || []);

    while (true) {
        const sql = `
            SELECT id, name, author, source_url
            FROM models
            WHERE source_url IS NOT NULL 
              AND source_url LIKE '%github.com%'
              AND github_stars IS NULL
            ORDER BY downloads DESC
            LIMIT ${batchSize} OFFSET ${offset};
        `;

        try {
            const batch = await queryD1WithRetry(sql, isRemote);

            if (batch.length === 0) break;

            const unprocessed = batch.filter(m => !processedIds.has(m.id));

            if (unprocessed.length > 0) {
                yield unprocessed;
            }

            offset += batchSize;
            if (limit && offset >= limit) break;

        } catch (error) {
            console.error(`❌ Failed to fetch batch at offset ${offset}:`, error.message);
            break;
        }
    }
}

/**
 * Process batch with concurrency control
 */
async function processBatchConcurrently(batch) {
    const results = { success: [], failed: [], skipped: [] };

    // Simple concurrency control
    const promises = [];
    for (let i = 0; i < batch.length; i += CONFIG.CONCURRENT_LIMIT) {
        const chunk = batch.slice(i, i + CONFIG.CONCURRENT_LIMIT);
        const chunkPromises = chunk.map(async (model) => {
            try {
                const result = await enrichWithFallback(model);

                if (result.skip) {
                    console.log(`⏭️  Skipped ${model.id}: ${result.reason}`);
                    results.skipped.push(model.id);
                    metrics.skipped++;
                } else {
                    if (isDryRun) {
                        console.log(`🔍 [DRY RUN] Would update ${model.id}: ${result.github_stars}⭐`);
                    } else {
                        await updateModelGitHubData(model.id, result, isRemote, isDryRun);
                        console.log(`✅ Updated ${model.id}: ${result.github_stars}⭐ ${result.github_forks}🔀`);
                    }
                    results.success.push(model.id);
                    metrics.successful++;
                }

                await sleep(500); // Rate limiting

            } catch (error) {
                console.error(`❌ Failed ${model.id}:`, error.message);
                results.failed.push(model.id);
                metrics.failed++;
            }

            metrics.totalProcessed++;
        });

        await Promise.all(chunkPromises);
    }

    return results;
}

/**
 * Print final summary
 */
function printSummary() {
    metrics.endTime = Date.now();
    const totalTime = (metrics.endTime - metrics.startTime) / 1000;
    const avgTime = metrics.totalProcessed > 0 ? (totalTime / metrics.totalProcessed).toFixed(2) : 0;

    console.log('\n' + '='.repeat(70));
    console.log('📊 ENRICHMENT SUMMARY');
    console.log('='.repeat(70));
    console.log(`✅ Successful:      ${metrics.successful}`);
    console.log(`❌ Failed:          ${metrics.failed}`);
    console.log(`⏭️  Skipped:         ${metrics.skipped}`);
    console.log(`📝 Total Processed: ${metrics.totalProcessed}`);
    console.log('─'.repeat(70));
    console.log(`⏱️  Total Time:      ${totalTime.toFixed(2)}s`);
    console.log(`📊 Avg Time/Model:  ${avgTime}s`);
    console.log(`🔧 API Calls Used:  ${metrics.apiCallsUsed}`);
    console.log(`📉 Rate Limit Left: ${metrics.rateLimitRemaining}`);
    console.log('='.repeat(70));

    if (metrics.errors.length > 0) {
        console.log('\n⚠️  Errors encountered:');
        metrics.errors.slice(0, 5).forEach(e => {
            console.log(`   - ${e.modelId}: ${e.error}`);
        });
    }

    if (isDryRun) {
        console.log('\n💡 This was a dry run. Use without --dry-run to update database.');
    }
}

/**
 * Main enrichment process
 */
async function main() {
    console.log('🚀 Enhanced GitHub Data Enrichment Script');
    console.log(`📍 Target: ${isRemote ? 'REMOTE' : 'LOCAL'} database`);
    console.log(`🔍 Dry run: ${isDryRun ? 'YES' : 'NO'}`);
    console.log(`📊 Limit: ${limit || 'NONE'}`);
    console.log(`⚡ Concurrent: ${CONFIG.CONCURRENT_LIMIT} requests`);
    console.log('');

    // Step 1: Check rate limit
    console.log('⏳ Checking GitHub API rate limit...');
    const rateLimit = await checkRateLimit();
    if (rateLimit) {
        metrics.rateLimitRemaining = rateLimit.remaining;
        console.log(`✅ Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining`);

        if (rateLimit.remaining < 100) {
            console.warn(`⚠️  WARNING: Low rate limit. Consider waiting until ${rateLimit.reset.toLocaleString()}`);
            return;
        }
    }
    console.log('');

    // Step 2: Smart skip check
    console.log('🔍 Checking if enrichment is needed...');
    const needsEnrichment = await countModelsNeedingEnrichment();
    console.log(`📊 Found ${needsEnrichment} models needing enrichment\n`);

    if (needsEnrichment === 0) {
        console.log('✅ No models need enrichment. Exiting.');
        return;
    }

    // Step 3: Load checkpoint
    const checkpoint = loadCheckpoint();
    if (checkpoint.processedIds && checkpoint.processedIds.length > 0) {
        console.log(`📌 Resuming from checkpoint (${checkpoint.processedIds.length} already processed)\n`);
    }

    // Step 4: Process in batches
    let batchNum = 0;

    for await (const batch of fetchModelsInBatches(checkpoint)) {
        batchNum++;
        console.log(`\n📦 Processing batch ${batchNum} (${batch.length} models)...`);

        const results = await processBatchConcurrently(batch);

        // Update checkpoint
        checkpoint.processedIds = checkpoint.processedIds || [];
        checkpoint.processedIds.push(...results.success, ...results.skipped);
        saveCheckpoint(checkpoint);

        // Delay between batches
        if (await fetchModelsInBatches(checkpoint).next()) {
            console.log(`⏳ Waiting ${CONFIG.DELAY_BETWEEN_BATCHES_MS}ms before next batch...`);
            await sleep(CONFIG.DELAY_BETWEEN_BATCHES_MS);
        }
    }

    // Step 5: Cleanup and summary
    clearCheckpoint();
    printSummary();
}

main().catch(error => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
});
