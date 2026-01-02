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
 * Phase 2: Top 1% models using fni_percentile (99+ = Top 1%)
 * Uses 'entities' table per V11 unified schema
 */
async function getModelsWithoutSummary(limit = 500) {
    const sql = `SELECT id, name, author, description, fni_score, fni_percentile 
                 FROM entities 
                 WHERE (seo_summary IS NULL OR seo_summary = '') 
                 AND name IS NOT NULL
                 AND type = 'model'
                 AND fni_percentile >= 99
                 ORDER BY COALESCE(fni_score, 0) DESC
                 LIMIT ${limit}`;
    return await queryD1(sql);
}

/**
 * Generate summary using Cloudflare Workers AI
 * Phase 2: Real AI generation with Llama 3 8B Instruct
 * Helios Decision: Strict extraction prompt, zero fabrication
 */
async function generateSummary(model) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    // Fallback to template if no API credentials
    if (!accountId || !apiToken) {
        console.log('⚠️ No API credentials, using template fallback');
        return generateTemplateSummary(model);
    }

    const name = model.name || 'AI Model';
    const author = model.author || 'Unknown';
    const desc = (model.description || '').substring(0, 300).replace(/\n/g, ' ').trim();

    // Helios-approved strict extraction prompt
    const prompt = `ROLE: You are a strict technical database administrator.
TASK: Summarize the AI model "${name}" created by "${author}".
INPUT DATA:
- Description Snippet: ${desc || 'N/A'}

CONSTRAINTS:
1. Output exactly ONE sentence.
2. Format: "[Model Name] is an AI model by [Author] designed for [Task], featuring [Key Feature]."
3. If specific details are missing, omit them. DO NOT HALLUCINATE.
4. Do not use promotional words like "best", "cutting-edge", "revolutionary".
5. Maximum 100 words.`;

    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/meta/llama-3-8b-instruct`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messages: [
                    { role: 'system', content: 'You are a factual technical writer. Never fabricate information.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 150
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.success && data.result?.response) {
            const summary = data.result.response.trim();
            // Validate response length
            if (summary.length > 20 && summary.length < 500) {
                return summary;
            }
        }

        // Fallback to template if AI response invalid
        return generateTemplateSummary(model);

    } catch (error) {
        console.error(`AI generation failed: ${error.message}, using template`);
        return generateTemplateSummary(model);
    }
}

/**
 * Template-based summary fallback (Phase 1)
 */
function generateTemplateSummary(model) {
    const name = model.name || 'AI Model';
    const author = model.author || 'Unknown';
    const desc = (model.description || '').substring(0, 200);
    return `${name} by ${author} is an open-source AI model. ${desc}`.trim();
}

/**
 * Update model with generated summary
 * Uses 'entities' table per V11 unified schema
 */
async function updateModelSummary(entityId, summary) {
    const safeSummary = summary.replace(/'/g, "''");
    const sql = `UPDATE entities SET seo_summary = '${safeSummary}', 
                 summary_generated_at = datetime('now') 
                 WHERE id = ${entityId}`;
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
            await updateModelSummary(model.id, summary);
            processed++;

            // Rate limiting: 100ms between calls
            await new Promise(r => setTimeout(r, 100));

        } catch (error) {
            console.error(`❌ Failed: ${model.id} - ${error.message}`);
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
