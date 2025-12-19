/**
 * V6.2 Spaces Harvester
 * 
 * Standalone script to harvest HuggingFace Spaces
 * Used by loop1-harvester.yml workflow
 * 
 * Usage: node scripts/harvest-spaces.js [--limit=200]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HuggingFaceAdapter } from './ingestion/adapters/huggingface-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Output paths
const OUTPUT_DIR = path.join(__dirname, '../data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'spaces.json');

async function harvestSpaces() {
    console.log('═'.repeat(60));
    console.log('🚀 V6.2 Spaces Harvester');
    console.log('═'.repeat(60));

    // Parse command line args
    const args = process.argv.slice(2);
    const limitArg = args.find(a => a.startsWith('--limit='));
    const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 200;

    // Initialize adapter
    const adapter = new HuggingFaceAdapter();
    console.log(`\n📦 Using HuggingFace Adapter`);
    console.log(`   HF_TOKEN: ${adapter.hfToken ? '✓ Set' : '✗ Not set'}`);
    console.log(`   Limit: ${limit} spaces`);

    // Fetch spaces
    console.log('\n📥 Fetching spaces from HuggingFace...');
    const rawSpaces = await adapter.fetchSpaces({ limit, full: true });
    console.log(`   Got ${rawSpaces.length} raw spaces`);

    // Normalize
    console.log('\n🔄 Normalizing to UnifiedEntity...');
    const normalizedSpaces = [];
    for (const raw of rawSpaces) {
        try {
            const entity = adapter.normalizeSpace(raw);
            normalizedSpaces.push(entity);
        } catch (error) {
            console.warn(`   ⚠️ Error normalizing space: ${error.message}`);
        }
    }
    console.log(`   Normalized ${normalizedSpaces.length} spaces`);

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Save output
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(normalizedSpaces, null, 2));
    console.log(`\n💾 Saved to ${OUTPUT_FILE}`);

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('📊 Harvest Summary:');
    console.log(`   Total spaces: ${normalizedSpaces.length}`);
    console.log(`   Approved: ${normalizedSpaces.filter(s => s.compliance_status === 'approved').length}`);
    console.log(`   Running: ${normalizedSpaces.filter(s => s.running_status === 'RUNNING').length}`);
    console.log('═'.repeat(60));

    return normalizedSpaces;
}

harvestSpaces().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
