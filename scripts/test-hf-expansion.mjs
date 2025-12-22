/**
 * B.1 HuggingFace Pipeline Tag Collection Test
 * 
 * Tests the fetchByPipelineTags method with a small batch
 * before running full 150K expansion.
 * 
 * Usage: node scripts/test-hf-expansion.mjs
 */

import { HuggingFaceAdapter } from './ingestion/adapters/huggingface-adapter.js';

async function testPipelineTagCollection() {
    console.log('='.repeat(60));
    console.log('B.1 HuggingFace Pipeline Tag Collection Test');
    console.log('='.repeat(60));

    const adapter = new HuggingFaceAdapter();

    // Test with small limits first
    const testConfig = {
        limitPerTag: 10,  // Only 10 per tag for testing
        tags: [
            'text-generation',
            'text-classification',
            'text-to-image'
        ],
        full: false  // Skip full details for speed
    };

    console.log('\n📋 Test Configuration:');
    console.log(`   Tags: ${testConfig.tags.join(', ')}`);
    console.log(`   Limit per tag: ${testConfig.limitPerTag}`);
    console.log(`   Expected: ~${testConfig.tags.length * testConfig.limitPerTag} models`);

    try {
        console.log('\n🚀 Starting test collection...\n');

        const startTime = Date.now();
        const result = await adapter.fetchByPipelineTags(testConfig);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log('\n📊 Test Results:');
        console.log(`   Total models: ${result.models.length}`);
        console.log(`   Unique IDs: ${result.collectedIds.length}`);
        console.log(`   Duration: ${duration}s`);

        // Sample first 3 models
        console.log('\n📦 Sample models:');
        result.models.slice(0, 3).forEach((m, i) => {
            const id = m.modelId || m.id || 'unknown';
            const likes = m.likes || 0;
            console.log(`   ${i + 1}. ${id} (likes: ${likes})`);
        });

        console.log('\n✅ Test PASSED - fetchByPipelineTags working correctly');

        // Estimate full run
        const avgTimePerTag = duration / testConfig.tags.length;
        const fullTagCount = 21;
        const estimatedFullTime = (avgTimePerTag * fullTagCount).toFixed(0);
        console.log(`\n⏱️ Estimated full run (21 tags × 5000/tag):`);
        console.log(`   Time: ~${estimatedFullTime} seconds (~${(estimatedFullTime / 60).toFixed(1)} minutes)`);
        console.log(`   Expected models: 100K-150K unique`);

        return { success: true, count: result.models.length };

    } catch (error) {
        console.error('\n❌ Test FAILED:', error.message);
        return { success: false, error: error.message };
    }
}

// Run test
testPipelineTagCollection().then(result => {
    console.log('\n' + '='.repeat(60));
    process.exit(result.success ? 0 : 1);
});
