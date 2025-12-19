/**
 * V6.2 Datasets Harvester
 * 
 * Standalone script to harvest HuggingFace Datasets
 * Used by loop1-harvester.yml workflow
 * 
 * Usage: node scripts/harvest-datasets.js [--limit=500]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import DatasetsAdapter from './ingestion/adapters/datasets-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Output paths
const OUTPUT_DIR = path.join(__dirname, '../data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'datasets.json');

async function harvestDatasets() {
    console.log('═'.repeat(60));
    console.log('🚀 V6.2 Datasets Harvester');
    console.log('═'.repeat(60));

    // Parse command line args
    const args = process.argv.slice(2);
    const limitArg = args.find(a => a.startsWith('--limit='));
    const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 500;

    // Initialize adapter
    const adapter = new DatasetsAdapter();
    console.log(`\n📦 Using Datasets Adapter`);
    console.log(`   HF_TOKEN: ${process.env.HF_TOKEN ? '✓ Set' : '✗ Not set'}`);
    console.log(`   Limit: ${limit} datasets`);

    // Fetch datasets
    console.log('\n📥 Fetching datasets from HuggingFace...');
    const rawDatasets = await adapter.fetch({ limit, full: true });
    console.log(`   Got ${rawDatasets.length} raw datasets`);

    // Normalize
    console.log('\n🔄 Normalizing to UnifiedEntity...');
    const normalizedDatasets = [];
    for (const raw of rawDatasets) {
        try {
            const entity = adapter.normalize(raw);
            normalizedDatasets.push(entity);
        } catch (error) {
            console.warn(`   ⚠️ Error normalizing dataset: ${error.message}`);
        }
    }
    console.log(`   Normalized ${normalizedDatasets.length} datasets`);

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Save output
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(normalizedDatasets, null, 2));
    console.log(`\n💾 Saved to ${OUTPUT_FILE}`);

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('📊 Harvest Summary:');
    console.log(`   Total datasets: ${normalizedDatasets.length}`);
    console.log(`   Approved: ${normalizedDatasets.filter(d => d.compliance_status === 'approved').length}`);
    console.log(`   With downloads: ${normalizedDatasets.filter(d => d.downloads > 0).length}`);
    console.log('═'.repeat(60));

    return normalizedDatasets;
}

harvestDatasets().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
