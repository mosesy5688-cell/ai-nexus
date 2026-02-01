import fs from 'fs/promises';
import path from 'path';
import { generateRankings } from './lib/rankings-generator.js';
import { generateSearchIndices } from './lib/search-indexer.js';
import { generateTrending } from './lib/trending-generator.js';
import { generateSitemap } from './lib/sitemap-generator.js';
import { generateCategoryStats, getV6Category } from './lib/category-stats-generator.js';
import { generateRelations } from './lib/relations-generator.js';
import { generateDailyReport, updateDailyAccumulator, shouldGenerateReport } from './lib/daily-report.js';
import { generateDailyReportsIndex } from './lib/daily-reports-index.js';
import { saveGlobalRegistry, loadFniHistory, saveFniHistory, loadDailyAccum, saveDailyAccum, syncCacheState } from './lib/cache-manager.js';
import { generateTrendData } from './lib/trend-data-generator.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';
import {
    getWeekNumber, loadShardArtifacts, calculatePercentiles,
    updateFniHistory, generateHealthReport, mergeShardEntities,
    backupStateFiles, checkIncrementalProgress, updateTaskChecksum
} from './lib/aggregator-utils.js';

// Config (Art 3.1, 3.3)
const CONFIG = {
    TOTAL_SHARDS: 20,
    MIN_SUCCESS_RATE: 0.8,
    OUTPUT_DIR: './output',
    ARTIFACT_DIR: './artifacts',
};

// Configuration & Argument Parsing
const args = process.argv.slice(2);
const taskArg = args.find(a => a.startsWith('--task=') || a.startsWith('-t='))?.split('=')[1];
const CHECKPOINT_THRESHOLD = 5.5 * 3600; // 5.5 hours in seconds

// Main
async function main() {
    const startTime = Date.now();
    console.log(`[AGGREGATOR] Phase 2 starting (Task: ${taskArg || 'ALL'})...`);

    process.env.ENABLE_R2_BACKUP = 'true';
    const entitiesInputPath = process.env.ENTITIES_PATH || './data/merged.json';
    const allEntities = JSON.parse(await fs.readFile(entitiesInputPath, 'utf-8'));
    console.log(`✓ Context loaded: ${allEntities.length} entities ready for Knowledge Mesh & Ranking`);

    // V2.0 optimization: In satellite mode, we just load the pre-merged entities
    let fullSet = [];
    if (taskArg && taskArg !== 'core' && taskArg !== 'health') {
        fullSet = allEntities;
        console.log(`[AGGREGATOR] Satellite mode: Using pre-merged context (${fullSet.length} entities)`);
    } else {
        const shardResults = await loadShardArtifacts(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
        fullSet = mergeShardEntities(allEntities, shardResults);
    }

    // V16.7.1: Early Health Report (Resilience) - Only in 'ALL' or 'health' task
    if (!taskArg || taskArg === 'health') {
        const shardResults = await loadShardArtifacts(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
        await generateHealthReport(shardResults, fullSet, CONFIG.TOTAL_SHARDS, CONFIG.MIN_SUCCESS_RATE, CONFIG.OUTPUT_DIR);
    }

    // V2.0 optimization: Avoid re-calculating if already done in core
    let rankedEntities = [];
    if (taskArg && taskArg !== 'core' && taskArg !== 'health' && fullSet.length > 0 && fullSet[0].percentile !== undefined) {
        console.log(`[AGGREGATOR] Context already contains percentiles/categories. Using as-is.`);
        rankedEntities = fullSet;
    } else {
        console.log(`[AGGREGATOR] Calculating percentiles and categories...`);
        const percentiledEntities = calculatePercentiles(fullSet);
        rankedEntities = percentiledEntities.map(e => ({
            ...e,
            category: e.category || getV6Category(e)
        }));
    }

    // Generate outputs with individual Resilience (Try-Catch)
    const tasks = [
        { name: 'Trending', id: 'trending', fn: () => generateTrending(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Rankings', id: 'rankings', fn: () => generateRankings(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Search', id: 'search', fn: () => generateSearchIndices(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Sitemap', id: 'sitemap', fn: () => generateSitemap(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'CategoryStats', id: 'category', fn: () => generateCategoryStats(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Relations', id: 'relations', fn: () => generateRelations(rankedEntities, CONFIG.OUTPUT_DIR) }
    ];

    for (const task of tasks) {
        // Skip if a specific task is requested and this isn't it
        if (taskArg && taskArg !== task.id) continue;

        try {
            // V2.0 Incremental: Skip if data hasn't changed
            if (task.id && await checkIncrementalProgress(task.id, rankedEntities)) continue;

            // Time-Slice Safety: Check if we are approaching GitHub Action 6h limit
            const uptime = process.uptime();
            if (uptime > CHECKPOINT_THRESHOLD) {
                console.warn(`[AGGREGATOR] ⚠️ Approaching 6h limit (${uptime.toFixed(1)}s). Saving checkpoint and exiting.`);
                // In V2.0, next Job or next Run will pick up from registry state
                break;
            }

            console.log(`[AGGREGATOR] Task: ${task.name}...`);
            await task.fn();

            // V2.0 Incremental: Update checksum after success
            if (task.id) await updateTaskChecksum(task.id, rankedEntities);
        } catch (e) {
            console.error(`[AGGREGATOR] ❌ Task ${task.name} failed: ${e.message}`);
        }
    }

    // Only skip file writes if we are running in 'light' satellite mode
    // Most tasks need the updated entities.json
    if (!taskArg || taskArg === 'core' || taskArg === 'relations') {
        const entitiesOutputPath = path.join(CONFIG.OUTPUT_DIR, 'entities.json');
        await fs.writeFile(entitiesOutputPath, JSON.stringify(rankedEntities, null, 2));
    }

    // 5. Historical State & Trends (V14.5) - Only if in 'core' or 'ALL' mode
    if (!taskArg || taskArg === 'core') {
        try {
            await updateFniHistory(rankedEntities);
            const historyData = await loadFniHistory();
            const weekNumber = getWeekNumber();

            // 6. State Persistence
            process.env.CACHE_DIR = path.join(CONFIG.OUTPUT_DIR, 'meta', 'backup');
            await fs.mkdir(process.env.CACHE_DIR, { recursive: true });

            // Backup sharded history
            await saveFniHistory(historyData);

            await backupStateFiles(CONFIG.OUTPUT_DIR, historyData, weekNumber);

            // V16.8.2: Ensure accumulator is updated before report generation
            await updateDailyAccumulator(rankedEntities, CONFIG.OUTPUT_DIR);

            if (shouldGenerateReport()) await generateDailyReport(CONFIG.OUTPUT_DIR);
            await generateDailyReportsIndex(CONFIG.OUTPUT_DIR);
        } catch (e) {
            console.error(`[AGGREGATOR] ❌ State/Report tasks failed: ${e.message}`);
        }

        // Registry Persistence (V2.0 Sharded)
        console.log(`[AGGREGATOR] 💾 Persisting sharded registry...`);
        await saveGlobalRegistry({
            entities: rankedEntities,
            count: rankedEntities.length,
            lastUpdated: new Date().toISOString()
        });

        // GitHub Actions Cache Sync (Robust V2.0 Sync)
        const CACHE_DIR = './cache';
        await syncCacheState(process.env.CACHE_DIR, CACHE_DIR);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AGGREGATOR V16.8.2] Phase 2 complete! (Duration: ${duration}s)`);
    console.log(`[SCALE] Successfully processed and indexed ${rankedEntities.length} entities for the Knowledge Mesh.`);
}

main().catch(console.error);
