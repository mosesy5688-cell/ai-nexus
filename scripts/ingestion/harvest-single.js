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
        console.log(`   Fetching...`);
        let rawEntities = [];
        try {
            rawEntities = await adapter.fetch({ limit });
        } catch (fetchError) {
            console.error(`   ❌ Fetch error: ${fetchError.message}`);
            console.error(fetchError.stack);
            // Create empty batch file to avoid workflow failure
            rawEntities = [];
        }

        console.log(`   ✓ Fetched ${rawEntities.length} raw entities`);

        // Warn if no data
        if (rawEntities.length === 0) {
            console.warn(`   ⚠️ WARNING: No data fetched from ${sourceName}!`);
            console.warn(`   This may indicate rate limiting or API issues.`);
        }

        // Normalize
        console.log(`   Normalizing...`);
        const normalized = rawEntities.map((raw, i) => {
            try {
                return adapter.normalize(raw);
            } catch (e) {
                if (i < 5) console.warn(`   ⚠️ Normalize error [${i}]: ${e.message}`);
                return null;
            }
        }).filter(Boolean);
        console.log(`   ✓ Normalized ${normalized.length} entities`);

        // Physical Chunking V16.2.3: Lowered to 4000 to catch GitHub (heavy per-entity size)
        const CHUNK_SIZE = 4000;
        const results = { source: sourceName, total: normalized.length, chunks: [] };

        if (normalized.length <= CHUNK_SIZE) {
            const batchFile = path.join(OUTPUT_DIR, `raw_batch_${sourceName}.json`);
            await fs.writeFile(batchFile, JSON.stringify(normalized, null, 2));
            results.chunks.push(batchFile);
            console.log(`   ✓ Saved to: ${batchFile}`);
        } else {
            console.log(`   📦 Splitting into ${Math.ceil(normalized.length / CHUNK_SIZE)} chunks...`);
            for (let i = 0; i < normalized.length; i += CHUNK_SIZE) {
                const chunk = normalized.slice(i, i + CHUNK_SIZE);
                const chunkIndex = Math.floor(i / CHUNK_SIZE);
                const batchFile = path.join(OUTPUT_DIR, `raw_batch_${sourceName}_${chunkIndex}.json`);
                await fs.writeFile(batchFile, JSON.stringify(chunk, null, 2));
                results.chunks.push(batchFile);
                console.log(`   ✓ Chunk ${chunkIndex} saved to: ${batchFile}`);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ [Harvest] Complete`);
        console.log(`   Source: ${sourceName}`);
        console.log(`   Entities: ${normalized.length}`);
        console.log(`   Chunks: ${results.chunks.length}`);
        console.log(`   Time: ${duration}s`);

        return { source: sourceName, count: normalized.length, duration, chunks: results.chunks };
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

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
            limit = parseInt(args[i + 1], 10);
            i++;
        } else if (!args[i].startsWith('--')) {
            sourceName = args[i];
        }
    }

    if (!sourceName) {
        console.log('Usage: node harvest-single.js <source> [--limit N]');
        console.log(`Available sources: ${Object.keys(adapters).join(', ')}`);
        process.exit(1);
    }

    await harvestSingle(sourceName, { limit });
}

// Export for programmatic use
export { harvestSingle };

// Run if called directly
main().catch(console.error);
