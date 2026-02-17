import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { generateRankings } from './lib/rankings-generator.js';
import { generateSearchIndices } from './lib/search-indexer.js';
import { generateTrending } from './lib/trending-generator.js';
import { generateSitemap } from './lib/sitemap-generator.js';
import { generateCategoryStats, getV6Category } from './lib/category-stats-generator.js';
import { generateRelations } from './lib/relations-generator.js';
import { generateMeshGraph } from './lib/mesh-graph-generator.js';
import { computeAltRelations } from './lib/alt-linker.js';
import { computeKnowledgeLinks } from './lib/knowledge-linker.js';
import { generateKnowledgeData } from './lib/knowledge-data-generator.js';
import { generateDailyReport, updateDailyAccumulator, shouldGenerateReport } from './lib/daily-report.js';
import { generateDailyReportsIndex } from './lib/daily-reports-index.js';
import { loadFniHistory, loadEntityChecksums, saveEntityChecksums } from './lib/cache-manager.js';
import { generateTrendData } from './lib/trend-data-generator.js';
import { persistRegistry } from './lib/aggregator-persistence.js';
import { processShardsIteratively } from './lib/aggregator-utils.js';
import { calculatePercentiles, updateFniHistory } from './lib/aggregator-metrics.js';
import {
    getWeekNumber, generateHealthReport, backupStateFiles
} from './lib/aggregator-maintenance.js';
import { checkIncrementalProgress, updateTaskChecksum } from './lib/aggregator-incremental.js';
import { loadGlobalRegistry } from './lib/cache-manager.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';

// Config (Art 3.1, 3.3)
const CONFIG = {
    TOTAL_SHARDS: 100,
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

    // 1. Pass 1: Global FNI Logic (Lightweight)
    // Extracts scores from all shards to calculate global rankings and registry mapping
    const needsSlimming = !!taskArg && taskArg !== 'core';
    const { loadRegistryShardsSequentially } = await import('./lib/registry-loader.js');
    const { calculateGlobalStats, preProcessDeltas, mergePartitionedShard } = await import('./lib/aggregator-utils.js');
    const { saveRegistryShard } = await import('./lib/registry-saver.js');

    // V18.12.5.19: Smart Prep - If harvester monolith exists, use it for indexing to avoid R2 baseline downloads
    const harvesterExists = await fs.access(entitiesInputPath).then(() => true).catch(() => false);
    let rankingsAndIndices;

    if (harvesterExists) {
        console.log(`[AGGREGATOR] 🚀 Harvester monolith found. Using for global indexing (O(1) R2 Bandwidth)...`);
        rankingsAndIndices = await calculateGlobalStats(async (consumer) => {
            // Internal wrapper to stream the monolith as a single "shard" for indexing
            const data = await fs.readFile(entitiesInputPath);
            const zlib = await import('zlib');
            const decompressed = (entitiesInputPath.endsWith('.gz') || (data[0] === 0x1f && data[1] === 0x8b)) ? zlib.gunzipSync(data).toString('utf-8') : data.toString('utf-8');
            const parsed = JSON.parse(decompressed);
            const entities = Array.isArray(parsed) ? parsed : (parsed.entities || []);
            await consumer(entities, 0);
        }, CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
    } else {
        rankingsAndIndices = await calculateGlobalStats(loadRegistryShardsSequentially, CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
    }

    const { rankingsMap, registryMap } = rankingsAndIndices;
    console.log(`✓ Global rankings and registry mapping aligned for ${rankingsMap.size} entities.`);

    // 1.5. Pass 1.5: Pre-process Harvester Deltas (O(S) Optimization)
    // Align updates with registry shards BEFORE passing to merge
    await preProcessDeltas(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS, registryMap);

    let successCount = 0;
    let fullSet = []; // We will accumulate this ONLY for satellite tasks (slimmed)

    // 2. Pass 2: Shard-Centric Merge (Heavyweight)
    // V18.12.5.20: If Harvester monolith exists, we DO NOT fetch baseline shards from R2.
    // Instead, we treat the monolith as the SOLE source of truth and partition it.
    console.log(`[AGGREGATOR] Pass 2/2: Performing Partitioned Shard Merge (Hash-Join)...`);

    if (harvesterExists) {
        console.log(`[AGGREGATOR] 🚀 Monolith Mode: Partitioning Harvester output into shards...`);
        // We still use loadRegistryShardsSequentially but we pass it a special consumer 
        // that only looks at the monolith we already loaded in rankingsAndIndices.
        // Actually, for maximum safety and memory control, we manually partition here.
        const data = await fs.readFile(entitiesInputPath);
        const zlib = await import('zlib');
        const decompressed = (entitiesInputPath.endsWith('.gz') || (data[0] === 0x1f && data[1] === 0x8b)) ? zlib.gunzipSync(data).toString('utf-8') : data.toString('utf-8');
        const allEntities = JSON.parse(decompressed);
        const entities = Array.isArray(allEntities) ? allEntities : (allEntities.entities || []);

        for (let i = 0; i < CONFIG.TOTAL_SHARDS; i++) {
            const shardEntities = entities.filter((_, idx) => idx % CONFIG.TOTAL_SHARDS === i);
            if (shardEntities.length > 0) {
                // Apply global rankings calculated in Pass 1
                for (const e of shardEntities) {
                    e.fni_percentile = rankingsMap.get(e.id) || 0;
                    if (needsSlimming || !taskArg || taskArg === 'health') fullSet.push(e);
                }
                if (!needsSlimming) {
                    await saveRegistryShard(i, shardEntities);
                }
                successCount++;
            }
        }
    } else {
        // LEGACY/INCREMENTAL MODE: Only used if no monolith is found
        await loadRegistryShardsSequentially(async (baselineEntities, shardIdx) => {
            const mergedShard = await mergePartitionedShard(
                baselineEntities,
                shardIdx,
                rankingsMap,
                { slim: needsSlimming }
            );

            if (!needsSlimming) {
                await saveRegistryShard(shardIdx, mergedShard.entities);
            }

            if (needsSlimming || !taskArg || taskArg === 'health') {
                for (const e of mergedShard.entities) fullSet.push(e);
            }

            successCount++;
            mergedShard.entities = null;
        }, { slim: needsSlimming });
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

    if (!taskArg || taskArg === 'health') {
        await generateHealthReport(successCount, fullSet, CONFIG.TOTAL_SHARDS, CONFIG.MIN_SUCCESS_RATE, CONFIG.OUTPUT_DIR);
    }

    const rankedEntities = fullSet; // fullSet is already slimmed if needsSlimming, and contains rankings

    const tasks = [
        { name: 'Trending', id: 'trending', fn: () => generateTrending(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Rankings', id: 'rankings', fn: () => generateRankings(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Search', id: 'search', fn: () => generateSearchIndices(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Sitemap', id: 'sitemap', fn: () => generateSitemap(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'CategoryStats', id: 'category', fn: () => generateCategoryStats(rankedEntities, CONFIG.OUTPUT_DIR) },
        {
            name: 'Relations', id: 'relations', fn: async () => {
                await generateRelations(rankedEntities, CONFIG.OUTPUT_DIR);
                await computeAltRelations(rankedEntities, CONFIG.OUTPUT_DIR);
                await computeKnowledgeLinks(rankedEntities, CONFIG.OUTPUT_DIR);
                await generateKnowledgeData(CONFIG.OUTPUT_DIR);
                await generateMeshGraph(CONFIG.OUTPUT_DIR);
            }
        },
        {
            name: 'TrendData', id: 'trend', fn: async () => {
                const history = await loadFniHistory();
                await generateTrendData(history, path.join(CONFIG.OUTPUT_DIR, 'cache'));
            }
        }
    ];

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
            if (taskArg) process.exit(1);
        }
    }

    if (!taskArg || taskArg === 'core') {
        try {
            await updateFniHistory(rankedEntities);
            await fs.mkdir('./cache', { recursive: true });
            await backupStateFiles(CONFIG.OUTPUT_DIR, await loadFniHistory(), getWeekNumber());
            await updateDailyAccumulator(rankedEntities, CONFIG.OUTPUT_DIR);
            if (shouldGenerateReport()) await generateDailyReport(CONFIG.OUTPUT_DIR);
            await generateDailyReportsIndex(CONFIG.OUTPUT_DIR);
        } catch (e) {
            console.error(`[AGGREGATOR] ❌ Finalization failed: ${e.message}`);
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AGGREGATOR V18.12.5.15] Partitioned Aggregation Complete! (${duration}s)`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
