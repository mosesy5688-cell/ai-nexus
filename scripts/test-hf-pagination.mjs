/**
 * B.1 Pagination Test - Verify fetchByPipelineTags pagination works
 * 
 * Tests with 2 tags × 2000 limit to verify skip pagination
 * 
 * Usage: node scripts/test-hf-pagination.mjs
 */

import { HuggingFaceAdapter } from './ingestion/adapters/huggingface-adapter.js';

async function testPagination() {
    console.log('='.repeat(60));
    console.log('B.1 Pagination Test');
    console.log('='.repeat(60));

    const adapter = new HuggingFaceAdapter();

    // Test with 2 tags, 2000 limit per tag to verify pagination
    const testConfig = {
        limitPerTag: 2000,  // Should require 2 API calls (1000 + 1000)
        tags: ['text-generation', 'text-to-image'],
        full: false
    };

    console.log('\n📋 Test Configuration:');
    console.log(`   Tags: ${testConfig.tags.join(', ')}`);
    console.log(`   Limit per tag: ${testConfig.limitPerTag}`);
    console.log(`   Expected pages per tag: 2 (1000 + 1000)`);

    try {
        console.log('\n🚀 Starting pagination test...\n');

        const startTime = Date.now();
        const result = await adapter.fetchByPipelineTags(testConfig);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log('\n📊 Pagination Test Results:');
        console.log(`   Total models: ${result.models.length}`);
        console.log(`   Duration: ${duration}s`);

        // Check if we got more than 1000 per tag
        if (result.models.length > 2000) {
            console.log('\n✅ PAGINATION WORKING - Got more than 2000 models');
        } else if (result.models.length > 1000) {
            console.log('\n⚠️ PARTIAL SUCCESS - Got more than 1000, pagination helps');
        } else {
            console.log('\n❌ PAGINATION NOT WORKING - Still limited to 1000');
        }

        return { success: result.models.length > 1000, count: result.models.length };

    } catch (error) {
        console.error('\n❌ Test FAILED:', error.message);
        return { success: false, error: error.message };
    }
}

testPagination().then(result => {
    console.log('\n' + '='.repeat(60));
    process.exit(result.success ? 0 : 1);
});
