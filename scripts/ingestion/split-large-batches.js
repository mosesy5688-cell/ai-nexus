#!/usr/bin/env node
/**
 * split-large-batches.js
 * 
 * V7.3: Split large batch files into compliant chunks
 * - Max 5000 entities per batch
 * - Max 50MB per batch file
 * 
 * Constitution: Ensures L8 can process all batches within limits
 * 
 * Usage: node scripts/ingestion/split-large-batches.js
 */

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = 'data';
const MAX_ENTITIES_PER_BATCH = 5000;
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * Split large batch files into smaller compliant chunks
 */
async function splitLargeBatches() {
    console.log('\n🔄 [Split] Checking for oversized batches...');
    console.log(`   Max entities: ${MAX_ENTITIES_PER_BATCH}`);
    console.log(`   Max file size: ${MAX_FILE_SIZE_MB}MB`);

    const files = await fs.readdir(DATA_DIR);
    const batchFiles = files.filter(f => f.startsWith('raw_batch_') && f.endsWith('.json'));

    let splitCount = 0;
    let totalNewFiles = 0;

    for (const file of batchFiles) {
        const filePath = path.join(DATA_DIR, file);
        const stats = await fs.stat(filePath);

        // Check if file needs splitting
        const content = await fs.readFile(filePath, 'utf-8');
        const entities = JSON.parse(content);
        const fileSizeMB = stats.size / 1024 / 1024;

        const needsSplitBySize = stats.size > MAX_FILE_SIZE_BYTES;
        const needsSplitByCount = entities.length > MAX_ENTITIES_PER_BATCH;

        if (!needsSplitBySize && !needsSplitByCount) {
            console.log(`   ✓ ${file}: ${entities.length} entities, ${fileSizeMB.toFixed(1)}MB - OK`);
            continue;
        }

        console.log(`   ⚠️ ${file}: ${entities.length} entities, ${fileSizeMB.toFixed(1)}MB - SPLITTING...`);

        // Calculate optimal chunk size (use smaller of size or count limit)
        let chunkSize = MAX_ENTITIES_PER_BATCH;
        if (needsSplitBySize && entities.length > 0) {
            // Estimate entities per MB
            const entitiesPerMB = entities.length / fileSizeMB;
            const maxEntitiesForSize = Math.floor(entitiesPerMB * (MAX_FILE_SIZE_MB * 0.8)); // 80% safety margin
            chunkSize = Math.min(chunkSize, Math.max(1000, maxEntitiesForSize));
        }

        // Split into chunks
        const baseName = file.replace('raw_batch_', '').replace('.json', '');
        const chunks = [];
        for (let i = 0; i < entities.length; i += chunkSize) {
            chunks.push(entities.slice(i, i + chunkSize));
        }

        console.log(`      Splitting into ${chunks.length} chunks of ~${chunkSize} entities each`);

        // Write chunk files
        for (let i = 0; i < chunks.length; i++) {
            const chunkFileName = `raw_batch_${baseName}_${String(i + 1).padStart(3, '0')}.json`;
            const chunkPath = path.join(DATA_DIR, chunkFileName);
            await fs.writeFile(chunkPath, JSON.stringify(chunks[i], null, 2));
            console.log(`      ✓ ${chunkFileName}: ${chunks[i].length} entities`);
            totalNewFiles++;
        }

        // Remove original oversized file
        await fs.unlink(filePath);
        console.log(`      🗑️ Removed original: ${file}`);
        splitCount++;
    }

    console.log(`\n✅ [Split] Complete`);
    console.log(`   Batches split: ${splitCount}`);
    console.log(`   New files created: ${totalNewFiles}`);

    return { splitCount, totalNewFiles };
}

// Run if called directly
splitLargeBatches().catch(console.error);

export { splitLargeBatches };
