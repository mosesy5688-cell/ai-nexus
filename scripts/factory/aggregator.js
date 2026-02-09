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
    getWeekNumber, loadShardArtifacts, calculatePercentiles,
    updateFniHistory, generateHealthReport, mergeShardEntities,
    backupStateFiles
} from './lib/aggregator-utils.js';
import { checkIncrementalProgress, updateTaskChecksum } from './lib/aggregator-incremental.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';

// Config (Art 3.1, 3.3)
const CONFIG = {
    TOTAL_SHARDS: 20,
    MIN_SUCCESS_RATE: 0.8,
    OUTPUT_DIR: './output',
    ARTIFACT_DIR: './artifacts',
    CODE_VERSION: 'v16.11.1', // Increment this to bust incremental task cache
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
    let entitiesInputPath = process.env.ENTITIES_PATH || './data/merged.json';

    // Transparent .gz fallback
    if (!await fs.access(entitiesInputPath).then(() => true).catch(() => false)) {
        if (!entitiesInputPath.endsWith('.gz')) {
            const gzPath = entitiesInputPath + '.gz';
            if (await fs.access(gzPath).then(() => true).catch(() => false)) {
                entitiesInputPath = gzPath;
            }
        }
    }

    let data = await fs.readFile(entitiesInputPath);
    if (entitiesInputPath.endsWith('.gz') || (data[0] === 0x1f && data[1] === 0x8b)) {
        const zlib = await import('zlib');
        data = zlib.gunzipSync(data);
    }
    const allEntities = JSON.parse(data.toString('utf-8'));
    console.log(`✓ Context loaded: ${allEntities.length} entities ready`);

    const AGGREGATE_FLOOR = 85000;
    if (allEntities.length < AGGREGATE_FLOOR) {
        throw new Error(`[CRITICAL] Data Loss Detected! Only ${allEntities.length} entities found.`);
    }

    let fullSet = [];
    let shardResults = null;
    if (taskArg && taskArg !== 'core' && taskArg !== 'health') {
        fullSet = allEntities;
    } else {
        shardResults = await loadShardArtifacts(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
        fullSet = mergeShardEntities(allEntities, shardResults);

        const checksums = await loadEntityChecksums();
        for (const shard of shardResults) {
            if (shard?.entities) {
                for (const result of shard.entities) {
                    if (result.success && result._checksum) checksums[result.id] = result._checksum;
                }
            }
        }
        await saveEntityChecksums(checksums);
    }

    if (!taskArg || taskArg === 'health') {
        const resultsForHealth = shardResults || await loadShardArtifacts(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
        await generateHealthReport(resultsForHealth, fullSet, CONFIG.TOTAL_SHARDS, CONFIG.MIN_SUCCESS_RATE, CONFIG.OUTPUT_DIR);
    }

    let rankedEntities = [];
    if (taskArg && taskArg !== 'core' && taskArg !== 'health' && fullSet.length > 0 && fullSet[0].percentile !== undefined) {
        rankedEntities = fullSet;
    } else {
        const percentiledEntities = calculatePercentiles(fullSet);
        rankedEntities = percentiledEntities.map(e => ({ ...e, category: getV6Category(e) }));
    }

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
                return generateTrendData(history, path.join(CONFIG.OUTPUT_DIR, 'cache'));
            }
        }
    ];

    for (const task of tasks) {
        if (taskArg && taskArg !== task.id) continue;
        try {
            if (task.id && await checkIncrementalProgress(task.id, rankedEntities, CONFIG.CODE_VERSION)) continue;
            if (process.uptime() > CHECKPOINT_THRESHOLD) break;
            console.log(`[AGGREGATOR] Task: ${task.name}...`);

            // Set shared environment for satellite tasks
            process.env.ENTITIES_PATH = path.join(CONFIG.OUTPUT_DIR, 'entities.json.gz');

            await task.fn();
            if (task.id) await updateTaskChecksum(task.id, rankedEntities, CONFIG.CODE_VERSION);
        } catch (e) { console.error(`[AGGREGATOR] ❌ Task ${task.name} failed: ${e.message}`); }
    }

    if (!taskArg || taskArg === 'core' || taskArg === 'relations') {
        const entitiesOutputPath = path.join(CONFIG.OUTPUT_DIR, 'entities.json.gz');
        const zlib = await import('zlib');
        const compressed = zlib.gzipSync(JSON.stringify(rankedEntities));
        await fs.writeFile(entitiesOutputPath, compressed);
        console.log(`[AGGREGATOR] ✅ Persisted compressed entities: ${entitiesOutputPath}`);
    }

    if (!taskArg || taskArg === 'core') {
        try {
            await updateFniHistory(rankedEntities);
            process.env.CACHE_DIR = './cache';
            await fs.mkdir(process.env.CACHE_DIR, { recursive: true });

            await backupStateFiles(CONFIG.OUTPUT_DIR, await loadFniHistory(), getWeekNumber());
            await updateDailyAccumulator(rankedEntities, CONFIG.OUTPUT_DIR);

            if (shouldGenerateReport()) await generateDailyReport(CONFIG.OUTPUT_DIR);
            await generateDailyReportsIndex(CONFIG.OUTPUT_DIR);

            // V16.11 Persistence Refactor (CES Compliance)
            await persistRegistry(rankedEntities, CONFIG.OUTPUT_DIR, process.env.CACHE_DIR);
        } catch (e) { console.error(`[AGGREGATOR] ❌ Finalization failed: ${e.message}`); }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AGGREGATOR V16.11.1] Complete! (${duration}s)`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
