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
import { RateLimitExceededError, FetchError } from './adapters/base-adapter.js';
import { evaluateFloorGate } from './harvest-floors.js';

const OUTPUT_DIR = 'data';

/**
 * Harvest from a single source and save as lossless NDJSON stream
 * V22.3: Streaming Ingestion (OOM Protection)
 */
export async function harvestSingle(sourceName, options = {}) {
    const { limit = 10000, chunkSize = 500, skipBridge = false } = options;
    // Test seam: allow injecting a fake adapter so the chokepoint's error-vs-empty
    // gate can be unit-tested without the real source registry or any network.
    // Production callers never pass _adapter, so the live path is unchanged.
    const adapter = options._adapter || adapters[sourceName];

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

        // V28 (PR-D): intentionally NO `registryManager` here. The adapters' V22.4
        // "incremental skip-unchanged" branches were dead anyway — they read
        // `registryManager.registry?.entities`, a property the real (SQLite-backed)
        // RegistryManager never exposes, so the optional chain always short-circuited
        // and nothing was ever skipped. Re-enabling is NOT data-safe in this streaming
        // harvester: (1) it would require materializing the full prior registry into
        // memory, violating the O(1)-memory streaming design this file exists for; and
        // (2) on skip there is no registry to re-emit the unchanged entity into here, so
        // a skip would DROP the entity from the NDJSON output (data loss). Per the
        // data-safety constraint we accept the full re-fetch cost and do NOT plumb a
        // registryManager. The dead skip branches were removed from the adapters.
        const fetchOptions = {
            limit,
            onBatch: processBatch
        };

        // H1 (fail loud): carries a hard fetch/abort/parse failure out of the
        // inner catch so the final return can set result.error and trip the
        // exit gate (main() → process.exit(1)). A RateLimitExceededError
        // early-finish deliberately does NOT set this (CI-throughput tolerance,
        // stays success), and a genuinely-empty [] never throws, so it stays
        // success too. Only ERROR-caused emptiness becomes a hard failure.
        let fetchHardError = null;
        let rawEntities = [];
        try {
            rawEntities = await adapter.fetch(fetchOptions);
        } catch (fetchError) {
            if (fetchError instanceof RateLimitExceededError) {
                console.warn(`\n🛑 [Harvest] ${fetchError.message}`);
                console.warn(`   ⚠️ Finishing early with ${results.total} entities to preserve CI throughput.`);
            } else if (fetchError instanceof FetchError) {
                // A source-level fetch/abort/parse failure. Surface it as a hard
                // error so the workflow step fails loud instead of laundering
                // into a green "Complete | Total: 0".
                console.error(`\n❌ [Harvest] ${sourceName} fetch FAILED (${fetchError.kind}): ${fetchError.detail}`);
                fetchHardError = fetchError;
            } else {
                console.error(`   ❌ Fetch error: ${fetchError.message}`);
                fetchHardError = fetchError;
            }
            rawEntities = [];
        }

        // Backward compatibility for non-streaming adapters
        if (rawEntities && rawEntities.length > 0) {
            console.log(`   ✓ Adapter returned ${rawEntities.length} buffered entities. Streaming to disk...`);
            await processBatch(rawEntities);
            rawEntities = [];
        }

        // Finalize stream (always flush what we captured before the failure).
        await new Promise((resolve) => writeStream.end(resolve));

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // H1 (logging honesty): on a hard fetch failure, NEVER print the green
        // "✅ Complete | Total: 0" — that is the fake-green laundering. Print a
        // loud error line and return result.error so the exit gate fires.
        if (fetchHardError) {
            console.error(`\n❌ [Harvest] FAILED (fetch error) — ${sourceName} | Captured before failure: ${results.total} | Time: ${duration}s`);
            console.error(`   Output (partial): ${ndjsonPath}`);
            return { source: sourceName, count: results.total, duration, file: ndjsonPath, error: fetchHardError.message };
        }

        // PR-H2a (fail loud): KNOWN-LARGE-SOURCE FLOOR GATE. This gate lives
        // ABOVE the adapters: the catch-and-return-empty HF adapters never set
        // result.error, so a real outage would otherwise launder into a green
        // "Complete | Total: 0". For sources we KNOW are large, a completed
        // harvest (no adapter error — hadAdapterError=false here, the fetchHardError
        // path already returned above so we never double-report) whose final
        // unique-entity count falls below the conservative per-source floor is a
        // zero/near-zero with no valid-zero proof. Reject it loudly. Sources not
        // in the floor map are unaffected (small-source tolerance).
        const gate = evaluateFloorGate({ sourceName, count: results.total, hadAdapterError: false });
        if (gate.violated) {
            console.error(`\n❌ HARVEST FLOOR VIOLATION: ${sourceName} yielded ${results.total} < floor ${gate.floor} — known-large source zero/near-zero without valid-zero proof`);
            console.error(`   Output (partial): ${ndjsonPath} | Time: ${duration}s`);
            return { source: sourceName, count: results.total, duration, file: ndjsonPath, error: `floor violation: ${results.total} < ${gate.floor}` };
        }

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

    const result = await harvestSingle(sourceName, { limit, chunkSize, skipBridge });

    // V28: A hard failure (mkdir/stream/sharder error — surfaced as result.error)
    // must fail the workflow step visibly. A RateLimitExceededError early-finish
    // is NOT a hard failure: harvestSingle() handles it gracefully (writes what it
    // got, no result.error) and returns normally, so it stays exit 0.
    if (result && result.error) {
        console.error(`\n❌ [Harvest] Hard failure for ${sourceName}: ${result.error}`);
        process.exit(1);
    }
}

// Main-guard: only run the CLI when invoked directly (node harvest-single.js).
// Importing this module (e.g. from a unit test exercising harvestSingle()) must
// NOT trigger main()/process.exit. Mirrors the repo's established guard pattern.
if (process.argv[1]?.endsWith('harvest-single.js')) {
    main().catch((err) => {
        // V28: any uncaught hard error fails the step (exit 1) instead of green.
        console.error(`\n❌ [Harvest] Fatal: ${err && err.stack ? err.stack : err}`);
        process.exit(1);
    });
}
