/**
 * Single-Source Harvester V22.2 (Industrial Stability Edition)
 * 
 * V22.1: Reverted matrix sharding for stability. 4-job parallel core.
 * V22.2: Added buffer water-level logging and Kaggle CLI stability fixes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import adapters from './adapters/index.js';

const OUTPUT_DIR = 'data';

/**
 * Harvest from a single source and save chunks
 */
async function harvestSingle(sourceName, options = {}) {
    const { limit = 10000 } = options;
    const adapter = adapters[sourceName];

    if (!adapter) {
        throw new Error(`Adapter for source "${sourceName}" not found`);
    }

    console.log(`\n📥 [Harvest] Source: ${sourceName}`);
    console.log(`   Limit: ${limit}`);

    const startTime = Date.now();

    try {
        // Ensure output directory exists
        await fs.mkdir(OUTPUT_DIR, { recursive: true });

        // Fetch from source
        console.log(`   Fetching ${limit} entities...`);
        // Memory Hardening: Adjust chunk size based on source weight
        const HEAVY_SOURCES = ['arxiv', 'semanticscholar'];
        const CHUNK_SIZE = HEAVY_SOURCES.includes(sourceName) ? 200 : 1500;

        const results = { source: sourceName, total: 0, failed: 0, chunks: [] };
        let currentChunk = [];
        let chunkIndex = 0;

        // V17.5 Memory Protection: Streaming processor
        const processBatch = async (rawBatch) => {
            const batchAttempted = rawBatch.length;

            for (let i = 0; i < rawBatch.length; i++) {
                try {
                    const norm = adapter.normalize(rawBatch[i]);
                    // V22.2 Memory Hardening: Truncate full_html to prevent OOM
                    const MAX_HTML_SIZE = 500000;
                    if (norm && norm.full_html) {
                        norm.full_html = (norm.full_html.length > MAX_HTML_SIZE)
                            ? norm.full_html.substring(0, MAX_HTML_SIZE) + '\n\n[Full-text truncated for memory safety...]'
                            : norm.full_html;
                    }

                    if (norm) {
                        currentChunk.push(norm);
                        results.total++;
                    } else {
                        results.failed++;
                    }
                } catch (e) {
                    results.failed++;
                    if (results.total < 5) console.warn(`   ⚠️ Normalize error [${results.total}]: ${e.message}`);
                }

                rawBatch[i] = null; // Free memory

                // Write chunk to disk if it reaches the limit
                if (currentChunk.length >= CHUNK_SIZE) {
                    const batchFile = path.join(OUTPUT_DIR, `raw_batch_${sourceName}_c${chunkIndex}.json`);
                    await fs.writeFile(batchFile, JSON.stringify(currentChunk));
                    results.chunks.push(batchFile);
                    console.log(`   ✓ Chunk ${chunkIndex} saved to: ${batchFile} (${currentChunk.length} entities)`);

                    currentChunk = [];
                    chunkIndex++;

                    if (global.gc) {
                        try { global.gc(); } catch (e) { }
                    }
                }
            }

            // Periodic buffer report
            if (results.total % 100 === 0 || batchAttempted > 50) {
                console.log(`   📊 Buffer Status: ${currentChunk.length}/${CHUNK_SIZE} (Total valid: ${results.total}, Failed: ${results.failed})`);
            }
        };

        const fetchOptions = {
            limit,
            onBatch: processBatch
        };

        let rawEntities = [];
        try {
            rawEntities = await adapter.fetch(fetchOptions);
        } catch (fetchError) {
            console.error(`   ❌ Fetch error: ${fetchError.message}`);
            rawEntities = [];
        }

        // Backward compatibility for non-streaming adapters
        if (rawEntities && rawEntities.length > 0) {
            console.log(`   ✓ Adapter returned ${rawEntities.length} buffered entities. Normalizing...`);
            await processBatch(rawEntities);
            rawEntities = [];
        }

        // Write Final chunk
        if (currentChunk.length > 0) {
            const batchFile = path.join(OUTPUT_DIR, `raw_batch_${sourceName}_c${chunkIndex}.json`);
            await fs.writeFile(batchFile, JSON.stringify(currentChunk));
            results.chunks.push(batchFile);
            console.log(`   ✓ Final chunk saved to: ${batchFile}`);
            currentChunk = [];
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ [Harvest] Complete`);
        console.log(`   Source: ${sourceName} | Entities: ${results.total} | Chunks: ${results.chunks.length} | Time: ${duration}s`);

        return { source: sourceName, count: results.total, duration, chunks: results.chunks };

    } catch (error) {
        console.error(`\n❌ [Harvest] Failed: ${error.message}`);
        return { source: sourceName, count: 0, error: error.message };
    }
}

/**
 * CLI Entry Point
 */
async function main() {
    const args = process.argv.slice(2);
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
        process.exit(1);
    }

    await harvestSingle(sourceName, { limit });
}

main().catch(console.error);
