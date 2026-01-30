/**
 * Aggregator Utilities V16.4.3 (CES Compliant)
 * V16.4.3: Logic Restoration & Field Promotion
 */

import fs from 'fs/promises';
import path from 'path';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { loadFniHistory, saveFniHistory, loadWeeklyAccum } from './cache-manager.js';
import { generateTrendData } from './trend-data-generator.js';
import { updateWeeklyAccumulator } from './weekly-report.js';
import { mergeEntities } from '../../ingestion/lib/entity-merger.js';

/**
 * Get week number for backup file naming
 */
export function getWeekNumber() {
    const now = new Date();
    const year = now.getFullYear();
    const oneJan = new Date(year, 0, 1);
    const weekNum = Math.ceil(((now - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
    return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Load shard artifacts from parallel harvester jobs
 */
export async function loadShardArtifacts(artifactDir, totalShards) {
    const artifacts = [];
    for (let i = 0; i < totalShards; i++) {
        try {
            const filePath = path.join(artifactDir, `shard-${i}.json`);
            artifacts.push(JSON.parse(await fs.readFile(filePath, 'utf-8')));
        } catch {
            console.warn(`[WARN] Shard ${i} not found`);
            artifacts.push(null);
        }
    }
    return artifacts;
}

/**
 * Validate shard success rate (Art 3.3)
 */
export function validateShardSuccess(shardResults, totalShards) {
    const successful = shardResults.filter(s => s !== null).length;
    const rate = successful / totalShards;
    console.log(`[AGGREGATOR] Shards: ${successful}/${totalShards} (${(rate * 100).toFixed(1)}%)`);
    return rate;
}

/**
 * Calculate percentiles based on fni_score
 */
export function calculatePercentiles(entities) {
    const sorted = [...entities].sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));

    return sorted.map((e, i) => ({
        ...e,
        percentile: Math.round((1 - i / sorted.length) * 100),
    }));
}

/**
 * Update FNI history with 7-day rolling window (Art 4.2)
 */
export async function updateFniHistory(entities) {
    console.log('[AGGREGATOR] Updating FNI history...');
    const historyData = await loadFniHistory();
    const history = historyData.entities || {};
    const today = new Date().toISOString().split('T')[0];

    for (const e of entities) {
        const id = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
        if (!history[id]) history[id] = [];
        history[id].push({ date: today, score: e.fni_score || 0 });
        history[id] = history[id].slice(-7);
    }

    await saveFniHistory({ entities: history });
    console.log(`  [HISTORY] Updated ${Object.keys(history).length} entities`);
}

/**
 * Generate health report (Art 8.3)
 */
export async function generateHealthReport(shardResults, entities, totalShards, minSuccessRate, outputDir) {
    const today = new Date().toISOString().split('T')[0];
    const successful = shardResults.filter(s => s !== null).length;

    const health = {
        date: today,
        shardSuccessRate: successful / totalShards,
        totalEntities: entities.length,
        timestamp: new Date().toISOString(),
        status: successful >= totalShards * minSuccessRate ? 'healthy' : 'degraded',
    };

    const healthDir = path.join(outputDir, 'meta', 'health');
    await fs.mkdir(healthDir, { recursive: true });
    await fs.writeFile(path.join(healthDir, `${today}.json`), JSON.stringify(health, null, 2));
    console.log(`[HEALTH] Status: ${health.status}`);
}

/**
 * Merge shard updates into base entities
 */
export function mergeShardEntities(allEntities, shardResults) {
    const updatedEntitiesMap = new Map();
    for (const shard of shardResults) {
        if (shard?.entities) {
            for (const result of shard.entities) {
                if (result.success) updatedEntitiesMap.set(result.id, result);
            }
        }
    }

    return allEntities.map(e => {
        const id = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
        const update = updatedEntitiesMap.get(id);

        let entity = update ? mergeEntities(e, update) : e;

        // V16.4.3: Standard Image & Metrics Promotion (Dual-Field Strategy)
        // Ensure fni_score is the master field while keeping fni for shadow compatibility
        const finalFni = entity.fni_score ?? entity.fni ?? 0;
        entity.fni_score = finalFni;
        entity.fni = finalFni;

        if (!entity.image_url) {
            entity.image_url = entity.raw_image_url || null;

            if (!entity.image_url && entity.meta_json) {
                const meta = typeof entity.meta_json === 'string' ? JSON.parse(entity.meta_json) : entity.meta_json;
                entity.image_url = meta.cover_image_url || meta.thumbnail_url || meta.preview_url || null;
            }
        }

        return { ...entity, id };
    });
}

/**
 * Backup state files and generate trend data
 */
export async function backupStateFiles(outputDir, historyData, weekNumber) {
    const backupBase = path.join(outputDir, 'meta', 'backup');

    // FNI Snapshot
    const fniBackupPath = path.join(backupBase, 'fni-history', `fni-history-${weekNumber}.json`);
    await fs.mkdir(path.dirname(fniBackupPath), { recursive: true });
    await fs.writeFile(fniBackupPath, JSON.stringify(historyData, null, 2));

    await generateTrendData(historyData, path.join(outputDir, 'cache'));

    // Weekly Accumulator Snapshot
    const accumBackupPath = path.join(backupBase, 'accum', `accum-${weekNumber}.json`);
    await fs.mkdir(path.dirname(accumBackupPath), { recursive: true });
    try {
        const accum = await loadWeeklyAccum();
        await fs.writeFile(accumBackupPath, JSON.stringify(accum, null, 2));
    } catch (e) { console.warn(`[BACKUP] Accumulator skipped: ${e.message}`); }
}

