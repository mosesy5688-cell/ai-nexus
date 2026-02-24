/**
 * Single-Source Harvester V22.2 (Industrial Stability Edition)
 * 
 * V22.1: Reverted matrix sharding for stability. 4-job parallel core.
 * V22.2: Added buffer water-level logging and Kaggle CLI stability fixes.
 */

import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import adapters from './adapters/index.js';
import { shardNDJSON } from './ndjson-sharder.js';
import { RateLimitExceededError } from './adapters/base-adapter.js';

const OUTPUT_DIR = 'data';

/**
 * Harvest from a single source and save as lossless NDJSON stream
 * V22.3: Streaming Ingestion (OOM Protection)
 */
async function harvestSingle(sourceName, options = {}) {
    const { limit = 10000, chunkSize = 500, skipBridge = false } = options;
    const adapter = adapters[sourceName];

    if (!adapter) {
        throw new Error(`Adapter for source "${sourceName}" not found`);
    }

    console.log(`\n📥 [Harvest] Source: ${sourceName} (Streaming Mode)`);
    console.log(`   Limit: ${limit}`);

    const startTime = Date.now();
    const ndjsonPath = path.join(OUTPUT_DIR, `${sourceName}_master.ndjson`);

    try {
        // Ensure output directory exists
        await mkdir(OUTPUT_DIR, { recursive: true });

        // Open Writable Stream
        const writeStream = fs.createWriteStream(ndjsonPath, { flags: 'a' });
        console.log(`   Writing to: ${ndjsonPath}`);

        const results = { source: sourceName, total: 0, failed: 0 };

        // V22.3 NDJSON Streaming Processor
        const processBatch = async (rawBatch) => {
            for (let i = 0; i < rawBatch.length; i++) {
                try {
                    const norm = adapter.normalize(rawBatch[i]);

                    if (norm) {
                        // V22.3: LOSSLESS capture. Truncation is FORBIDDEN here.
                        // V22.3: Implement Backpressure (OOM Protection for write buffer)
                        const canWrite = writeStream.write(JSON.stringify(norm) + '\n');

                        if (!canWrite) {
                            // High water mark reached, wait for drain
                            await new Promise(resolve => writeStream.once('drain', resolve));
                        }

                        results.total++;
                    } else {
                        results.failed++;
                    }
                } catch (e) {
                    results.failed++;
                    if (results.total < 5) console.warn(`   ⚠️ Normalize error [${results.total}]: ${e.message}`);
                }

                rawBatch[i] = null; // Memory Hint
            }

            if (results.total % 100 === 0) {
                console.log(`   📊 Ingested: ${results.total} | Failed: ${results.failed} | Mem: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
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
            if (fetchError instanceof RateLimitExceededError) {
                console.warn(`\n🛑 [Harvest] ${fetchError.message}`);
                console.warn(`   ⚠️ Finishing early with ${results.total} entities to preserve CI throughput.`);
            } else {
                console.error(`   ❌ Fetch error: ${fetchError.message}`);
            }
            rawEntities = [];
        }

        // Backward compatibility for non-streaming adapters
        if (rawEntities && rawEntities.length > 0) {
            console.log(`   ✓ Adapter returned ${rawEntities.length} buffered entities. Streaming to disk...`);
            await processBatch(rawEntities);
            rawEntities = [];
        }

        // Finalize stream
        await new Promise((resolve) => writeStream.end(resolve));

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ [Harvest] Complete`);
        console.log(`   Source: ${sourceName} | Total: ${results.total} | Time: ${duration}s`);
        console.log(`   Output: ${ndjsonPath}`);

        // V22.3 Bridge: Automatic Conversion to JSON Shards
        if (!skipBridge && results.total > 0) {
            console.log(`\n🌉 [Bridge] Initiating format conversion...`);
            await shardNDJSON(ndjsonPath, OUTPUT_DIR, {
                chunkSize,
                prefix: sourceName
            });
        }

        return { source: sourceName, count: results.total, duration, file: ndjsonPath };

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
    let chunkSize = 500;
    let skipBridge = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
            limit = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--chunk-size' && args[i + 1]) {
            chunkSize = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--no-bridge') {
            skipBridge = true;
        } else if (!args[i].startsWith('--') && !sourceName) {
            sourceName = args[i];
        }
    }

    if (!sourceName) {
        console.log('Usage: node harvest-single.js <source> [--limit N] [--chunk-size S] [--no-bridge]');
        process.exit(1);
    }

    await harvestSingle(sourceName, { limit, chunkSize, skipBridge });
}

main().catch(console.error);
