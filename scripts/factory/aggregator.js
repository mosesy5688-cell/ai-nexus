import fs from 'fs/promises';
import path from 'path';
import { generateRankings } from './lib/rankings-generator.js';
import { generateSearchIndices } from './lib/search-indexer.js';
import { generateTrending } from './lib/trending-generator.js';
import { generateSitemap } from './lib/sitemap-generator.js';
import { generateCategoryStats, getV6Category } from './lib/category-stats-generator.js';
import { generateRelations } from './lib/relations-generator.js';
import { updateWeeklyAccumulator, shouldGenerateReport, generateWeeklyReport } from './lib/weekly-report.js';
import { saveGlobalRegistry, loadFniHistory, loadWeeklyAccum, saveWeeklyAccum } from './lib/cache-manager.js';
import { generateTrendData } from './lib/trend-data-generator.js';
import { generateReportsIndex } from './lib/reports-index-generator.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';
import {
    getWeekNumber, loadShardArtifacts, calculatePercentiles,
    updateFniHistory, generateHealthReport, mergeShardEntities,
    backupStateFiles
} from './lib/aggregator-utils.js';

// Config (Art 3.1, 3.3)
const CONFIG = {
    TOTAL_SHARDS: 20,
    MIN_SUCCESS_RATE: 0.8,
    OUTPUT_DIR: './output',
    ARTIFACT_DIR: './artifacts',
};

// Main
async function main() {
    console.log('[AGGREGATOR] Phase 2 starting (Stateful Mode)...');

    process.env.ENABLE_R2_BACKUP = 'true';
    const entitiesInputPath = process.env.ENTITIES_PATH || './data/merged.json';
    const allEntities = JSON.parse(await fs.readFile(entitiesInputPath, 'utf-8'));
    console.log(`✓ Context loaded: ${allEntities.length} entities ready for Knowledge Mesh & Ranking`);

    const shardResults = await loadShardArtifacts(CONFIG.ARTIFACT_DIR, CONFIG.TOTAL_SHARDS);
    const fullSet = mergeShardEntities(allEntities, shardResults);

    const percentiledEntities = calculatePercentiles(fullSet);

    // V16.4.4: Inject Deterministic Category (Art 3.1)
    // Ensures rankings and category_stats use the same classification
    const rankedEntities = percentiledEntities.map(e => ({
        ...e,
        category: getV6Category(e)
    }));

    // Generate outputs
    await generateTrending(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateRankings(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateSearchIndices(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateSitemap(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateCategoryStats(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateRelations(rankedEntities, CONFIG.OUTPUT_DIR);

    const entitiesOutputPath = path.join(CONFIG.OUTPUT_DIR, 'entities.json');
    await fs.writeFile(entitiesOutputPath, JSON.stringify(rankedEntities, null, 2));

    // 5. Historical State & Trends (V14.5)
    // We load historical state from GH Cache (default ./cache)
    await updateFniHistory(rankedEntities);

    const historyData = await loadFniHistory();
    const weekNumber = getWeekNumber();

    // 6. State Persistence (V14.5.3: Backup to Output for 4/4 Upload)
    process.env.CACHE_DIR = path.join(CONFIG.OUTPUT_DIR, 'meta', 'backup');
    await fs.mkdir(process.env.CACHE_DIR, { recursive: true });
    await backupStateFiles(CONFIG.OUTPUT_DIR, historyData, weekNumber);

    if (shouldGenerateReport()) await generateWeeklyReport(CONFIG.OUTPUT_DIR);
    await generateReportsIndex(CONFIG.OUTPUT_DIR);
    await generateHealthReport(shardResults, rankedEntities, CONFIG.TOTAL_SHARDS, CONFIG.MIN_SUCCESS_RATE, CONFIG.OUTPUT_DIR);

    // Registry Persistence
    await saveGlobalRegistry({
        entities: rankedEntities,
        count: rankedEntities.length,
        lastUpdated: new Date().toISOString()
    });

    // GitHub Actions Cache Sync
    const CACHE_DIR = './cache';
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const registryFiles = ['global-registry.json', 'entity-checksums.json', 'fni-history.json', 'weekly-accum.json'];

    for (const file of registryFiles) {
        const sourcePath = path.join(process.env.CACHE_DIR, file);
        const targetPath = path.join(CACHE_DIR, file);
        try { await fs.copyFile(sourcePath, targetPath); }
        catch (e) { if (file === 'global-registry.json') console.warn(`[CACHE] Failed: ${file}`); }
    }

    console.log('[AGGREGATOR] Phase 2 complete!');
}

main().catch(console.error);
