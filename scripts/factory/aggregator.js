import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { generateDailyReport, updateDailyAccumulator, shouldGenerateReport } from './lib/daily-report.js';
import { loadFniHistory } from './lib/cache-manager.js';
import { persistRegistry } from './lib/aggregator-persistence.js';
import { buildTaskList } from './lib/aggregator-tasks.js';
import { updateFniHistory } from './lib/aggregator-metrics.js';
import {
    getWeekNumber, generateHealthReport, backupStateFiles, validateCryptoEnv
} from './lib/aggregator-maintenance.js';
import { checkIncrementalProgress, updateTaskChecksum } from './lib/aggregator-incremental.js';
import { loadGlobalRegistry } from './lib/cache-manager.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';
import { generateUMID, generateCanonicalUrl, generateCitation } from './lib/umid-generator.js';
import { initRustBridge, streamAggregateFFI } from './lib/rust-bridge.js';
import { createWriteStream, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Config (Art 3.1, 3.3)
const CONFIG = {
    TOTAL_SHARDS: 20,
    MIN_SUCCESS_RATE: 0.8,
    OUTPUT_DIR: './output',
    ARTIFACT_DIR: './artifacts',
    CODE_VERSION: 'v18.12.5.15', // Increment this to bust incremental task cache
};

// Configuration & Argument Parsing
const args = process.argv.slice(2);
const taskArg = args.find(a => a.startsWith('--task=') || a.startsWith('-t='))?.split('=')[1];
const CHECKPOINT_THRESHOLD = 5.5 * 3600; // 5.5 hours in seconds
const AGGREGATE_FLOOR = 125000;

// Main
async function main() {
    // V25.8: Initialize Rust FFI bridge (graceful JS fallback if .node unavailable)
    const rustStatus = initRustBridge();
    console.log(`[AGGREGATOR] Rust FFI: ${rustStatus.mode} (${rustStatus.modules.join(', ') || 'JS fallback'})`);

    // V25.8.3: Early AES_CRYPTO_KEY validation — detect encrypted .bin shards
    await validateCryptoEnv();

    const startTime = Date.now();
    let entitiesInputPath = process.env.ENTITIES_PATH || './data/merged.json.gz';

    // Transparent .gz fallback
    if (!await fs.access(entitiesInputPath).then(() => true).catch(() => false)) {
        if (!entitiesInputPath.endsWith('.gz')) {
            const gzPath = entitiesInputPath + '.gz';
            if (await fs.access(gzPath).then(() => true).catch(() => false)) {
                entitiesInputPath = gzPath;
            }
        }
    }

    // Pass 1: Global FNI Logic (Lightweight — scores + registry mapping)
    const needsSlimming = !!taskArg && taskArg !== 'core';
    const { loadRegistryShardsSequentially } = await import('./lib/registry-loader.js');
    const { calculateGlobalStats, preProcessDeltas, mergePartitionedShard } = await import('./lib/aggregator-utils.js');
    const { saveRegistryShard } = await import('./lib/registry-saver.js');

    const { rankingsMap, registryMap, scoreMap } = await calculateGlobalStats(loadRegistryShardsSequentially, CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
    // V25.8.3: Fail-fast if Pass 1 produced empty data (AES key missing or shard corruption)
    if (registryMap.size === 0) {
        throw new Error('[CRITICAL] Pass 1 returned 0 entities. Check AES_CRYPTO_KEY is set and registry shards exist.');
    }
    console.log(`✓ Global rankings and registry mapping aligned (including Mesh Impact).`);

    let successCount = 0;
    let fullSet = [];

    // V18.12.5.21: Late-Binding Toggle
    const lateBinding = process.env.FNI_LATE_BINDING !== 'false'; // Default to true
    const shardDir = path.join(process.env.CACHE_DIR || './cache', 'registry');

    if (needsSlimming || lateBinding) {
        // V25.8.3: OOM fix — Rust streaming aggregator (primary) or JS disk staging (fallback)
        const stagingPath = './output/.staging-fullset.ndjson';
        await fs.mkdir('./output', { recursive: true });
        const rustResult = streamAggregateFFI(shardDir, stagingPath);
        if (rustResult && rustResult.entityCount > 0) {
            console.log(`[AGGREGATOR] Rust stream-aggregate: ${rustResult.entityCount} entities, ${rustResult.shardCount} shards (${rustResult.durationMs}ms)`);
            successCount = rustResult.shardCount;
        } else {
            if (rustResult) console.log(`[AGGREGATOR] Rust returned 0 entities (no .json.gz shards). Falling back to JS binary reader.`);
            console.log(`[AGGREGATOR] JS fallback: disk-staged collection...`);
            const ws = createWriteStream(stagingPath);
            await loadRegistryShardsSequentially(async (slimEntities) => {
                const lines = [];
                for (const e of slimEntities) {
                    e.fni_percentile = rankingsMap.get(e.id) || 0;
                    lines.push(JSON.stringify(e));
                }
                if (lines.length > 0) {
                    const ok = ws.write(lines.join('\n') + '\n');
                    if (!ok) await new Promise(r => ws.once('drain', r));
                }
                successCount++;
            }, { slim: true });
            ws.end();
            await new Promise(r => ws.on('finish', r));
        }
        const rl = createInterface({ input: createReadStream(stagingPath), crlfDelay: Infinity });
        for await (const line of rl) { if (line) fullSet.push(JSON.parse(line)); }
        await fs.unlink(stagingPath).catch(() => {});
        console.log(`[AGGREGATOR] Loaded ${fullSet.length} entities.`);
    } else {
        // Legacy path (Merge deltas and overwrite shards)
        // 1.5. Pre-process updates (O(1) Streaming)
        const harvesterExists = await fs.access(entitiesInputPath).then(() => true).catch(() => false);
        await preProcessDeltas(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS, registryMap, harvesterExists ? entitiesInputPath : null);

        // 2. Pass 2: Shard-Centric Merge (Heavyweight)
        console.log(`[AGGREGATOR] Pass 2/2: Performing Partitioned Shard Merge...`);
        await loadRegistryShardsSequentially(async (baselineEntities, shardIdx) => {
            const mergedShard = await mergePartitionedShard(
                baselineEntities, shardIdx, rankingsMap, { slim: false }
            );
            await saveRegistryShard(shardIdx, mergedShard.entities);
            if (!taskArg || taskArg === 'health') {
                for (const e of mergedShard.entities) fullSet.push(e);
            }
            successCount++;
            mergedShard.entities = null;
        }, { slim: false });
    }

    if (fullSet.length === 0 && !needsSlimming) {
        // If we didn't accumulate fullSet, we need to load it slimly for health/final stats
        // This is safe because slim mode is OOM-resistant
        const smallRegistry = await loadGlobalRegistry({ slim: true });
        fullSet = smallRegistry.entities || [];
    }

    if (fullSet.length < AGGREGATE_FLOOR) {
        throw new Error(`[CRITICAL] Data Loss Detected! Only ${fullSet.length} entities in full set (Min: ${AGGREGATE_FLOOR}).`);
    }

    // V25.8 CDDPP Shield: Inject UMID + canonical_url + citation watermarking
    if (!taskArg || taskArg === 'core') {
        console.log('[AGGREGATOR] V25.8: Applying UMID + CDDPP watermarking...');
        let watermarked = 0;
        for (const e of fullSet) {
            const id = e.id || e.slug;
            if (!id) continue;
            if (!e.umid) e.umid = generateUMID(id);
            if (!e.canonical_url) e.canonical_url = generateCanonicalUrl(e);
            if (!e.citation) e.citation = generateCitation(e);
            watermarked++;
        }
        console.log(`[AGGREGATOR] V25.8: Watermarked ${watermarked} entities.`);
    }

    if (!taskArg || taskArg === 'health') {
        await generateHealthReport(successCount, fullSet, CONFIG.TOTAL_SHARDS, CONFIG.MIN_SUCCESS_RATE, CONFIG.OUTPUT_DIR);
    }

    const rankedEntities = fullSet;
    const tasks = buildTaskList(rankedEntities, CONFIG.OUTPUT_DIR, { shardDir });

    let taskFailures = 0;
    for (const task of tasks) {
        if (taskArg && taskArg !== task.id) continue;
        try {
            if (task.id && await checkIncrementalProgress(task.id, rankedEntities, CONFIG.CODE_VERSION)) continue;
            console.log(`[AGGREGATOR] Task: ${task.name}...`);
            process.env.AGGREGATOR_MODE = 'true';
            process.env.CACHE_DIR = './cache';
            await (task.fn() || Promise.resolve());
            if (task.id) await updateTaskChecksum(task.id, rankedEntities, CONFIG.CODE_VERSION);
        } catch (e) {
            console.error(`[AGGREGATOR] ❌ Task ${task.name} failed: ${e.message}`);
            taskFailures++;
            if (taskArg) process.exit(1);
        }
    }

    // V22.8: Memory Cleanup before Persistence (OOM Protection)
    // Satellite tasks are done; we no longer need the slimmed array if we're doing HF patching.
    if (taskArg === 'core' || !taskArg) {
        console.log(`[AGGREGATOR] 🧹 Memory Cleanup: Releasing slimmed entities before High-Fidelity persistence...`);
    }

    // Capture count before nullifying
    const entityCount = rankedEntities.length;

    if (!taskArg || taskArg === 'core') {
        try {
            await updateFniHistory(rankedEntities);
            await fs.mkdir('./cache', { recursive: true });

            // V22.8 Authoritative Aggregation (Safeguard 5.1)
            // This is the SINGLE SOURCE OF TRUTH for the global registry monolith and fragments.
            // If and only if in Core/Late-Binding mode, we patch shards to preserve READMEs.
            const persistRankings = (lateBinding && !needsSlimming) ? rankingsMap : null;

            // NULLIFY pointers to free up GC pressure for the patching phase
            if (persistRankings) {
                fullSet = null;
                // Note: we'll pass persistRankings instead of rankedEntities
            }

            await persistRegistry(persistRankings ? null : rankedEntities, CONFIG.OUTPUT_DIR, './cache', persistRankings, scoreMap);

            await backupStateFiles(CONFIG.OUTPUT_DIR, await loadFniHistory(), getWeekNumber());
            await updateDailyAccumulator(rankedEntities, CONFIG.OUTPUT_DIR);
            if (shouldGenerateReport()) await generateDailyReport(CONFIG.OUTPUT_DIR);

        } catch (e) {
            console.error(`[AGGREGATOR] ❌ Finalization failed: ${e.message}`);
            console.error(`[AGGREGATOR] FATAL: Finalization is critical. Exiting with error to prevent cache pollution.`);
            process.exit(1);
        }
    }

    if (taskFailures > 0) {
        console.error(`[AGGREGATOR] FATAL: ${taskFailures} task(s) failed. Exiting with error to prevent cache pollution.`);
        process.exit(1);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AGGREGATOR V18.12.5.15] Partitioned Aggregation Complete! (${duration}s)`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
