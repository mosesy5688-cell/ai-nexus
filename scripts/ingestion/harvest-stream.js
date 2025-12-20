#!/usr/bin/env node
/**
 * harvest-stream.js
 * 
 * Phase A.2: Memory-efficient streaming harvester
 * Uses fetchStream for batch processing instead of loading all into memory.
 * 
 * Usage: node scripts/ingestion/harvest-stream.js [source] [--limit N]
 */

import { adapters } from './adapters/index.js';
import { promises as fs } from 'fs';
import path from 'path';

const BATCH_DIR = 'data/batches';

/**
 * Stream harvest from a single source
 * Writes batches to disk instead of accumulating in memory
 */
async function harvestStream(sourceName, options = {}) {
    const { limit = 10000, batchSize = 500 } = options;

    const adapter = adapters[sourceName];
    if (!adapter) {
        throw new Error(`Unknown source: ${sourceName}. Available: ${Object.keys(adapters).join(', ')}`);
    }

    // Ensure batch directory exists
    const sourceDir = path.join(BATCH_DIR, sourceName);
    await fs.mkdir(sourceDir, { recursive: true });

    console.log(`\n📥 [Stream Harvest] Starting ${sourceName}`);
    console.log(`   Batch size: ${batchSize}, Limit: ${limit}`);

    let totalEntities = 0;
    let batchNum = 0;
    const startTime = Date.now();

    try {
        // Use streaming fetch
        for await (const batch of adapter.fetchStream({ limit, batchSize })) {
            batchNum++;

            // Normalize batch
            const normalized = batch.map(raw => {
                try {
                    return adapter.normalize(raw);
                } catch (e) {
                    console.warn(`   ⚠️ Normalize error: ${e.message}`);
                    return null;
                }
            }).filter(Boolean);

            // Write batch to disk
            const batchFile = path.join(sourceDir, `batch_${String(batchNum).padStart(4, '0')}.json`);
            await fs.writeFile(batchFile, JSON.stringify(normalized, null, 2));

            totalEntities += normalized.length;
            console.log(`   ✓ Batch ${batchNum}: ${normalized.length} entities → ${batchFile}`);

            // Memory checkpoint
            const memUsage = process.memoryUsage();
            const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
            if (heapMB > 400) {
                console.log(`   ⚠️ Memory warning: ${heapMB}MB heap used`);
            }
        }
    } catch (error) {
        console.error(`   ❌ Stream error: ${error.message}`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ [Stream Harvest] Complete`);
    console.log(`   Source: ${sourceName}`);
    console.log(`   Total: ${totalEntities} entities in ${batchNum} batches`);
    console.log(`   Time: ${duration}s`);
    console.log(`   Output: ${sourceDir}/`);

    return { source: sourceName, total: totalEntities, batches: batchNum, duration };
}

/**
 * CLI Entry Point
 */
async function main() {
    const args = process.argv.slice(2);

    // Parse arguments
    let sourceName = null;
    let limit = 10000;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
            limit = parseInt(args[i + 1], 10);
            i++;
        } else if (!args[i].startsWith('--')) {
            sourceName = args[i];
        }
    }

    if (!sourceName) {
        console.log('Usage: node harvest-stream.js <source> [--limit N]');
        console.log(`Available sources: ${Object.keys(adapters).join(', ')}`);
        process.exit(1);
    }

    try {
        await harvestStream(sourceName, { limit });
    } catch (error) {
        console.error(`Fatal error: ${error.message}`);
        process.exit(1);
    }
}

// Export for programmatic use
export { harvestStream };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
