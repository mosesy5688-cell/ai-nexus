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
import {
    calculatePercentiles, updateFniHistory,
    processShardsIteratively
} from './lib/aggregator-utils.js';
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
    // Extracts scores from all shards to calculate global rankings
    const needsSlimming = !!taskArg && taskArg !== 'core';
    const { loadRegistryShardsSequentially } = await import('./lib/registry-loader.js');
    const { calculateGlobalStats, mergePartitionedShard } = await import('./lib/aggregator-utils.js');
    const { saveRegistryShard } = await import('./lib/registry-saver.js');

    const rankingsAndIndices = await calculateGlobalStats(loadRegistryShardsSequentially, CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
    const { rankingsMap, updateIndexMap } = rankingsAndIndices;
    console.log(`✓ Global rankings and update indices aligned for ${rankingsMap.size} entities.`);

    let successCount = 0;
    let fullSet = []; // We will accumulate this ONLY for satellite tasks (slimmed)

    // 2. Pass 2: Shard-Centric Merge (Heavyweight)
    // We process each baseline shard sequentially to keep heap usage O(1)
    console.log(`[AGGREGATOR] Pass 2/2: Performing Partitioned Shard Merge...`);

    await loadRegistryShardsSequentially(async (baselineEntities, shardIdx) => {
        // Partitioned Merge: Merge this baseline shard with its corresponding update shard
        const mergedShard = await mergePartitionedShard(
            baselineEntities,
            shardIdx,
            CONFIG.ARTIFACT_DIR,
            CONFIG.TOTAL_SHARDS,
            rankingsMap,
            updateIndexMap,
            { slim: needsSlimming }
        );

        if (!needsSlimming) {
            // In Core Task, save the full metadata shard immediately to R2/Local
            await saveRegistryShard(shardIdx, mergedShard.entities);
        }

        // For satellite tasks or final health check, accumulate the slimmed entities
        if (needsSlimming || !taskArg || taskArg === 'health') {
            for (const e of mergedShard.entities) fullSet.push(e);
        }

        successCount++;
        // Explicitly clear references to allow GC
        mergedShard.entities = null;
    }, { slim: needsSlimming });

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
