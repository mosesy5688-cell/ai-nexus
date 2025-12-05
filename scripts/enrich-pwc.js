/**
 * Papers With Code Enrichment Script
 * 
 * Batch processes models to fetch benchmarks and SOTA rankings from Papers With Code.
 * 
 * Usage:
 *   node scripts/enrich-pwc.js [--limit 50] [--dry-run] [--remote] [--force]
 */

import { PwcEnricher } from '../src/lib/adapters/pwc-enricher.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT_DIR, 'data', 'models.json');

// Parse CLI arguments
const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 && args[limitArg + 1] ? parseInt(args[limitArg + 1]) : 50;
const DRY_RUN = args.includes('--dry-run');
const REMOTE = args.includes('--remote'); // If true, operate on remote D1; else local or just models.json
const FORCE = args.includes('--force'); // Reprocess even if already enriched

console.log('🚀 Starting Papers With Code Enrichment...');
console.log(`   Config: Limit=${LIMIT}, DryRun=${DRY_RUN}, Remote=${REMOTE}, Force=${FORCE}`);

/**
 * Execute a shell command (for D1 queries)
 */
async function runCommand(command) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, { shell: true });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', data => stdout += data.toString());
        proc.stderr.on('data', data => stderr += data.toString());

        proc.on('close', code => {
            if (code !== 0) reject(new Error(`Command failed with code ${code}: ${stderr}`));
            else resolve(stdout.trim());
        });
    });
}

/**
 * Get models from D1
 */
async function getModelsFromD1(limit = 100) {
    // We prioritize models that:
    // 1. Have ArXiv ID (higher chance of PWC data)
    // 2. Are not yet enriched (unless FORCE is on)

    // Note: In a real scenario we'd use a better SQL query. 
    // For now we fetch a batch of candidates.

    let query = `
        SELECT id, name, description, source_url, arxiv_id, pwc_sota_count 
        FROM models 
    `;

    if (!FORCE) {
        query += ` WHERE pwc_sota_count = 0 OR pwc_sota_count IS NULL `;
    } else {
        query += ` WHERE 1=1 `;
    }

    // Prioritize models with ArXiv IDs as they are most likely to match
    query += ` ORDER BY CASE WHEN arxiv_id IS NOT NULL THEN 0 ELSE 1 END, id DESC LIMIT ${limit}`;

    const flag = REMOTE ? '--remote' : '--local';
    const cmd = `npx wrangler d1 execute ai-nexus-db ${flag} --json --command "${query.replace(/"/g, '\\"')}"`;

    try {
        const output = await runCommand(cmd);
        const parsed = JSON.parse(output);
        // D1 execute returns array of results, usually [ { results: [], ... } ]
        if (Array.isArray(parsed) && parsed[0]?.results) {
            return parsed[0].results;
        }
        return [];
    } catch (error) {
        console.error('Failed to fetch models from D1:', error.message);
        return [];
    }
}

/**
 * Update model in D1
 */
async function updateModelInD1(id, data) {
    if (DRY_RUN) {
        console.log(`   [DRY-RUN] Would update model ${id} with:`, JSON.stringify(data).substring(0, 100) + '...');
        return;
    }

    // Prepare SQL update
    // We need to be careful with JSON arrays in SQL. SQLite stores them as TEXT.
    const benchmarksJson = JSON.stringify(data.pwc_benchmarks).replace(/'/g, "''");
    const tasksJson = JSON.stringify(data.pwc_tasks).replace(/'/g, "''");
    const datasetsJson = JSON.stringify(data.pwc_datasets).replace(/'/g, "''");

    const query = `
        UPDATE models SET 
            pwc_benchmarks = '${benchmarksJson}',
            pwc_tasks = '${tasksJson}',
            pwc_datasets = '${datasetsJson}',
            pwc_sota_count = ${data.pwc_sota_count}
        WHERE id = '${id}';
    `;

    const flag = REMOTE ? '--remote' : '--local';
    const cmd = `npx wrangler d1 execute ai-nexus-db ${flag} --command "${query.replace(/"/g, '\\"')}"`;

    await runCommand(cmd);
    console.log(`   ✅ Updated model ${id} in D1`);
}

/**
 * Main function
 */
async function main() {
    const enricher = new PwcEnricher();

    // 1. Fetch Candidates
    console.log('📦 Fetching candidate models from D1...');
    const models = await getModelsFromD1(LIMIT);
    console.log(`   Found ${models.length} candidate models.`);

    if (models.length === 0) {
        console.warn('   No models found needing enrichment. Exiting.');
        return;
    }

    let successes = 0;
    let failures = 0;

    // 2. Process Batch
    console.log('🔄 helping enrichment...');
    for (const model of models) {
        console.log(`   Processing: ${model.name} (ID: ${model.id}) [ArXiv: ${model.arxiv_id || 'N/A'}]`);

        try {
            const enrichmentData = await enricher.enrich(model);

            if (enrichmentData) {
                console.log(`     FOUND: ${enrichmentData.pwc_sota_count} SOTA rankings, ${enrichmentData.pwc_benchmarks.length} benchmarks`);
                await updateModelInD1(model.id, enrichmentData);
                successes++;
            } else {
                console.log('     No data found on Papers With Code.');
                failures++;
            }
        } catch (error) {
            console.error(`     ❌ Error processing ${model.id}:`, error.message);
            failures++;
        }

        // Slight delay to be nice to API
        await new Promise(r => setTimeout(r, 500));
    }

    console.log('\n📊 Summary:');
    console.log(`   Total Processed: ${models.length}`);
    console.log(`   Successes (Updated): ${successes}`);
    console.log(`   No Data / Failed: ${failures}`);
}

main().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
});
