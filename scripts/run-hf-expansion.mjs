/**
 * B.1 HuggingFace Full Expansion Runner
 * 
 * Runs fetchByPipelineTags to collect 150K+ models from HuggingFace.
 * Requires HF_TOKEN environment variable for authenticated requests.
 * 
 * Usage: 
 *   set HF_TOKEN=hf_xxx && node scripts/run-hf-expansion.mjs
 * 
 * Output: Saves results to temp_hf_expansion.json
 */

import { HuggingFaceAdapter } from './ingestion/adapters/huggingface-adapter.js';
import fs from 'fs';

const OUTPUT_FILE = 'temp_hf_expansion.json';

async function runFullExpansion() {
    console.log('='.repeat(70));
    console.log('B.1 HuggingFace Full Expansion');
    console.log('='.repeat(70));

    // Check HF_TOKEN
    const hasToken = !!process.env.HF_TOKEN;
    console.log(`\n🔑 HF_TOKEN: ${hasToken ? '✅ Available (10K req/hour)' : '❌ Missing (100 req/hour)'}`);

    if (!hasToken) {
        console.warn('⚠️ Running without HF_TOKEN may hit rate limits quickly.');
    }

    const adapter = new HuggingFaceAdapter();

    // Full expansion config
    const config = {
        limitPerTag: 5000,  // Max 5000 per tag
        full: false,        // Skip full details for initial scan
        // Using all 21 pipeline tags from hf-strategies.js
    };

    console.log('\n📋 Expansion Configuration:');
    console.log(`   Limit per tag: ${config.limitPerTag}`);
    console.log(`   Tags: 21 pipeline tags`);
    console.log(`   Target: 100K-150K unique models`);
    console.log(`   Full details: ${config.full}`);

    const startTime = Date.now();
    let result;

    try {
        console.log('\n🚀 Starting full expansion...\n');

        result = await adapter.fetchByPipelineTags(config);

        const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

        console.log('\n' + '='.repeat(70));
        console.log('📊 Expansion Results');
        console.log('='.repeat(70));
        console.log(`   Total models: ${result.models.length}`);
        console.log(`   Unique IDs: ${result.collectedIds.length}`);
        console.log(`   Duration: ${duration} minutes`);

        // Save results
        console.log(`\n💾 Saving to ${OUTPUT_FILE}...`);
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
            timestamp: new Date().toISOString(),
            count: result.models.length,
            unique_ids: result.collectedIds.length,
            duration_minutes: parseFloat(duration),
            models: result.models.map(m => ({
                id: m.modelId || m.id,
                likes: m.likes || 0,
                downloads: m.downloads || 0,
                pipeline_tag: m.pipeline_tag
            }))
        }, null, 2));

        console.log(`✅ Saved ${result.models.length} models to ${OUTPUT_FILE}`);

        // Top 10 by likes
        console.log('\n📈 Top 10 Models by Likes:');
        const sorted = [...result.models].sort((a, b) => (b.likes || 0) - (a.likes || 0));
        sorted.slice(0, 10).forEach((m, i) => {
            console.log(`   ${i + 1}. ${m.modelId || m.id} (${m.likes || 0} likes)`);
        });

        return { success: true, count: result.models.length };

    } catch (error) {
        console.error('\n❌ Expansion failed:', error.message);

        // Save partial results if any
        if (result?.models?.length > 0) {
            console.log(`💾 Saving partial results (${result.models.length} models)...`);
            fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
                timestamp: new Date().toISOString(),
                count: result.models.length,
                error: error.message,
                partial: true,
                models: result.models.map(m => ({
                    id: m.modelId || m.id,
                    likes: m.likes || 0
                }))
            }, null, 2));
        }

        return { success: false, error: error.message };
    }
}

// Run
runFullExpansion().then(result => {
    console.log('\n' + '='.repeat(70));
    if (result.success) {
        console.log(`✅ B.1 Expansion Complete: ${result.count} models collected`);
    } else {
        console.log(`❌ B.1 Expansion Failed: ${result.error}`);
    }
    process.exit(result.success ? 0 : 1);
});
