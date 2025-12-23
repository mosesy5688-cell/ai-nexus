#!/usr/bin/env node
/**
 * L4 Promoter Runner V2.0 - AI Summary Generation
 * Constitution V6.x Compliant
 * 
 * B.19 Optimization: High-Priority Only
 * - Only processes entities with FNI > 50 OR downloads > 1000
 * - Daily schedule (previously every 6 hours)
 * - Processes up to 500 entities per run
 * - Idempotent: skips entities with existing summaries
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execPromise = util.promisify(exec);

config({ path: path.join(__dirname, '../.env') });

const DB_NAME = 'ai-nexus-db';

/**
 * Execute D1 query
 */
async function queryD1(sql) {
    const command = `npx wrangler d1 execute ${DB_NAME} --remote --json --command="${sql.replace(/"/g, '\\"')}"`;
    try {
        const { stdout } = await execPromise(command);
        const result = JSON.parse(stdout);
        return result[0]?.results || [];
    } catch (error) {
        console.error('D1 Query Error:', error.message);
        return [];
    }
}

/**
 * Get high-priority models without summary (idempotent)
 * B.19: Only top 10K entities (FNI > 50 OR downloads > 1000)
 */
async function getModelsWithoutSummary(limit = 500) {
    const sql = `SELECT umid, name, author, description, fni_score, downloads 
                 FROM models 
                 WHERE (seo_summary IS NULL OR seo_summary = '') 
                 AND name IS NOT NULL
                 AND (fni_score > 50 OR downloads > 1000)
                 ORDER BY COALESCE(fni_score, 0) DESC
                 LIMIT ${limit}`;
    return await queryD1(sql);
}

/**
 * Generate summary using Cloudflare AI (placeholder)
 * In production, this would call the Workers AI API
 */
async function generateSummary(model) {
    // For now, generate a template-based summary
    const name = model.name || 'AI Model';
    const author = model.author || 'Unknown';
    const desc = (model.description || '').substring(0, 200);

    return `${name} by ${author} is an open-source AI model. ${desc}`.trim();
}

/**
 * Update model with generated summary
 */
async function updateModelSummary(umid, summary) {
    const safeSummary = summary.replace(/'/g, "''");
    const sql = `UPDATE models SET seo_summary = '${safeSummary}', 
                 summary_generated_at = datetime('now') 
                 WHERE umid = '${umid}'`;
    await queryD1(sql);
}

/**
 * Main execution
 */
async function main() {
    console.log('🚀 L4 Promoter Starting...');

    // Parse limit from args
    const limitArg = process.argv.find(a => a.startsWith('--limit='));
    const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 500;

    console.log(`📊 Fetching up to ${limit} models without summary...`);
    const models = await getModelsWithoutSummary(limit);

    if (models.length === 0) {
        console.log('✅ No models need summaries. All caught up!');
        return;
    }

    console.log(`📝 Processing ${models.length} models...`);

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const model of models) {
        try {
            // Skip if somehow already has summary (double-check idempotency)
            if (model.seo_summary) {
                skipped++;
                continue;
            }

            const summary = await generateSummary(model);
            await updateModelSummary(model.umid, summary);
            processed++;

            // Rate limiting: 100ms between calls
            await new Promise(r => setTimeout(r, 100));

        } catch (error) {
            console.error(`❌ Failed: ${model.umid} - ${error.message}`);
            failed++;
            // Don't retry - next run will catch
        }
    }

    console.log(`\n✅ L4 Promoter Complete:`);
    console.log(`   Processed: ${processed}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Failed: ${failed}`);
}

main().catch(console.error);
