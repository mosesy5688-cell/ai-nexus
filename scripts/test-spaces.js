/**
 * Test Script: Spaces Adapter (V6.2)
 * 
 * Dry-run test for the new fetchSpaces() method
 * Usage: node scripts/test-spaces.js [--limit=5]
 */

import { HuggingFaceAdapter } from './ingestion/adapters/huggingface-adapter.js';

async function testSpacesAdapter() {
    console.log('═'.repeat(60));
    console.log('🧪 V6.2 Spaces Adapter Test');
    console.log('═'.repeat(60));

    // Parse command line args
    const args = process.argv.slice(2);
    const limitArg = args.find(a => a.startsWith('--limit='));
    const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 5;

    // Initialize adapter
    const adapter = new HuggingFaceAdapter();
    console.log('\n📦 Adapter initialized');
    console.log(`   Entity types: ${adapter.entityTypes.join(', ')}`);
    console.log(`   HF_TOKEN: ${adapter.hfToken ? '✓ Set' : '✗ Not set'}`);

    // Test 1: Fetch spaces list (no full details)
    console.log('\n─'.repeat(60));
    console.log(`🔍 Test 1: Fetch ${limit} spaces (list only)...`);

    try {
        const spaces = await adapter.fetchSpaces({ limit, full: false });
        console.log(`   ✅ Got ${spaces.length} spaces`);

        if (spaces.length > 0) {
            console.log('\n   Sample space:');
            const sample = spaces[0];
            console.log(`     ID: ${sample.id}`);
            console.log(`     Likes: ${sample.likes || 0}`);
            console.log(`     SDK: ${sample.sdk || 'unknown'}`);
        }
    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
    }

    // Test 2: Fetch full space details
    console.log('\n─'.repeat(60));
    console.log(`🔍 Test 2: Fetch ${Math.min(limit, 3)} spaces (with full details)...`);

    try {
        const fullSpaces = await adapter.fetchSpaces({ limit: Math.min(limit, 3), full: true });
        console.log(`   ✅ Got ${fullSpaces.length} complete spaces`);

        if (fullSpaces.length > 0) {
            console.log('\n   Sample full space:');
            const sample = fullSpaces[0];
            console.log(`     ID: ${sample.id}`);
            console.log(`     Has README: ${sample.readme ? 'yes (' + sample.readme.length + ' chars)' : 'no'}`);
            console.log(`     Runtime: ${sample.runtime?.stage || 'unknown'}`);
        }
    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
    }

    // Test 3: Normalize a space
    console.log('\n─'.repeat(60));
    console.log('🔍 Test 3: Normalize space to UnifiedEntity...');

    try {
        const fullSpaces = await adapter.fetchSpaces({ limit: 1, full: true });
        if (fullSpaces.length > 0) {
            const normalized = adapter.normalizeSpace(fullSpaces[0]);
            console.log('   ✅ Normalized entity:');
            console.log(`     ID: ${normalized.id}`);
            console.log(`     Type: ${normalized.type}`);
            console.log(`     Source: ${normalized.source}`);
            console.log(`     Author: ${normalized.author}`);
            console.log(`     SDK: ${normalized.sdk}`);
            console.log(`     Quality Score: ${normalized.quality_score}`);
            console.log(`     Compliance: ${normalized.compliance_status}`);
        }
    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('✅ Spaces Adapter Test Complete');
    console.log('═'.repeat(60));
}

testSpacesAdapter().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
