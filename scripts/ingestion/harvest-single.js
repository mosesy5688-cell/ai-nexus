/**
 * Single-Source Harvester V22.2 (Industrial Stability Edition). 4-job parallel core;
 * streaming NDJSON ingestion (OOM protection). + C4 Stage-2 candidate-scoped census mode.
 */

import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import adapters from './adapters/index.js';
import { shardNDJSON } from './ndjson-sharder.js';
import { RateLimitExceededError, FetchError } from './adapters/base-adapter.js';
import { evaluateFloorGate } from './harvest-floors.js';
import { emitTerminalState, deriveSuccessStatus, STATUS, TIMEOUT_KIND } from './harvest-state.js';
import { buildAuthorityArtifact, AUTHORITY_ROLE } from '../factory/lib/c4s2-candidate-universe.js';

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
                        // V22.3: LOSSLESS capture (truncation FORBIDDEN) + write backpressure.
                        const canWrite = writeStream.write(JSON.stringify(norm) + '\n');

                        if (!canWrite) {
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

        // V28 (PR-D): intentionally NO registryManager here (dead skip branch; O(1)
        // streaming design; skip would drop entities = data loss). Full re-fetch accepted.
        const fetchOptions = {
            limit,
            onBatch: processBatch
        };

        // H1 (fail loud): carries a hard fetch/abort/parse failure out so the final
        // return sets result.error + trips the exit gate. RateLimitExceededError
        // early-finish and a genuinely-empty [] stay success; only ERROR-emptiness fails.
        let fetchHardError = null;
        // H2c: terminal-state signals (sidecar-only, never alter exit code).
        let rateLimited = false;        // RateLimitExceededError early-finish
        let requestTimeout = false;     // FetchError kind === 'abort'
        let rawEntities = [];
        try {
            rawEntities = await adapter.fetch(fetchOptions);
        } catch (fetchError) {
            if (fetchError instanceof RateLimitExceededError) {
                console.warn(`\n🛑 [Harvest] ${fetchError.message}`);
                console.warn(`   ⚠️ Finishing early with ${results.total} entities to preserve CI throughput.`);
                rateLimited = true;
            } else if (fetchError instanceof FetchError) {
                if (fetchError.kind === 'abort') requestTimeout = true;
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
            // H2c: hard error -> failed; abort -> timeout. BLOCKER E: merge FetchError.meta into terminal_meta.
            const hardMeta = { ...(requestTimeout ? { timeout_kind: TIMEOUT_KIND.REQUEST_TIMEOUT } : {}), ...(fetchHardError.meta || {}) };
            emitTerminalState({ source: sourceName, status: requestTimeout ? STATUS.TIMEOUT : STATUS.FAILED, yield: results.total, duration_ms: Date.now() - startTime, errors: [fetchHardError.message], had_adapter_error: true, floor_violated: false, terminal_meta: Object.keys(hardMeta).length ? hardMeta : undefined });
            return { source: sourceName, count: results.total, duration, file: ndjsonPath, error: fetchHardError.message };
        }

        // PR-H2a (fail loud): KNOWN-LARGE-SOURCE FLOOR GATE (above the adapters). A
        // completed harvest whose unique count falls below the per-source floor is a
        // zero/near-zero without valid-zero proof; reject it loudly. Small sources exempt.
        const gate = evaluateFloorGate({ sourceName, count: results.total, hadAdapterError: false });
        if (gate.violated) {
            console.error(`\n❌ HARVEST FLOOR VIOLATION: ${sourceName} yielded ${results.total} < floor ${gate.floor} — known-large source zero/near-zero without valid-zero proof`);
            console.error(`   Output (partial): ${ndjsonPath} | Time: ${duration}s`);
            // H2c sidecar: floor_violation; carry cause=rate_limited when an early-finish drove the shortfall (H2a gate unchanged).
            emitTerminalState({ source: sourceName, status: STATUS.FLOOR_VIOLATION, yield: results.total, duration_ms: Date.now() - startTime, errors: [`floor violation: ${results.total} < ${gate.floor}`], had_adapter_error: false, floor_violated: true, terminal_meta: rateLimited ? { cause: STATUS.RATE_LIMITED } : undefined });
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

        // H2c sidecar (terminal success path); status precedence in deriveSuccessStatus.
        const tMeta = adapter.terminalMeta || null;
        const sv = deriveSuccessStatus({ total: results.total, rateLimited, terminalMeta: tMeta });
        emitTerminalState({ source: sourceName, status: sv.status, yield: results.total, duration_ms: Date.now() - startTime, errors: [], had_adapter_error: false, floor_violated: false, partial_reason: sv.partial_reason, terminal_meta: tMeta || undefined });
        return { source: sourceName, count: results.total, duration, file: ndjsonPath };
    } catch (error) {
        console.error(`\n❌ [Harvest] Failed: ${error.message}`);
        // H2c sidecar (top-level catch). Last in-process terminal point; a runner KILL
        // leaves NO sidecar -> that step_killed case is the aggregator's inference, never faked here.
        emitTerminalState({ source: sourceName, status: STATUS.FAILED, yield: 0, duration_ms: Date.now() - startTime, errors: [error.message], had_adapter_error: false, floor_violated: false });
        return { source: sourceName, count: 0, error: error.message };
    }
}

// C4 Stage-2 (D-335/336): CANDIDATE-scoped census (request-only). Reads the frozen
// universe owners (reconciler `freeze`), exhausts EACH owner's model + dataset listing via
// the adapters' real Link-cursor pagination, writes the dual-source authority artifacts
// (members + tuple + per-owner completeness + universe-hash + metrics). Partial NEVER
// usable for deletion: an owner not exhausted => that authority INCOMPLETE => ZERO_PUBLICATION.
async function c4s2Census() {
    const universe = JSON.parse(fs.readFileSync('data/state/c4-stage2/universe.json', 'utf8'));
    const owners = universe.owners || [];
    const { default: HuggingFaceAdapter } = await import('./adapters/huggingface-adapter.js');
    const { default: DatasetsAdapter } = await import('./adapters/datasets-adapter.js');
    const model = await new HuggingFaceAdapter().fetchCensusMembership({ authors: owners });
    const dataset = await new DatasetsAdapter().fetchCensusMembership({ authors: owners });
    // D-337 Blocker 3: authority-artifact producer = PURE helper (same memberHash the validator recomputes).
    const art = (role, res) => ({ ...buildAuthorityArtifact({ members: res.members, role, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, headSha: process.env.GITHUB_SHA, universeHash: universe.universeHash, generatedAtUtc: new Date().toISOString(), completeness: res.completeness }), metrics: res.metrics });
    fs.mkdirSync('data/state/c4-stage2', { recursive: true });
    fs.writeFileSync('data/state/c4-stage2/model-authority.json', JSON.stringify(art(AUTHORITY_ROLE.MODEL, model)));
    fs.writeFileSync('data/state/c4-stage2/dataset-authority.json', JSON.stringify(art(AUTHORITY_ROLE.DATASET, dataset)));
    console.log(`[C4-S2] census: owners=${owners.length} model=${model.members.length}(${model.completeness}) dataset=${dataset.members.length}(${dataset.completeness})`);
}

/**
 * CLI Entry Point
 */
async function main() {
    const args = process.argv.slice(2);
    if (args[0] === 'c4s2-census') { await c4s2Census(); return; } // D-335/336 candidate-scoped census mode
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
