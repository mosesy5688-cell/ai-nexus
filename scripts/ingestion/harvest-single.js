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
import { evaluateCompletionGate, incompleteStatus } from './harvest-completion.js';
// C4 Stage-2 census lives in its own module (CES Art 5.1 headroom for the
// producer-bound escalation below); re-exported so import sites are unchanged.
export { c4s2Census } from './lib/c4s2-census.js';
// D-2026-0809-416 (FINDING-GR-1): producer-side emission guard (quarantine screen
// + emitted-line assertion) and its counters. Bounds live in lib/field-contracts.js.
import { emitNormalizedRecord, producerBoundSummary, writeQuarantineManifest, resetCounters, PRODUCER_LINE_TERMINAL } from './lib/producer-emitter.js';

const OUTPUT_DIR = 'data';

/**
 * Harvest from a single source and save as lossless NDJSON stream
 * V22.3: Streaming Ingestion (OOM Protection)
 */
export async function harvestSingle(sourceName, options = {}) {
    const { limit = 10000, chunkSize = 500, skipBridge = false } = options;
    // Test seam: allow injecting a fake adapter so the chokepoint's error-vs-empty
    // gate can be unit-tested without the real source registry or any network.
    // `options._bounds` is the same kind of seam for the producer bound (it drives
    // the quarantine screen and the emitted-line assertion independently, so the
    // assertion's escalation path is testable without a 32 MiB fixture).
    // Production callers never pass _adapter/_bounds, so the live path is unchanged.
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
        // One tally per harvest process; the adapter's field contracts charge it too.
        const bounds = resetCounters();

        // V22.3 NDJSON Streaming Processor
        const processBatch = async (rawBatch) => {
            for (let i = 0; i < rawBatch.length; i++) {
                try {
                    const norm = adapter.normalize(rawBatch[i]);

                    if (norm) {
                        // D-2026-0809-416: quarantine screen -> emitted-line assertion ->
                        // write (with backpressure). A quarantine is counted + disclosed,
                        // an assertion breach throws PRODUCER_LINE_BYTES_LIMIT_EXCEEDED.
                        const emission = await emitNormalizedRecord(norm, writeStream, bounds, options._bounds);
                        if (emission.emitted) results.total++;
                    } else {
                        results.failed++;
                    }
                } catch (e) {
                    // D-2026-0809-416 F2: the producer-line terminal is a CODE
                    // invariant breach, not a per-record normalise error. Rethrow so it
                    // reaches the top-level terminal path and exits 1 -- laundering it
                    // into failed++ (logged for the first 5 records only, never carried
                    // into the sidecar) is exactly the silent skip the guard forbids.
                    if (e && e.code === PRODUCER_LINE_TERMINAL) throw e;
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

        // D1: every live adapter wraps `await onBatch(...)` in a catch-all that logs,
        // breaks and returns [] cleanly, so the rethrow above dies INSIDE the adapter
        // and the run would end a GREEN valid_zero. The emitter records the breach on
        // shared state; promote it here, independent of any adapter's error handling.
        const lineBreach = bounds.producer_line_breach || null;
        if (lineBreach && !fetchHardError) fetchHardError = new Error(`${PRODUCER_LINE_TERMINAL}: emitted line ${lineBreach.line_bytes} B > producer bound ${lineBreach.max_bytes} B (id=${lineBreach.id})`);

        // Backward compatibility for non-streaming adapters
        if (rawEntities && rawEntities.length > 0) {
            console.log(`   ✓ Adapter returned ${rawEntities.length} buffered entities. Streaming to disk...`);
            await processBatch(rawEntities);
            rawEntities = [];
        }

        // Finalize stream (always flush what we captured before the failure).
        await new Promise((resolve) => writeStream.end(resolve));

        // D-2026-0809-416: producer-bound disclosure. The identity-only quarantine
        // manifest is best-effort on disk; `pb` (the COUNTS) rides every terminal
        // state below, so a quarantine can never become invisible.
        writeQuarantineManifest(sourceName, bounds);
        const pb = producerBoundSummary(bounds);

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // H1 (logging honesty): on a hard fetch failure, NEVER print the green
        // "✅ Complete | Total: 0" — that is the fake-green laundering. Print a
        // loud error line and return result.error so the exit gate fires.
        if (fetchHardError) {
            console.error(`\n❌ [Harvest] FAILED (fetch error) — ${sourceName} | Captured before failure: ${results.total} | Time: ${duration}s`);
            console.error(`   Output (partial): ${ndjsonPath}`);
            // H2c: hard error -> failed; abort -> timeout. BLOCKER E: merge FetchError.meta into terminal_meta.
            // 2026-07-26: an instrumented source's completion claim rides along here too,
            // so `completion_status` is emitted on the HARD path as well as the gate path
            // (undefined -- and therefore absent -- for an un-instrumented source).
            const hardMeta = { ...(requestTimeout ? { timeout_kind: TIMEOUT_KIND.REQUEST_TIMEOUT } : {}), ...(adapter.completion || {}), ...(fetchHardError.meta || {}), producer_bounds: pb };
            emitTerminalState({ source: sourceName, status: requestTimeout ? STATUS.TIMEOUT : STATUS.FAILED, yield: results.total, duration_ms: Date.now() - startTime, errors: [fetchHardError.message], had_adapter_error: !lineBreach, floor_violated: false, completion_status: adapter.completion?.completion_status, terminal_meta: Object.keys(hardMeta).length ? hardMeta : undefined });
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
            emitTerminalState({ source: sourceName, status: STATUS.FLOOR_VIOLATION, yield: results.total, duration_ms: Date.now() - startTime, errors: [`floor violation: ${results.total} < ${gate.floor}`], had_adapter_error: false, floor_violated: true, terminal_meta: { ...(rateLimited ? { cause: STATUS.RATE_LIMITED } : {}), producer_bounds: pb } });
            return { source: sourceName, count: results.total, duration, file: ndjsonPath, error: `floor violation: ${results.total} < ${gate.floor}` };
        }

        // COMPLETENESS GATE (Founder ruling, 2026-07-26 S2 incident). Positioned
        // DELIBERATELY here: ABOVE the green "Complete" log, ABOVE the NDJSON bridge
        // and ABOVE the success return, so a REQUIRED source that abandoned planned
        // work can neither print green, nor emit bridge shards, nor return without
        // `error`. `result.error` is what makes the CLI exit 1, which is in turn what
        // keeps the (non-`always()`) R2 source-authority step and `Merge & Upload`
        // from running. Marking incomplete WITHOUT exiting non-zero was the hole.
        //
        // Source-agnostic: it reads a claim the adapter publishes on ITSELF. An
        // adapter that publishes nothing is unaffected (absence is never treated as
        // incompleteness). It runs AFTER the H2a floor gate so that gate's behaviour
        // stays bit-identical -- the floor is an anti-zero control, completeness is a
        // different question, and neither substitutes for the other.
        const comp = evaluateCompletionGate(adapter.completion || null);
        if (comp.blocked) {
            console.error(`\n❌ HARVEST INCOMPLETE: ${sourceName} — ${comp.error}`);
            console.error(`   Output (partial, NOT bridged): ${ndjsonPath} | Time: ${duration}s`);
            emitTerminalState({ source: sourceName, status: incompleteStatus({ rateLimited }), yield: results.total, duration_ms: Date.now() - startTime, errors: [comp.error], had_adapter_error: false, floor_violated: false, completion_status: comp.record.completion_status, terminal_meta: { ...comp.record, ...(adapter.terminalMeta || {}), producer_bounds: pb } });
            return { source: sourceName, count: results.total, duration, file: ndjsonPath, error: comp.error };
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
        // The completion record travels on the SUCCESS path too, so the Founder-ruled
        // fields (planned/completed topics, limit_satisfied, termination_reason) are
        // present on every emission for an instrumented source, not only on failures.
        const okMeta = { ...(comp.record || {}), ...(tMeta || {}), producer_bounds: pb };
        emitTerminalState({ source: sourceName, status: sv.status, yield: results.total, duration_ms: Date.now() - startTime, errors: [], had_adapter_error: false, floor_violated: false, partial_reason: sv.partial_reason, completion_status: comp.record?.completion_status, terminal_meta: okMeta });
        return { source: sourceName, count: results.total, duration, file: ndjsonPath };
    } catch (error) {
        console.error(`\n❌ [Harvest] Failed: ${error.message}`);
        // H2c sidecar (top-level catch). Last in-process terminal point; a runner KILL
        // leaves NO sidecar -> that step_killed case is the aggregator's inference, never faked here.
        emitTerminalState({ source: sourceName, status: STATUS.FAILED, yield: 0, duration_ms: Date.now() - startTime, errors: [error.message], had_adapter_error: false, floor_violated: false, terminal_meta: { producer_bounds: producerBoundSummary() } });
        return { source: sourceName, count: 0, error: error.message };
    }
}

// Main-guard: only run the CLI when invoked directly (node harvest-single.js).
// Importing this module (e.g. from a unit test exercising harvestSingle()) must
// NOT trigger main()/process.exit. Mirrors the repo's established guard pattern.
// The CLI body itself now lives in harvest-cli.js (CES headroom for the Founder-
// ruled completeness gate above); it is imported DYNAMICALLY so this module never
// participates in an import cycle with it.
if (process.argv[1]?.endsWith('harvest-single.js')) {
    import('./harvest-cli.js')
        .then((cli) => cli.main())
        .catch((err) => {
            // V28: any uncaught hard error fails the step (exit 1) instead of green.
            console.error(`\n❌ [Harvest] Fatal: ${err && err.stack ? err.stack : err}`);
            process.exit(1);
        });
}
