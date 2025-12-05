/**
 * Enhanced GitHub Data Enrichment Script
 * 
 * Features:
 * - Small batch iterations (avoid large query timeouts)
 * - Exponential backoff retry mechanism
 * - Checkpoint/resume capability
 * - Concurrent processing with rate limiting
 * - Smart skip logic
 * - Detailed metrics and reporting
 * - Data validation
 * - Graceful degradation
 * 
 * Usage:
 *   node scripts/enrich-github-enhanced.js [--remote] [--limit=100] [--dry-run]
 */

import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    extractOwnerRepo,
    enrichModelWithGitHub,
    checkRateLimit
} from '../src/lib/adapters/github-enricher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execPromise = util.promisify(exec);

// Configuration
const CONFIG = {
    DB_NAME: 'ai-nexus-db',
    BATCH_SIZE: 10,
    CONCURRENT_LIMIT: 5,  // Max concurrent API calls
    DELAY_BETWEEN_BATCHES_MS: 2000,
    MAX_RETRIES: 3,
    INITIAL_BACKOFF_MS: 1000,
    CHECKPOINT_FILE: path.join(__dirname, '.enrich-checkpoint.json'),
};

// Parse command line arguments
const args = process.argv.slice(2);
const isRemote = args.includes('--remote');
const isDryRun = args.includes('--dry-run');
const limitMatch = args.find(arg => arg.startsWith('--limit='));
const limit = limitMatch ? parseInt(limitMatch.split('=')[1]) : null;

// Metrics tracking
const metrics = {
    totalProcessed: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    startTime: Date.now(),
    endTime: null,
    apiCallsUsed: 0,
    rateLimitRemaining: 0,
    errors: []
};

/**
 * Load checkpoint if exists
 */
function loadCheckpoint() {
    if (fs.existsSync(CONFIG.CHECKPOINT_FILE)) {
        try {
            const data = fs.readFileSync(CONFIG.CHECKPOINT_FILE, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.warn('⚠️  Failed to load checkpoint, starting fresh');
            return { processedIds: [] };
        }
    }
    return { processedIds: [] };
}

/**
 * Save checkpoint
 */
function saveCheckpoint(checkpoint) {
    try {
        fs.writeFileSync(CONFIG.CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
    } catch (error) {
        console.error('❌ Failed to save checkpoint:', error.message);
    }
}

/**
 * Clear checkpoint
 */
function clearCheckpoint() {
    if (fs.existsSync(CONFIG.CHECKPOINT_FILE)) {
        fs.unlinkSync(CONFIG.CHECKPOINT_FILE);
    }
}

/**
 * Execute SQL with retry logic
 */
async function executeD1WithRetry(sql, maxRetries = CONFIG.MAX_RETRIES) {
    const tempFile = path.join(__dirname, `temp_enrich_${Date.now()}.sql`);
    fs.writeFileSync(tempFile, sql);

    const targetFlag = isRemote ? '--remote' : '--local';
    const command = `npx wrangler d1 execute ${CONFIG.DB_NAME} ${targetFlag} --file "${tempFile}"`;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const { stdout } = await execPromise(command);
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
            return stdout;
        } catch (error) {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }

            if (attempt === maxRetries - 1) {
                throw error;
            }

            const backoffTime = CONFIG.INITIAL_BACKOFF_MS * Math.pow(2, attempt);
            console.log(`⚠️  Retry ${attempt + 1}/${maxRetries} after ${backoffTime}ms...`);
            await sleep(backoffTime);
        }
    }
}

/**
 * Query D1 with retry logic (small batches)
 */
async function queryD1WithRetry(sql, maxRetries = CONFIG.MAX_RETRIES) {
    const targetFlag = isRemote ? '--remote' : '--local';
    const singleLineSQL = sql.replace(/\s+/g, ' ').trim();
    const escapedSQL = singleLineSQL.replace(/"/g, '\\"');
    const command = `npx wrangler d1 execute ${CONFIG.DB_NAME} ${targetFlag} --json --command="${escapedSQL}"`;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const { stdout } = await execPromise(command);
            const jsonStart = stdout.indexOf('[');
            const jsonEnd = stdout.lastIndexOf(']') + 1;

            if (jsonStart === -1 || jsonEnd === 0) {
                throw new Error('No JSON found in response');
            }

            const jsonStr = stdout.substring(jsonStart, jsonEnd);
            const result = JSON.parse(jsonStr);
            return result[0]?.results || [];
        } catch (error) {
            if (attempt === maxRetries - 1) {
                throw error;
            }

            const backoffTime = CONFIG.INITIAL_BACKOFF_MS * Math.pow(2, attempt);
            console.log(`⚠️  Query retry ${attempt + 1}/${maxRetries} after ${backoffTime}ms...`);
            await sleep(backoffTime);
        }
    }
}

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
        const result = await queryD1WithRetry(sql);
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
            const batch = await queryD1WithRetry(sql);

            if (batch.length === 0) break;

            // Filter out already processed (from checkpoint)
            const unprocessed = batch.filter(m => !processedIds.has(m.id));

            if (unprocessed.length > 0) {
                yield unprocessed;
            }

            offset += batchSize;

            // Respect limit if specified
            if (limit && offset >= limit) break;

        } catch (error) {
            console.error(`❌ Failed to fetch batch at offset ${offset}:`, error.message);
            break; // Stop iteration on persistent error
        }
    }
}

/**
 * Validate GitHub data
 */
function validateGitHubData(data) {
    if (!data) return false;

    // Fix negative values
    if (data.github_stars < 0) data.github_stars = 0;
    if (data.github_forks < 0) data.github_forks = 0;
    if (data.github_contributors < 0) data.github_contributors = 0;

    // Fix invalid dates
    if (!data.github_last_commit || data.github_last_commit === 'Invalid Date') {
        data.github_last_commit = null;
    }

    return true;
}

/**
 * Enrich single model with fallback strategies
 */
async function enrichWithFallback(model) {
    try {
        const ownerRepo = extractOwnerRepo(model.source_url);
        if (!ownerRepo) {
            return { skip: true, reason: 'invalid_url' };
        }

        const githubData = await enrichModelWithGitHub(model);

        if (!githubData) {
            return { skip: true, reason: 'no_data' };
        }

        // Validate data
        if (!validateGitHubData(githubData)) {
            return { skip: true, reason: 'invalid_data' };
        }

        metrics.apiCallsUsed++;
        return githubData;

    } catch (error) {
        if (error.status === 404) {
            return { skip: true, reason: 'repo_not_found' };
        } else if (error.status === 403) {
            // Rate limit exceeded
            console.warn('⚠️  Rate limit hit, waiting 60s...');
            await sleep(60000);
            return await enrichWithFallback(model); // Retry once
        } else {
            metrics.errors.push({
                modelId: model.id,
                error: error.message
            });
            return { skip: true, reason: 'error', error: error.message };
        }
    }
}

/**
 * Update model with GitHub data
 */
async function updateModelGitHubData(modelId, githubData) {
    const escapedId = modelId.replace(/'/g, "''");
    const escapedCommit = (githubData.github_last_commit || '').replace(/'/g, "''");

    const sql = `
        UPDATE models
        SET github_stars = ${githubData.github_stars},
            github_forks = ${githubData.github_forks},
            github_last_commit = ${githubData.github_last_commit ? `'${escapedCommit}'` : 'NULL'},
            github_contributors = ${githubData.github_contributors || 0}
        WHERE id = '${escapedId}';
    `;

    if (!isDryRun) {
        await executeD1WithRetry(sql);
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
                        await updateModelGitHubData(model.id, result);
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
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
        if (metrics.errors.length > 5) {
            console.log(`   ... and ${metrics.errors.length - 5} more`);
        }
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
        console.log(`   Resets at: ${rateLimit.reset.toLocaleString()}`);

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
