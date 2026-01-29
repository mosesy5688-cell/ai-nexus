/**
 * Factory Aggregator V14.5 (CES Compliant)
 * 
 * Constitution: Art 3.1 (Aggregator), Art 5 (Weekly), Art 6.3 (Search), Art 8.3 (Health)
 * V14.5: Uses cache-manager for GH Cache + R2 backup strategy
 * 
 * Usage: node scripts/factory/aggregator.js
 */

import fs from 'fs/promises';
import path from 'path';
import { dedupCrossPlatform } from './cross-platform-dedup.js';
import { generateRankings } from './lib/rankings-generator.js';
import { generateSearchIndices } from './lib/search-indexer.js';
import { generateTrending } from './lib/trending-generator.js';
import { generateSitemap } from './lib/sitemap-generator.js';
import { generateCategoryStats } from './lib/category-stats-generator.js';
import { generateRelations } from './lib/relations-generator.js';
import { updateWeeklyAccumulator, shouldGenerateReport, generateWeeklyReport } from './lib/weekly-report.js';
import { RegistryManager } from './lib/registry-manager.js';
import { backupToR2Output } from './lib/smart-writer.js';
import { loadFniHistory, saveFniHistory, loadWeeklyAccum, saveWeeklyAccum } from './lib/cache-manager.js';
import { generateTrendData } from './lib/trend-data-generator.js'; // V14.5 Phase 5
import { generateReportsIndex } from './lib/reports-index-generator.js'; // V16.2: Knowledge Mesh
import { normalizeId } from './lib/relation-extractors.js';

// Config (Art 3.1, 3.3)
const CONFIG = {
    TOTAL_SHARDS: 20,
    MIN_SUCCESS_RATE: 0.8, // Art 3.3: 80% threshold
    OUTPUT_DIR: './output',
    ARTIFACT_DIR: './artifacts',
};

// SPEC-BACKUP-V14.5: Get week number for backup file naming
function getWeekNumber() {
    const now = new Date();
    const year = now.getFullYear();
    const oneJan = new Date(year, 0, 1);
    const weekNum = Math.ceil(((now - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
    return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

// Load shard artifacts
async function loadShardArtifacts() {
    const artifacts = [];
    for (let i = 0; i < CONFIG.TOTAL_SHARDS; i++) {
        try {
            const filePath = path.join(CONFIG.ARTIFACT_DIR, `shard-${i}.json`);
            artifacts.push(JSON.parse(await fs.readFile(filePath, 'utf-8')));
        } catch {
            console.warn(`[WARN] Shard ${i} not found`);
            artifacts.push(null);
        }
    }
    return artifacts;
}

// Validate shard success rate (Art 3.3)
function validateShardSuccess(shardResults) {
    const successful = shardResults.filter(s => s !== null).length;
    const rate = successful / CONFIG.TOTAL_SHARDS;
    console.log(`[AGGREGATOR] Shards: ${successful}/${CONFIG.TOTAL_SHARDS} (${(rate * 100).toFixed(1)}%)`);
    return rate;
}

// Merge entities from all shards
function mergeShardEntities(shardResults) {
    const entities = [];
    for (const shard of shardResults) {
        if (shard?.entities) {
            entities.push(...shard.entities.filter(e => e.success));
        }
    }
    return entities;
}

// Calculate percentiles
function calculatePercentiles(entities) {
    const sorted = [...entities].sort((a, b) => b.fni - a.fni);
    return sorted.map((e, i) => ({
        ...e,
        percentile: Math.round((1 - i / sorted.length) * 100),
    }));
}

// Update FNI history (V14.5: uses cache-manager for GH Cache + R2 backup)
async function updateFniHistory(entities) {
    console.log('[AGGREGATOR] Updating FNI history...');

    // V14.5: Load from GH Cache → R2 backup → cold start
    const historyData = await loadFniHistory();
    const history = historyData.entities || {};

    const today = new Date().toISOString().split('T')[0];
    for (const e of entities) {
        if (!history[e.id]) history[e.id] = [];
        history[e.id].push({ date: today, score: e.fni });
        history[e.id] = history[e.id].slice(-7); // 7-day rolling (Art 4.2)
    }

    // V14.5: Save to GH Cache + R2 backup automatically
    await saveFniHistory({ entities: history });

    console.log(`  [HISTORY] Updated ${Object.keys(history).length} entities`);
}

// Generate health report (Art 8.3)
async function generateHealthReport(shardResults, entities) {
    const today = new Date().toISOString().split('T')[0];
    const successful = shardResults.filter(s => s !== null).length;

    const health = {
        date: today,
        shardSuccessRate: successful / CONFIG.TOTAL_SHARDS,
        totalEntities: entities.length,
        timestamp: new Date().toISOString(),
        status: successful >= CONFIG.TOTAL_SHARDS * CONFIG.MIN_SUCCESS_RATE ? 'healthy' : 'degraded',
    };

    const healthDir = path.join(CONFIG.OUTPUT_DIR, 'meta', 'health');
    await fs.mkdir(healthDir, { recursive: true });
    await fs.writeFile(path.join(healthDir, `${today}.json`), JSON.stringify(health, null, 2));

    console.log(`[HEALTH] Status: ${health.status}`);
}

// Main
async function main() {
    console.log('[AGGREGATOR] Phase 2 starting (Stateful Mode)...');

    // V16.2.5: Architecture alignment - Aggregator should NOT upload to R2
    // Instead, it saves to output/meta/backup for 4/4 to pick up.
    process.env.ENABLE_R2_BACKUP = 'false';
    const OLD_CACHE_DIR = process.env.CACHE_DIR || './cache';

    // 3. Extract entities from current shards
    // V16.2.5 Optimization: Since 1/4 already merged the registry into shards,
    // we don't need to reload or re-merge the registry here.
    const allEntities = mergeShardEntities(shardResults);
    console.log(`✓ Collection complete: ${allEntities.length} entities from shards ready for indexing`);

    // 4. Calculate percentiles
    const rankedEntities = calculatePercentiles(allEntities);

    // 5. Generate trending.json (CRITICAL for homepage)
    await generateTrending(rankedEntities, CONFIG.OUTPUT_DIR);

    // 6. Generate outputs
    await generateRankings(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateSearchIndices(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateSitemap(rankedEntities, CONFIG.OUTPUT_DIR);  // V14.4: Category-based sitemaps
    await generateCategoryStats(rankedEntities, CONFIG.OUTPUT_DIR);  // V14.4: Homepage categories
    await generateRelations(rankedEntities, CONFIG.OUTPUT_DIR);  // V14.4: Knowledge linking

    // V14.5.2: Write entities.json for factory-linker (CRITICAL for Knowledge Graph)
    const entitiesPath = path.join(CONFIG.OUTPUT_DIR, 'entities.json');
    await fs.writeFile(entitiesPath, JSON.stringify(rankedEntities, null, 2));
    console.log(`[AGGREGATOR] Wrote ${rankedEntities.length} entities to ${entitiesPath}`);

    // V16.2.5: Switch cache dir to output for final saves so 4/4 picks them up
    // The path 'output/meta/backup' aligns with R2 expectations when 'output/' is stripped.
    process.env.CACHE_DIR = path.join(CONFIG.OUTPUT_DIR, 'meta', 'backup');
    await fs.mkdir(process.env.CACHE_DIR, { recursive: true });

    await updateFniHistory(rankedEntities);

    // SPEC-BACKUP-V14.5 Section 3.2: Cold Backup Snapshot for FNI History
    const fniHistory = await loadFniHistory();
    const weekNumber = getWeekNumber();
    const fniBackupPath = path.join(CONFIG.OUTPUT_DIR, 'meta', 'backup', 'fni-history', `fni-history-${weekNumber}.json`);
    await fs.mkdir(path.dirname(fniBackupPath), { recursive: true });
    await fs.writeFile(fniBackupPath, JSON.stringify(fniHistory, null, 2));
    console.log(`[BACKUP] FNI History snapshot: ${weekNumber}`);

    // V14.5 Phase 5: Generate trend data for frontend charts
    await generateTrendData(fniHistory, path.join(CONFIG.OUTPUT_DIR, 'cache'));

    await updateWeeklyAccumulator(rankedEntities, CONFIG.OUTPUT_DIR);

    // SPEC-BACKUP-V14.5: Cold Backup for Weekly Accumulator
    const accumBackupPath = path.join(CONFIG.OUTPUT_DIR, 'meta', 'backup', 'accum', `accum-${weekNumber}.json`);
    await fs.mkdir(path.dirname(accumBackupPath), { recursive: true });
    try {
        const accum = await loadWeeklyAccum();
        await fs.writeFile(accumBackupPath, JSON.stringify(accum, null, 2));
        console.log(`[BACKUP] Weekly Accumulator snapshot: ${weekNumber}`);
    } catch (accumErr) {
        console.warn(`[BACKUP] Weekly Accumulator backup skipped: ${accumErr.message}`);
    }

    // 7. Generate weekly report based on schedule
    if (shouldGenerateReport()) {
        await generateWeeklyReport(CONFIG.OUTPUT_DIR);
    }

    // V16.2: Generate reports index (always, for reports listing)
    await generateReportsIndex(CONFIG.OUTPUT_DIR);

    // 8. Health report (Art 8.3)
    await generateHealthReport(shardResults, rankedEntities);

    console.log('[AGGREGATOR] Phase 2 complete!');
}

main().catch(console.error);
