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
import { saveGlobalRegistry, loadFniHistory, saveFniHistory, syncCacheState, loadEntityChecksums, saveEntityChecksums } from './lib/cache-manager.js';
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
    CODE_VERSION: 'v16.96.1', // Increment this to bust incremental task cache
};

// Configuration & Argument Parsing
const args = process.argv.slice(2);
const taskArg = args.find(a => a.startsWith('--task=') || a.startsWith('-t='))?.split('=')[1];
const CHECKPOINT_THRESHOLD = 5.5 * 3600; // 5.5 hours in seconds

// Main
async function main() {
    const startTime = Date.now();
    console.log(`[AGGREGATOR] Phase 2 starting (Task: ${taskArg || 'ALL'})...`);
    // V17.2: R2 backups re-enabled for historical state continuity (CES Compliant)
    process.env.ENABLE_R2_BACKUP = 'true';
    const entitiesInputPath = process.env.ENTITIES_PATH || './data/merged.json';
    console.log(`[AGGREGATOR] Loading context from: ${entitiesInputPath}`);
    const allEntities = JSON.parse(await fs.readFile(entitiesInputPath, 'utf-8'));
    console.log(`✓ Context loaded: ${allEntities.length} entities ready for Knowledge Mesh & Ranking`);

    // V16.96.2: Threshold adjusted from 210k to 85k to account for ArXiv version deduplication
    const AGGREGATE_FLOOR = 85000;
    if (allEntities.length < AGGREGATE_FLOOR) {
        throw new Error(`[CRITICAL] Data Loss Detected! Only ${allEntities.length} entities found (Required: ${AGGREGATE_FLOOR}). Aggregation aborted to protect production metrics.`);
    }

    // V2.0 optimization: In satellite mode, we just load the pre-merged entities
    let fullSet = [];
    let shardResults = null;
    if (taskArg && taskArg !== 'core' && taskArg !== 'health') {
        fullSet = allEntities;
        console.log(`[AGGREGATOR] Satellite mode: Using pre-merged context (${fullSet.length} entities)`);
    } else {
        shardResults = await loadShardArtifacts(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
        fullSet = mergeShardEntities(allEntities, shardResults);

        // V16.11: Consolidate entity checksums from shards to support future incremental runs
        console.log('[AGGREGATOR] Consolidating entity checksums...');
        const checksums = await loadEntityChecksums();
        for (const shard of shardResults) {
            if (shard?.entities) {
                for (const result of shard.entities) {
                    if (result.success && result._checksum) {
                        checksums[result.id] = result._checksum;
                    }
                }
            }
        }
        await saveEntityChecksums(checksums);
    }

    // V16.7.1: Early Health Report (Resilience) - Only in 'ALL' or 'health' task
    if (!taskArg || taskArg === 'health') {
        const resultsForHealth = shardResults || await loadShardArtifacts(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
        await generateHealthReport(resultsForHealth, fullSet, CONFIG.TOTAL_SHARDS, CONFIG.MIN_SUCCESS_RATE, CONFIG.OUTPUT_DIR);
    }

    // V2.0 optimization: Avoid re-calculating if already done in core
    let rankedEntities = [];
    if (taskArg && taskArg !== 'core' && taskArg !== 'health' && fullSet.length > 0 && fullSet[0].percentile !== undefined) {
        console.log(`[AGGREGATOR] Context already contains percentiles/categories. Using as-is.`);
        rankedEntities = fullSet;
    } else {
        console.log(`[AGGREGATOR] Calculating percentiles and categories...`);
        const percentiledEntities = calculatePercentiles(fullSet);
        rankedEntities = percentiledEntities.map(e => {
            // V16.96.1: Force re-evaluation of category to apply updated V6 rules
            const freshCategory = getV6Category(e);
            return {
                ...e,
                category: freshCategory
            };
        });
    }

    // Generate outputs with individual Resilience (Try-Catch)
    const tasks = [
        { name: 'Trending', id: 'trending', fn: () => generateTrending(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Rankings', id: 'rankings', fn: () => generateRankings(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Search', id: 'search', fn: () => generateSearchIndices(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Sitemap', id: 'sitemap', fn: () => generateSitemap(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'CategoryStats', id: 'category', fn: () => generateCategoryStats(rankedEntities, CONFIG.OUTPUT_DIR) },
        { name: 'Relations', id: 'relations', fn: () => generateRelations(rankedEntities, CONFIG.OUTPUT_DIR) },
        {
            name: 'TrendData', id: 'trend', fn: async () => {
                const history = await loadFniHistory();
                return generateTrendData(history, path.join(CONFIG.OUTPUT_DIR, 'cache'));
            }
        }
    ];


    for (const task of tasks) {
        // Skip if a specific task is requested and this isn't it
        if (taskArg && taskArg !== task.id) continue;

        try {
            // V2.0 Incremental: Skip if data hasn't changed (Injected CODE_VERSION to detect logic changes)
            if (task.id && await checkIncrementalProgress(task.id, rankedEntities, CONFIG.CODE_VERSION)) continue;

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
            if (task.id) await updateTaskChecksum(task.id, rankedEntities, CONFIG.CODE_VERSION);
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
            process.env.CACHE_DIR = './cache';
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

        // Mirroring (V17.5+)
        const backupDir = path.join(CONFIG.OUTPUT_DIR, 'meta', 'backup');
        await fs.mkdir(backupDir, { recursive: true });

        const monoliths = ['global-registry.json', 'fni-history.json', 'daily-accum.json', 'entity-checksums.json'];
        for (const file of monoliths) {
            const src = path.join(process.env.CACHE_DIR, file);
            try {
                await fs.access(src);
                await fs.copyFile(src, path.join(backupDir, file));
            } catch { }
        }

        const syncDirs = [
            { src: 'registry', dest: 'registry' },
            { src: 'fni-history', dest: 'fni-history' },
            { src: 'daily-accum', dest: 'daily-accum' }
        ];
        for (const dir of syncDirs) {
            const srcPath = path.join(process.env.CACHE_DIR, dir.src);
            const destPath = path.join(backupDir, dir.dest);
            try {
                await fs.access(srcPath);
                await fs.mkdir(destPath, { recursive: true });
                const files = await fs.readdir(srcPath);
                for (const f of files) await fs.copyFile(path.join(srcPath, f), path.join(destPath, f));
            } catch { }
        }

        const reportsSrcDir = path.join(CONFIG.OUTPUT_DIR, 'cache', 'reports');
        const reportsDestDir = path.join(backupDir, 'reports');
        const dailySrcDir = path.join(CONFIG.OUTPUT_DIR, 'daily');
        const dailyDestDir = path.join(backupDir, 'daily');

        try {
            await fs.mkdir(reportsDestDir, { recursive: true });
            if (await fs.stat(reportsSrcDir).catch(() => null)) {
                const reportFiles = await fs.readdir(reportsSrcDir);
                for (const file of reportFiles) {
                    const src = path.join(reportsSrcDir, file);
                    const dest = path.join(reportsDestDir, file);
                    const stat = await fs.stat(src);
                    if (stat.isFile()) await fs.copyFile(src, dest);
                    else if (stat.isDirectory()) {
                        await fs.mkdir(path.join(reportsDestDir, file), { recursive: true });
                        const subFiles = await fs.readdir(src);
                        for (const sub of subFiles) await fs.copyFile(path.join(src, sub), path.join(reportsDestDir, file, sub));
                    }
                }
            }
            await fs.mkdir(dailyDestDir, { recursive: true });
            if (await fs.stat(dailySrcDir).catch(() => null)) {
                const dailyFiles = await fs.readdir(dailySrcDir);
                for (const file of dailyFiles) await fs.copyFile(path.join(dailySrcDir, file), path.join(dailyDestDir, file));
            }
        } catch (e) { }

        await syncCacheState(process.env.CACHE_DIR, './cache');
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AGGREGATOR V16.8.7] Phase 2 complete! (Duration: ${duration}s)`);
    console.log(`[SCALE] Successfully processed and indexed ${rankedEntities.length} entities for the Knowledge Mesh.`);
}

main().catch(console.error);
