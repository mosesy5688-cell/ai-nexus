/**
 * Factory Aggregator V14.4 (CES Compliant)
 * 
 * Constitution: Art 3.1 (Aggregator), Art 5 (Weekly), Art 6.3 (Search), Art 8.3 (Health)
 * Reuses: scripts/fni/fni-calc.js, lib/ modules
 * 
 * Usage: node scripts/factory/aggregator.js
 */

import fs from 'fs/promises';
import path from 'path';
import { generateRankings } from './lib/rankings-generator.js';
import { generateSearchIndices } from './lib/search-indexer.js';
import { generateTrending } from './lib/trending-generator.js';
import { generateSitemap } from './lib/sitemap-generator.js';
import { updateWeeklyAccumulator, isSunday, generateWeeklyReport } from './lib/weekly-report.js';
import { backupToR2Output } from './lib/smart-writer.js';

// Config (Art 3.1, 3.3)
const CONFIG = {
    TOTAL_SHARDS: 20,
    MIN_SUCCESS_RATE: 0.8, // Art 3.3: 80% threshold
    OUTPUT_DIR: './output',
    ARTIFACT_DIR: './artifacts',
};

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

// Update FNI history
async function updateFniHistory(entities) {
    console.log('[AGGREGATOR] Updating FNI history...');

    let history = {};
    try {
        history = JSON.parse(await fs.readFile('./cache/fni-history.json', 'utf-8'));
    } catch { /* start fresh */ }

    const today = new Date().toISOString().split('T')[0];
    for (const e of entities) {
        if (!history[e.id]) history[e.id] = [];
        history[e.id].push({ date: today, score: e.fni });
        history[e.id] = history[e.id].slice(-7); // 7-day rolling (Art 4.2)
    }

    await fs.mkdir('./cache', { recursive: true });
    await fs.writeFile('./cache/fni-history.json', JSON.stringify(history, null, 2));
    await backupToR2Output('./cache/fni-history.json', CONFIG.OUTPUT_DIR);

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
    console.log('[AGGREGATOR] Phase 2 starting...');

    // 1. Load shard artifacts
    const shardResults = await loadShardArtifacts();

    // 2. Validate success rate (Art 3.3)
    const successRate = validateShardSuccess(shardResults);
    if (successRate < CONFIG.MIN_SUCCESS_RATE) {
        console.error(`[FAIL] Success rate ${(successRate * 100).toFixed(1)}% < 80%`);
        process.exit(1);
    }

    // 3. Merge entities
    const allEntities = mergeShardEntities(shardResults);
    console.log(`[AGGREGATOR] Merged ${allEntities.length} entities`);

    // 4. Calculate percentiles
    const rankedEntities = calculatePercentiles(allEntities);

    // 5. Generate trending.json (CRITICAL for homepage)
    await generateTrending(rankedEntities, CONFIG.OUTPUT_DIR);

    // 6. Generate outputs
    await generateRankings(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateSearchIndices(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateSitemap(rankedEntities, CONFIG.OUTPUT_DIR);  // V14.4: Category-based sitemaps
    await updateFniHistory(rankedEntities);
    await updateWeeklyAccumulator(rankedEntities, CONFIG.OUTPUT_DIR);

    // 7. Sunday: Generate weekly report (Art 5.2)
    if (isSunday()) {
        await generateWeeklyReport(CONFIG.OUTPUT_DIR);
    }

    // 8. Health report (Art 8.3)
    await generateHealthReport(shardResults, rankedEntities);

    console.log('[AGGREGATOR] Phase 2 complete!');
}

main().catch(console.error);
