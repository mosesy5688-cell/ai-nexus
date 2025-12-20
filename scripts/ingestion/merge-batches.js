#!/usr/bin/env node
/**
 * merge-batches.js
 * 
 * Phase A.3: Merge batch files from parallel harvester jobs
 * Combines all raw_batch_*.json files into merged.json
 * 
 * Usage: node scripts/ingestion/merge-batches.js
 */

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = 'data';
const OUTPUT_FILE = 'data/merged.json';

/**
 * Merge all batch files into a single merged.json
 */
async function mergeBatches() {
    console.log('\n🔄 [Merge] Starting batch merge...');

    // Find all batch files
    const files = await fs.readdir(DATA_DIR);
    const batchFiles = files.filter(f => f.startsWith('raw_batch_') && f.endsWith('.json'));

    if (batchFiles.length === 0) {
        console.log('⚠️ No batch files found in data/');
        return { total: 0, sources: [] };
    }

    console.log(`   Found ${batchFiles.length} batch files`);

    const allEntities = [];
    const sourceStats = [];
    const seenIds = new Set();

    for (const file of batchFiles) {
        const filePath = path.join(DATA_DIR, file);
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const entities = JSON.parse(content);

            // Deduplicate by ID
            let added = 0;
            for (const entity of entities) {
                if (entity.id && !seenIds.has(entity.id)) {
                    seenIds.add(entity.id);
                    allEntities.push(entity);
                    added++;
                }
            }

            const sourceName = file.replace('raw_batch_', '').replace('.json', '');
            sourceStats.push({ source: sourceName, count: added, file });
            console.log(`   ✓ ${sourceName}: ${added} entities (${entities.length - added} duplicates skipped)`);
        } catch (error) {
            console.error(`   ❌ Error reading ${file}: ${error.message}`);
        }
    }

    // Write merged output
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(allEntities, null, 2));

    console.log(`\n✅ [Merge] Complete`);
    console.log(`   Total: ${allEntities.length} unique entities`);
    console.log(`   Sources: ${sourceStats.length}`);
    console.log(`   Output: ${OUTPUT_FILE}`);

    return { total: allEntities.length, sources: sourceStats };
}

// Run if called directly
mergeBatches().catch(console.error);

export { mergeBatches };
