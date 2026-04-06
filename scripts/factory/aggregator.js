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

const CONFIG = {
    TOTAL_SHARDS: 20,
    MIN_SUCCESS_RATE: 0.8,
    OUTPUT_DIR: './output',
    ARTIFACT_DIR: './artifacts',
    CODE_VERSION: 'v18.12.5.15', // Increment this to bust incremental task cache
};

const args = process.argv.slice(2);
const taskArg = args.find(a => a.startsWith('--task=') || a.startsWith('-t='))?.split('=')[1];
const AGGREGATE_FLOOR = 125000;

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

    const needsSlimming = !!taskArg && taskArg !== 'core';
    const { loadRegistryShardsSequentially } = await import('./lib/registry-loader.js');
    const { calculateGlobalStats, preProcessDeltas, mergePartitionedShard } = await import('./lib/aggregator-utils.js');
    const { saveRegistryShard } = await import('./lib/registry-saver.js');

    // V25.8.5: Knowledge-AI fast path — skip heavy entity loading (OOM fix for 436K+ entities)
    const LIGHTWEIGHT_TASKS = new Set(['knowledge-ai']);
    if (taskArg && LIGHTWEIGHT_TASKS.has(taskArg)) {
        console.log(`[AGGREGATOR] Lightweight task '${taskArg}' — skipping entity loading.`);
        const tasks = buildTaskList([], CONFIG.OUTPUT_DIR, { shardDir: path.join(process.env.CACHE_DIR || './cache', 'registry') });
        for (const task of tasks) {
            if (task.id !== taskArg) continue;
            console.log(`[AGGREGATOR] Task: ${task.name}...`);
            await task.fn();
        }
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[AGGREGATOR V18.12.5.15] Lightweight task '${taskArg}' complete! (${duration}s)`);
        return;
    }

    const { rankingsMap, registryMap, scoreMap } = await calculateGlobalStats(loadRegistryShardsSequentially, CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
    // V25.8.3: Fail-fast if Pass 1 produced empty data (AES key missing or shard corruption)
    if (registryMap.size === 0) {
        throw new Error('[CRITICAL] Pass 1 returned 0 entities. Check AES_CRYPTO_KEY is set and registry shards exist.');
    }
    console.log(`✓ Global rankings and registry mapping aligned (including Mesh Impact).`);

    let successCount = 0;
    let fullSet = [];

    const lateBinding = process.env.FNI_LATE_BINDING !== 'false';
    const shardDir = path.join(process.env.CACHE_DIR || './cache', 'registry');
    const skipMerge = needsSlimming || (lateBinding && !!taskArg && taskArg !== 'core');
    if (skipMerge) {
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
        // Merge path: reads 2/4 artifacts and propagates FNI scores into registry
        console.log(`[AGGREGATOR] Merge path: propagating 2/4 FNI scores into registry...`);
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

    // V25.8.7: Release Pass 1 Maps before loading fullSet (OOM prevention)
    rankingsMap.clear(); registryMap.clear(); scoreMap.clear();
    if (global.gc) global.gc();

    if (fullSet.length === 0 && !needsSlimming) {
        // If we didn't accumulate fullSet, we need to load it slimly for health/final stats
        // This is safe because slim mode is OOM-resistant
        const smallRegistry = await loadGlobalRegistry({ slim: true });
        fullSet = smallRegistry.entities || [];
    }

    if (fullSet.length < AGGREGATE_FLOOR) {
        throw new Error(`[CRITICAL] Data Loss Detected! Only ${fullSet.length} entities in full set (Min: ${AGGREGATE_FLOOR}).`);
    }

    // V25.8.6: Direct FNI overlay from 2/4 artifacts (bypasses fragile merge path)
    if (!taskArg || taskArg === 'core') {
        const { overlayFniFromArtifacts } = await import('./lib/aggregator-shard-manager.js');
        await overlayFniFromArtifacts(fullSet, CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
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

    // Daily report runs FIRST — its Gemini call has highest priority before knowledge AI
    if (!taskArg || taskArg === 'core') {
        await updateDailyAccumulator(rankedEntities, CONFIG.OUTPUT_DIR);
        if (shouldGenerateReport()) await generateDailyReport(CONFIG.OUTPUT_DIR);
    }

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

            // V25.8.6: Pass overlay-patched entities to persistence (FNI scores live in fullSet)
            await persistRegistry(rankedEntities, CONFIG.OUTPUT_DIR, './cache', null, scoreMap);

            await backupStateFiles(CONFIG.OUTPUT_DIR, await loadFniHistory(), getWeekNumber());

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
