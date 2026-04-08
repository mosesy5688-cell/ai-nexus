import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { generateDailyReport, updateDailyAccumulatorFromTopN, shouldGenerateReport } from './lib/daily-report.js';
import { loadFniHistory } from './lib/cache-manager.js';
import { persistRegistry } from './lib/aggregator-persistence.js';
import { buildTaskList } from './lib/aggregator-tasks.js';
import { updateFniHistoryFromBatch } from './lib/aggregator-metrics.js';
import {
    getWeekNumber, generateHealthReport, backupStateFiles, validateCryptoEnv
} from './lib/aggregator-maintenance.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';
import { generateUMID, generateCanonicalUrl, generateCitation } from './lib/umid-generator.js';
import { initRustBridge, calculateFniFFI } from './lib/rust-bridge.js';

const CONFIG = {
    TOTAL_SHARDS: 20,
    MIN_SUCCESS_RATE: 0.8,
    OUTPUT_DIR: './output',
    ARTIFACT_DIR: './artifacts',
    CODE_VERSION: 'v25.9.0', // V25.9: Streaming core refactor
};

const args = process.argv.slice(2);
const taskArg = args.find(a => a.startsWith('--task=') || a.startsWith('-t='))?.split('=')[1];
const AGGREGATE_FLOOR = 125000;
const DAILY_TOP = 50;

async function main() {
    const rustStatus = initRustBridge();
    console.log(`[AGGREGATOR] Rust FFI: ${rustStatus.mode} (${rustStatus.modules.join(', ') || 'JS fallback'})`);
    await validateCryptoEnv();

    const startTime = Date.now();
    let entitiesInputPath = process.env.ENTITIES_PATH || './data/merged.json.gz';
    if (!await fs.access(entitiesInputPath).then(() => true).catch(() => false)) {
        if (!entitiesInputPath.endsWith('.gz')) {
            const gzPath = entitiesInputPath + '.gz';
            if (await fs.access(gzPath).then(() => true).catch(() => false)) entitiesInputPath = gzPath;
        }
    }

    const { loadRegistryShardsSequentially } = await import('./lib/registry-loader.js');
    const { calculateGlobalStats, preProcessDeltas, mergePartitionedShard } = await import('./lib/aggregator-utils.js');
    const { saveRegistryShard } = await import('./lib/registry-saver.js');

    // V25.8.5: Knowledge-AI fast path — skip heavy entity loading
    const LIGHTWEIGHT_TASKS = new Set(['knowledge-ai', 'mesh']);
    if (taskArg && LIGHTWEIGHT_TASKS.has(taskArg)) {
        console.log(`[AGGREGATOR] Lightweight task '${taskArg}' — skipping entity loading.`);
        const shardDir = path.join(process.env.CACHE_DIR || './cache', 'registry');
        const noopReader = async () => {};
        const tasks = buildTaskList(noopReader, CONFIG.OUTPUT_DIR, { shardDir });
        for (const task of tasks) {
            if (task.id !== taskArg) continue;
            console.log(`[AGGREGATOR] Task: ${task.name}...`);
            await task.fn();
        }
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[AGGREGATOR V25.9.0] Lightweight task '${taskArg}' complete! (${duration}s)`);
        return;
    }

    // Pass 1: Global Indexing (lightweight Maps only)
    const { rankingsMap, registryMap, scoreMap } = await calculateGlobalStats(loadRegistryShardsSequentially, CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
    if (registryMap.size === 0) {
        throw new Error('[CRITICAL] Pass 1 returned 0 entities. Check AES_CRYPTO_KEY is set and registry shards exist.');
    }
    console.log(`✓ Global rankings and registry mapping aligned (including Mesh Impact).`);
    const shardDir = path.join(process.env.CACHE_DIR || './cache', 'registry');
    const isCoreTask = !taskArg || taskArg === 'core';
    if (isCoreTask) {
        await runStreamingCore(loadRegistryShardsSequentially, saveRegistryShard, calculateGlobalStats,
            preProcessDeltas, mergePartitionedShard, rankingsMap, registryMap, scoreMap,
            entitiesInputPath, shardDir, startTime);
    } else {
        await runSatelliteTask(loadRegistryShardsSequentially, rankingsMap, scoreMap,
            shardDir, startTime);
    }
}

/** V25.9: Streaming core — zero fullSet accumulation. ~530MB peak vs ~7GB+ before. */
async function runStreamingCore(loadShards, saveShard, _calcStats, preProcessDeltas,
    mergePartitionedShard, rankingsMap, registryMap, scoreMap, entitiesInputPath, shardDir, startTime) {
    const harvesterExists = await fs.access(entitiesInputPath).then(() => true).catch(() => false);
    await preProcessDeltas(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS, registryMap, harvesterExists ? entitiesInputPath : null);
    console.log(`[AGGREGATOR] Pass 2/2: Performing Partitioned Shard Merge...`);
    let mergeCount = 0;
    await loadShards(async (baselineEntities, shardIdx) => {
        const mergedShard = await mergePartitionedShard(baselineEntities, shardIdx, rankingsMap, { slim: false });
        await saveShard(shardIdx, mergedShard.entities);
        mergeCount++;
        mergedShard.entities = null;
    }, { slim: false });
    // Build lightweight FNI Map from 2/4 artifacts (~13MB for 436K entries)
    const { buildFniMap } = await import('./lib/aggregator-shard-manager.js');
    const fniMap = await buildFniMap(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
    registryMap.clear();
    console.log('[AGGREGATOR] Streaming finalization: FNI overlay + CDDPP watermarking...');
    let entityCount = 0, watermarked = 0, fniHits = 0, fniRecomputed = 0;
    const topN = [];
    const historyBatch = new Map();

    await loadShards(async (entities, shardIdx) => {
        for (const e of entities) {
            const artifactFni = fniMap.get(e.id);
            if (artifactFni != null) {
                e.fni_score = artifactFni; e.fni = artifactFni;
                fniHits++;
            } else if (!e.fni_score) {
                // V26.9: Real-time FNI computation for entities missing from 2/4 artifacts.
                // Uses the same calculateFniFFI as 2/4 — no floor values, full accuracy.
                const result = calculateFniFFI(e, { includeMetrics: true, lastSeen: e._last_seen });
                e.fni_score = result.score; e.fni = result.score;
                fniRecomputed++;
            }

            const id = e.id || e.slug;
            if (id) {
                if (!e.umid) e.umid = generateUMID(id);
                if (!e.canonical_url) e.canonical_url = generateCanonicalUrl(e);
                if (!e.citation) e.citation = generateCitation(e);
                watermarked++;
            }

            // Bounded top-50 tracking for daily report
            const score = e.fni_score || 0;
            if (topN.length < DAILY_TOP || score > topN[topN.length - 1].fni_score) {
                topN.push({
                    id: e.id, name: e.name || e.slug, type: e.type || 'model',
                    fni_score: score, pipeline_tag: e.pipeline_tag || '', author: e.author || 'Community'
                });
                topN.sort((a, b) => b.fni_score - a.fni_score);
                if (topN.length > DAILY_TOP) topN.length = DAILY_TOP;
            }

            // FNI history accumulation (normalizedId → score)
            const nid = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
            historyBatch.set(nid, score);
            entityCount++;
        }

        await saveShard(shardIdx, entities);
        if (global.gc && entityCount % 100000 === 0) global.gc();
    }, { slim: false });
    fniMap.clear();
    const fniMissNoScore = entityCount - fniHits - fniRecomputed;
    console.log(`[AGGREGATOR] Streaming finalization: ${entityCount} entities, ${watermarked} watermarked.`);
    console.log(`[FNI-OVERLAY] hits=${fniHits}, recomputed=${fniRecomputed}, kept_existing=${fniMissNoScore}`);

    if (entityCount < AGGREGATE_FLOOR) {
        throw new Error(`[CRITICAL] Data Loss Detected! Only ${entityCount} entities (Min: ${AGGREGATE_FLOOR}).`);
    }

    // Health report (count-based, no entity array needed)
    await generateHealthReport(mergeCount, { length: entityCount }, CONFIG.TOTAL_SHARDS, CONFIG.MIN_SUCCESS_RATE, CONFIG.OUTPUT_DIR);

    // Daily report from bounded top-50
    await updateDailyAccumulatorFromTopN(topN, CONFIG.OUTPUT_DIR);
    if (shouldGenerateReport()) await generateDailyReport(CONFIG.OUTPUT_DIR);

    try {
        // FNI history from streaming batch
        await updateFniHistoryFromBatch(historyBatch);
        historyBatch.clear();

        await fs.mkdir('./cache', { recursive: true });
        // Persist: mirroring only — shards already saved in streaming pass
        await persistRegistry(null, CONFIG.OUTPUT_DIR, './cache', null, null);
        await backupStateFiles(CONFIG.OUTPUT_DIR, await loadFniHistory(), getWeekNumber());
    } catch (e) {
        console.error(`[AGGREGATOR] ❌ Finalization failed: ${e.message}`);
        process.exit(1);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AGGREGATOR V25.9.0] Streaming Core Complete! (${duration}s)`);
}

/** V25.9: Satellite tasks — zero fullSet. Each generator streams via shardReader. */
async function runSatelliteTask(loadShards, rankingsMap, scoreMap, shardDir, startTime) {
    if (taskArg === 'health') {
        let entityCount = 0, shardCount = 0;
        await loadShards(async (entities) => { entityCount += entities.length; shardCount++; }, { slim: true });
        if (entityCount < AGGREGATE_FLOOR) {
            throw new Error(`[CRITICAL] Data Loss Detected! Only ${entityCount} entities (Min: ${AGGREGATE_FLOOR}).`);
        }
        await generateHealthReport(shardCount, { length: entityCount }, CONFIG.TOTAL_SHARDS, CONFIG.MIN_SUCCESS_RATE, CONFIG.OUTPUT_DIR);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[AGGREGATOR V25.9.0] Health check complete! (${duration}s)`);
        return;
    }

    // Percentile-injecting shard reader — Rust binary reader (AES+Zstd) remains primary
    const satelliteReader = async (consumer, opts = {}) => {
        await loadShards(async (entities, shardIdx) => {
            for (const e of entities) e.fni_percentile = rankingsMap.get(e.id) || 0;
            await consumer(entities, shardIdx);
        }, { slim: true, ...opts });
    };

    const tasks = buildTaskList(satelliteReader, CONFIG.OUTPUT_DIR, { shardDir });
    for (const task of tasks) {
        if (taskArg !== task.id) continue;
        console.log(`[AGGREGATOR] Task: ${task.name}...`);
        process.env.AGGREGATOR_MODE = 'true';
        process.env.CACHE_DIR = './cache';
        try {
            await (task.fn() || Promise.resolve());
        } catch (e) {
            console.error(`[AGGREGATOR] ❌ Task ${task.name} failed: ${e.message}`);
            process.exit(1);
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AGGREGATOR V25.9.0] Satellite task '${taskArg}' complete! (${duration}s)`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
