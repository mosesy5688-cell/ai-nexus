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
import { loadFniHistory, saveFniHistory, loadWeeklyAccum, saveWeeklyAccum, saveGlobalRegistry } from './lib/cache-manager.js';
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

// Calculate percentiles (Standardizes on fni_score for ranking)
function calculatePercentiles(entities) {
    const sorted = [...entities].sort((a, b) => {
        const aFni = a.fni_score ?? a.fni ?? 0;
        const bFni = b.fni_score ?? b.fni ?? 0;
        return bFni - aFni;
    });

    return sorted.map((e, i) => {
        const finalFni = e.fni_score ?? e.fni ?? 0;
        return {
            ...e,
            fni: finalFni, // Downstream (search/trending/sitemap) expects 'fni'
            fni_score: finalFni, // Registry/Metadata expect 'fni_score'
            percentile: Math.round((1 - i / sorted.length) * 100),
        };
    });
}

// Update FNI history (V14.5: uses cache-manager for GH Cache + R2 backup)
async function updateFniHistory(entities) {
    console.log('[AGGREGATOR] Updating FNI history...');

    // V14.5: Load from GH Cache → R2 backup → cold start
    const historyData = await loadFniHistory();
    const history = historyData.entities || {};

    const today = new Date().toISOString().split('T')[0];
    for (const e of entities) {
        const id = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
        if (!history[id]) history[id] = [];
        const score = e.fni_score ?? e.fni ?? 0;
        history[id].push({ date: today, score: score });
        history[id] = history[id].slice(-7); // 7-day rolling (Art 4.2)
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

    // 3. Load full context (Harvested + Registry Memory from 1/4)
    const entitiesInputPath = process.env.ENTITIES_PATH || './data/merged.json';
    const allEntities = JSON.parse(await fs.readFile(entitiesInputPath, 'utf-8'));
    console.log(`✓ Context loaded: ${allEntities.length} entities ready for Knowledge Mesh & Ranking`);

    // V16.2.10: Load shards and apply updated results to the full context
    const shardResults = await loadShardArtifacts();
    const updatedEntitiesMap = new Map();
    for (const shard of shardResults) {
        if (shard?.entities) {
            for (const result of shard.entities) {
                if (result.success) {
                    updatedEntitiesMap.set(result.id, result);
                }
            }
        }
    }

    // Apply updates to context (ensures rankings show latest 2/4 data)
    const fullSet = allEntities.map(e => {
        const id = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
        const update = updatedEntitiesMap.get(id);
        if (update) {
            return { ...e, ...update, id };
        }
        return { ...e, id };
    });

    // 4. Calculate percentiles (Wakes up dormant assets with new global rankings)
    const rankedEntities = calculatePercentiles(fullSet);

    // 5. Generate trending.json (CRITICAL for homepage)
    await generateTrending(rankedEntities, CONFIG.OUTPUT_DIR);

    // 6. Generate outputs
    await generateRankings(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateSearchIndices(rankedEntities, CONFIG.OUTPUT_DIR);
    await generateSitemap(rankedEntities, CONFIG.OUTPUT_DIR);  // V14.4: Category-based sitemaps
    await generateCategoryStats(rankedEntities, CONFIG.OUTPUT_DIR);  // V14.4: Homepage categories
    await generateRelations(rankedEntities, CONFIG.OUTPUT_DIR);  // V14.4: Knowledge linking

    // V14.5.2: Write entities.json for factory-linker (CRITICAL for Knowledge Graph)
    const entitiesOutputPath = path.join(CONFIG.OUTPUT_DIR, 'entities.json');
    await fs.writeFile(entitiesOutputPath, JSON.stringify(rankedEntities, null, 2));
    console.log(`[AGGREGATOR] Wrote ${rankedEntities.length} entities to ${entitiesOutputPath}`);

    // V16.2.5: Switch cache dir to output for final saves so 4/4 picks them up
    // The path 'output/meta/backup' aligns with R2 expectations when 'output/' is stripped.
    process.env.CACHE_DIR = path.join(CONFIG.OUTPUT_DIR, 'meta', 'backup');
    await fs.mkdir(process.env.CACHE_DIR, { recursive: true });

    await updateFniHistory(rankedEntities);

    // SPEC-BACKUP-V14.5 Section 3.2: Cold Backup Snapshot for FNI History
    const historyData = await loadFniHistory();
    const weekNumber = getWeekNumber();
    const fniBackupPath = path.join(CONFIG.OUTPUT_DIR, 'meta', 'backup', 'fni-history', `fni-history-${weekNumber}.json`);
    await fs.mkdir(path.dirname(fniBackupPath), { recursive: true });
    await fs.writeFile(fniBackupPath, JSON.stringify(historyData, null, 2));
    console.log(`[BACKUP] FNI History snapshot: ${weekNumber}`);

    // V14.5 Phase 5: Generate trend data for frontend charts
    await generateTrendData(historyData, path.join(CONFIG.OUTPUT_DIR, 'cache'));

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

    // V16.2.5: Restore Registry Persistence (The Memory)
    // Saved to output/meta/backup for 4/4 to upload to R2
    console.log('[REGISTRY] Saving global registry memory to output and cache...');

    // 1. Save to output/ (authoritative for R2 upload in 4/4)
    await saveGlobalRegistry({
        entities: rankedEntities,
        count: rankedEntities.length,
        lastUpdated: new Date().toISOString()
    });

    // 2. V16.3 FIX: Also copy to 'cache/' directory explicitly for GitHub Actions persistence
    const CACHE_DIR = './cache';
    await fs.mkdir(CACHE_DIR, { recursive: true });

    const registryFiles = [
        'global-registry.json',
        'entity-checksums.json',
        'fni-history.json',
        'weekly-accum.json'
    ];

    for (const file of registryFiles) {
        const sourcePath = path.join(process.env.CACHE_DIR, file); // This is output/meta/backup/file
        const targetPath = path.join(CACHE_DIR, file);
        try {
            await fs.copyFile(sourcePath, targetPath);
        } catch (e) {
            // Log if critical
            if (file === 'global-registry.json') {
                console.warn(`  [CACHE] Failed to sync ${file}: ${e.message}`);
            }
        }
    }

    console.log('[AGGREGATOR] Phase 2 complete!');
}

main().catch(console.error);
