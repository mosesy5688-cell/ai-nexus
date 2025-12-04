/**
 * GitHub Data Enrichment Script
 * 
 * Enriches existing models in D1 database with GitHub repository statistics.
 * Processes models in batches with proper rate limiting and error handling.
 * 
 * Usage:
 *   node scripts/enrich-github.js [--local] [--limit=100] [--dry-run]
 * 
 * Options:
 *   --local     Use local D1 database
 *   --limit=N   Process only N models (default: all)
 *   --dry-run   Show what would be done without making changes
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
    DELAY_BETWEEN_BATCHES_MS: 2000,
};

// Parse command line arguments
const args = process.argv.slice(2);
const isLocal = args.includes('--local');
const isDryRun = args.includes('--dry-run');
const limitMatch = args.find(arg => arg.startsWith('--limit='));
const limit = limitMatch ? parseInt(limitMatch.split('=')[1]) : null;

/**
 * Execute SQL on D1 via Wrangler
 */
async function executeD1(sql) {
    const tempFile = path.join(__dirname, `temp_enrich_${Date.now()}.sql`);
    fs.writeFileSync(tempFile, sql);

    const targetFlag = isLocal ? '--local' : '--remote';
    const command = `npx wrangler d1 execute ${CONFIG.DB_NAME} ${targetFlag} --file "${tempFile}"`;

    try {
        const { stdout } = await execPromise(command);
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
        return stdout;
    } catch (error) {
        console.error(`❌ D1 Error: ${error.message}`);
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
        throw error;
    }
}

/**
 * Query D1 and return JSON results
 * NOTE: Using --command instead of --file because --file returns statistics instead of data
 */
async function queryD1(sql) {
    const targetFlag = isLocal ? '--local' : '--remote';
    // Make SQL single line and escape it
    const singleLineSQL = sql.replace(/\s+/g, ' ').trim();
    const escapedSQL = singleLineSQL.replace(/"/g, '\\"');
    const command = `npx wrangler d1 execute ${CONFIG.DB_NAME} ${targetFlag} --json --command="${escapedSQL}"`;

    try {
        const { stdout } = await execPromise(command);

        // Find the JSON array in output (starts with [ and ends with ])
        const jsonStart = stdout.indexOf('[');
        const jsonEnd = stdout.lastIndexOf(']') + 1;

        if (jsonStart === -1 || jsonEnd === 0) {
            throw new Error('No JSON array found in wrangler response');
        }

        const jsonStr = stdout.substring(jsonStart, jsonEnd);
        const result = JSON.parse(jsonStr);

        // Wrangler returns array with results[0].results containing the data
        return result[0]?.results || [];
    } catch (error) {
        console.error(`❌ Query Error: ${error.message}`);
        throw error;
    }
}

/**
 * Fetch models that need GitHub enrichment
 */
async function fetchModelsForEnrichment() {
    const limitClause = limit ? `LIMIT ${limit}` : '';

    const sql = `
        SELECT id, name, author, source_url
        FROM models
        WHERE source_url IS NOT NULL 
          AND source_url LIKE '%github.com%'
        ORDER BY downloads DESC
        ${limitClause};
    `;

    return await queryD1(sql);
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
            github_last_commit = '${escapedCommit}',
            github_contributors = ${githubData.github_contributors || 0}
        WHERE id = '${escapedId}';
    `;

    if (!isDryRun) {
        await executeD1(sql);
    }
}

/**
 * Sleep function
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main enrichment process
 */
async function main() {
    console.log('🚀 GitHub Data Enrichment Script');
    console.log(`📍 Target: ${isLocal ? 'LOCAL' : 'REMOTE'} database`);
    console.log(`🔍 Dry run: ${isDryRun ? 'YES' : 'NO'}`);
    console.log(`📊 Limit: ${limit || 'NONE'}`);
    console.log('');

    // Step 1: Check rate limit
    console.log('⏳ Checking GitHub API rate limit...');
    const rateLimit = await checkRateLimit();
    if (rateLimit) {
        console.log(`✅ Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining`);
        console.log(`   Resets at: ${rateLimit.reset.toLocaleString()}`);

        if (rateLimit.remaining < 100) {
            console.warn(`⚠️  WARNING: Low rate limit. Consider waiting until ${rateLimit.reset.toLocaleString()}`);
        }
    }
    console.log('');

    // Step 2: Fetch models
    console.log('📥 Fetching models for enrichment...');
    const models = await fetchModelsForEnrichment();
    console.log(`✅ Found ${models.length} models with GitHub source URLs\n`);

    if (models.length === 0) {
        console.log('✅ No models need enrichment. Exiting.');
        return;
    }

    // Step 3: Process in batches
    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;

    for (let i = 0; i < models.length; i += CONFIG.BATCH_SIZE) {
        const batch = models.slice(i, i + CONFIG.BATCH_SIZE);
        const batchNum = Math.floor(i / CONFIG.BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(models.length / CONFIG.BATCH_SIZE);

        console.log(`\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} models)...`);

        for (const model of batch) {
            try {
                const ownerRepo = extractOwnerRepo(model.source_url);
                if (!ownerRepo) {
                    console.log(`⏭️  Skipping ${model.id}: Not a valid GitHub URL`);
                    skipCount++;
                    continue;
                }

                const githubData = await enrichModelWithGitHub(model);

                if (!githubData) {
                    console.log(`❌ Failed to enrich ${model.id}`);
                    failCount++;
                    continue;
                }

                if (isDryRun) {
                    console.log(`🔍 [DRY RUN] Would update ${model.id}:`);
                    console.log(`   Stars: ${githubData.github_stars}, Forks: ${githubData.github_forks}`);
                } else {
                    await updateModelGitHubData(model.id, githubData);
                    console.log(`✅ Updated ${model.id}: ${githubData.github_stars}⭐ ${githubData.github_forks}🔀`);
                }

                successCount++;
                await sleep(500);

            } catch (error) {
                console.error(`❌ Error processing ${model.id}:`, error.message);
                failCount++;
            }
        }

        if (i + CONFIG.BATCH_SIZE < models.length) {
            console.log(`⏳ Waiting ${CONFIG.DELAY_BETWEEN_BATCHES_MS}ms before next batch...`);
            await sleep(CONFIG.DELAY_BETWEEN_BATCHES_MS);
        }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 ENRICHMENT SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Success: ${successCount}`);
    console.log(`❌ Failed:  ${failCount}`);
    console.log(`⏭️  Skipped: ${skipCount}`);
    console.log(`📝 Total:   ${models.length}`);
    console.log('='.repeat(60));

    if (isDryRun) {
        console.log('\n💡 This was a dry run. Use without --dry-run to actually update the database.');
    }
}

main().catch(console.error);
