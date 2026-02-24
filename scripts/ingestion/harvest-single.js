#!/usr/bin/env node
/**
 * harvest-single.js
 * 
 * Phase A.3: Single-source harvester for parallel workflow execution
 * Called by parallel L1 jobs to harvest one source at a time.
 * 
 * Usage: node scripts/ingestion/harvest-single.js <source> [--limit N]
 */

import { adapters } from './adapters/index.js';
import { promises as fs } from 'fs';
import path from 'path';

const OUTPUT_DIR = 'data';

/**
 * Harvest from a single source and save to a batch file
 */
async function harvestSingle(sourceName, options = {}) {
    const { limit = 10000 } = options;

    const adapter = adapters[sourceName];
    if (!adapter) {
        console.error(`❌ Unknown source: ${sourceName}`);
        console.log(`Available sources: ${Object.keys(adapters).join(', ')}`);
        process.exit(1);
    }

    console.log(`\n📥 [Harvest] Source: ${sourceName}`);
    console.log(`   Limit: ${limit}`);

    const startTime = Date.now();

    try {
        // Ensure output directory exists
        await fs.mkdir(OUTPUT_DIR, { recursive: true });

        // Fetch from source
        console.log(`   Fetching ${limit} entities (Shard ${shard}/${totalShards})...`);
        // Memory Hardening: Adjust chunk size based on source weight
        // ArXiv is "Heavy" due to full-text HTML extraction (can be 2MB+ per paper)
        // HuggingFace is "Medium" (READMEs can be long)
        const HEAVY_SOURCES = ['arxiv', 'semanticscholar'];
        const CHUNK_SIZE = HEAVY_SOURCES.includes(sourceName) ? 200 : 1500;

        const results = { source: sourceName, total: 0, chunks: [] };
        let currentChunk = [];
        let chunkIndex = 0;

        // V17.5 Memory Protection: Provide an `onBatch` callback to adapters that support streaming
        // This prevents 100K Full-Text HTML entities from accumulating in RAM before chunking.
        const processBatch = async (rawBatch) => {
            for (let i = 0; i < rawBatch.length; i++) {
                try {
                    const norm = adapter.normalize(rawBatch[i]);
                    if (norm) {
                        currentChunk.push(norm);
                        results.total++;
                    }
                } catch (e) {
                    if (results.total < 5) console.warn(`   ⚠️ Normalize error [${results.total}]: ${e.message}`);
                }

                rawBatch[i] = null; // Free raw object

                // Write chunk to disk if it reaches the limit
                if (currentChunk.length >= CHUNK_SIZE) {
                    const batchFile = path.join(OUTPUT_DIR, `raw_batch_${sourceName}_s${shard}_c${chunkIndex}.json`);
                    // V22.1 Optimization: Disable pretty-printing to save 30% memory/disk
                    await fs.writeFile(batchFile, JSON.stringify(currentChunk));
                    results.chunks.push(batchFile);
                    console.log(`   ✓ Chunk ${chunkIndex} saved to: ${batchFile} (${currentChunk.length} entities)`);

                    // V19.5 Hardening: Aggressive GC for high-volume jobs
                    currentChunk = [];
                    chunkIndex++;

                    if (global.gc) {
                        try { global.gc(); } catch (e) { }
                    }
                }
            }
        };

        const fetchOptions = {
            limit,
            onBatch: processBatch,
            shard,
            totalShards
        };

        let rawEntities = [];
        try {
            rawEntities = await adapter.fetch(fetchOptions);
        } catch (fetchError) {
            console.error(`   ❌ Fetch error: ${fetchError.message}`);
            console.error(fetchError.stack);
            rawEntities = [];
        }

        // For backward compatibility: if adapter doesn't use `onBatch`, it returns the full array.
        if (rawEntities && rawEntities.length > 0) {
            console.log(`   ✓ Adapter returned ${rawEntities.length} buffered entities. Normalizing synchronously...`);
            await processBatch(rawEntities);
            rawEntities = [];
            if (global.gc) global.gc();
        }

        // Write any remaining items
        if (currentChunk.length > 0) {
            const batchFile = path.join(OUTPUT_DIR, `raw_batch_${sourceName}_s${shard}_c${chunkIndex}.json`);
            await fs.writeFile(batchFile, JSON.stringify(currentChunk));
            results.chunks.push(batchFile);
            console.log(`   ✓ Final chunk saved to: ${batchFile}`);
            currentChunk = [];
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ [Harvest] Complete`);
        console.log(`   Source: ${sourceName}`);
        console.log(`   Entities: ${results.total}`);
        console.log(`   Chunks: ${results.chunks.length}`);
        console.log(`   Time: ${duration}s`);

        return { source: sourceName, count: results.total, duration, chunks: results.chunks };

    } catch (error) {
        console.error(`\n❌ [Harvest] Failed: ${error.message}`);
        console.error(error.stack);

        // Create empty batch file to avoid downstream errors
        const batchFile = path.join(OUTPUT_DIR, `raw_batch_${sourceName}.json`);
        await fs.writeFile(batchFile, JSON.stringify([], null, 2));
        console.log(`   Created empty batch file: ${batchFile}`);

        return { source: sourceName, count: 0, duration: 0, file: batchFile, error: error.message };
    }
}

/**
 * CLI Entry Point
 */
async function main() {
    const args = process.argv.slice(2);

    // Parse arguments
    let sourceName = null;
    let limit = 10000;
    let shard = 0;
    let totalShards = 1;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
            limit = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--shard' && args[i + 1]) {
            shard = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--total-shards' && args[i + 1]) {
            totalShards = parseInt(args[i + 1], 10);
            i++;
        } else if (!args[i].startsWith('--')) {
            sourceName = args[i];
        }
    }

    if (!sourceName) {
        console.log('Usage: node harvest-single.js <source> [--limit N] [--shard S] [--total-shards T]');
        console.log(`Available sources: ${Object.keys(adapters).join(', ')}`);
        process.exit(1);
    }

    await harvestSingle(sourceName, { limit, shard, totalShards });
}

// Export for programmatic use
export { harvestSingle };

// Run if called directly
main().catch(console.error);
