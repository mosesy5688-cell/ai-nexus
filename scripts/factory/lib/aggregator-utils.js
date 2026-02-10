/**
 * Aggregator Utilities V16.8.6 (CES Compliant)
 * V16.8.6: Logic Restoration & Field Promotion
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { loadFniHistory, saveFniHistory, loadDailyAccum } from './cache-manager.js';
import { generateTrendData } from './trend-data-generator.js';
import { updateDailyAccumulator } from './daily-report.js';
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
 * Load shard artifacts from parallel harvester jobs (V16.11 Compressed support)
 */
export async function loadShardArtifacts(defaultArtifactDir, totalShards) {
    const artifacts = [];

    // V18.2.2: Search in multiple potential CI context directories
    const searchPaths = [
        defaultArtifactDir,
        './artifacts',
        './output/cache/shards',
        './cache/registry',
        './output/registry'
    ];

    console.log(`[AGGREGATOR] Searching for ${totalShards} shards in: ${searchPaths.join(', ')}`);

    for (let i = 0; i < totalShards; i++) {
        let shardData = null;
        for (const p of searchPaths) {
            try {
                // Priority: .json.gz (V16.11)
                const gzPath = path.join(p, `shard-${i}.json.gz`);
                const jsonPath = path.join(p, `shard-${i}.json`);
                const mergedGzPath = path.join(p, `merged_shard_${i}.json.gz`); // Harvester V18.2.1 format

                let data;
                if (await fs.access(mergedGzPath).then(() => true).catch(() => false)) {
                    data = zlib.gunzipSync(await fs.readFile(mergedGzPath)).toString('utf-8');
                } else if (await fs.access(gzPath).then(() => true).catch(() => false)) {
                    data = zlib.gunzipSync(await fs.readFile(gzPath)).toString('utf-8');
                } else if (await fs.access(jsonPath).then(() => true).catch(() => false)) {
                    data = await fs.readFile(jsonPath, 'utf-8');
                } else {
                    continue; // Check next path
                }

                shardData = JSON.parse(data);
                break; // Found it!
            } catch (e) { continue; }
        }

        if (shardData) {
            artifacts.push(shardData);
        } else {
            console.warn(`[WARN] Shard ${i} not found in any search path.`);
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
    const zlib = await import('zlib');
    await fs.writeFile(path.join(healthDir, `${today}.json.gz`), zlib.gzipSync(JSON.stringify(health, null, 2)));
    console.log(`[HEALTH] Status: ${health.status}`);
}

/**
 * Merge shard updates into base entities (Memory-Efficient V2.0)
 * V16.7.2: Process in smaller chunks to maintain ~300MB footprint
 */
export function mergeShardEntities(allEntities, shardResults) {
    console.log('[AGGREGATOR] Performing memory-efficient merge...');

    // Build update map from shards
    const updatedEntitiesMap = new Map();
    const processedIds = new Set();

    for (const shard of shardResults) {
        if (shard?.entities) {
            for (const result of shard.entities) {
                if (result.success) {
                    const enriched = result.enriched || result;
                    const update = {
                        ...enriched,
                        // V18.2.1 Restoration: Explicitly pull HTML for fusion
                        html_readme: result.html || enriched.html_readme || '',
                        htmlFragment: result.html || enriched.htmlFragment || ''
                    };
                    updatedEntitiesMap.set(result.id, update);
                }
            }
        }
    }

    const merged = [];
    const BATCH_SIZE = 50000;

    // Helper: Standard Entity Processor (V16.11 CES)
    const processEntity = (e, update) => {
        let entity = update ? mergeEntities(e, update) : e;
        const id = normalizeId(entity.id, getNodeSource(entity.id, entity.type), entity.type);

        if (entity.meta_json) {
            try {
                const meta = typeof entity.meta_json === 'string' ? JSON.parse(entity.meta_json) : entity.meta_json;
                // V18.2.1 GA: Stop stripping metadata from internal meta_json
                entity.meta_json = JSON.stringify(meta);
            } catch (e) { /* ignore parse errors */ }
        }

        // V18.2.1 GA Restoration: NO DELETIONS.
        // We MUST preserve all fields for SEO, Search, and Detail Pages (Monolith Integrity)
        // Only strip rawMetadata if it's truly auxiliary and massive, but keep it for now.

        entity.type = entity.type || entity.entity_type || 'model';
        const finalFni = entity.fni_score ?? entity.fni ?? 0;
        entity.fni_score = finalFni;
        entity.fni = finalFni;

        // V18.2.1 GA: Selective Image Promotion (User Principle: Only Helpful Images)
        // Stop pulling generic thumbnails/covers that don't add real value.
        if (!entity.image_url) {
            // Only use raw_image_url or explicit high-value preview_url
            entity.image_url = entity.raw_image_url || entity.preview_url || null;

            // Explicitly AVOID promoting common 'thumbnail' or 'cover' fields if they are the only ones left,
            // as these are often generic placeholders across registries.
        }
        return { ...entity, id };
    };

    // 1. Process Baseline Entities (with Shard updates)
    for (let i = 0; i < allEntities.length; i += BATCH_SIZE) {
        const batch = allEntities.slice(i, i + BATCH_SIZE);
        const mergedBatch = batch.map(e => {
            const id = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
            const update = updatedEntitiesMap.get(id);
            if (update) processedIds.add(id);
            return processEntity(e, update);
        });
        merged.push(...mergedBatch);
        if (i % 200000 === 0 && i > 0) console.log(`  [Merge] Processed ${i} entities...`);
    }

    // 2. Fragment Recovery/New Inclusion: Add shard entities not in baseline
    let recoveryCount = 0;
    for (const [id, update] of updatedEntitiesMap) {
        if (!processedIds.has(id)) {
            merged.push(processEntity(update, null));
            recoveryCount++;
        }
    }

    if (recoveryCount > 0) {
        console.log(`  [Merge] Recovery: Added ${recoveryCount} entities from shards not in baseline.`);
    }

    updatedEntitiesMap.clear();
    processedIds.clear();
    return merged;
}

/**
 * Backup state files and generate trend data
 */
export async function backupStateFiles(outputDir, historyData, weekNumber) {
    const backupBase = path.join(outputDir, 'meta', 'backup');

    // FNI Snapshot
    const fniBackupPath = path.join(backupBase, 'fni-history', `fni-history-${weekNumber}.json.gz`);
    await fs.mkdir(path.dirname(fniBackupPath), { recursive: true });
    const zlib = await import('zlib');
    await fs.writeFile(fniBackupPath, zlib.gzipSync(JSON.stringify(historyData, null, 2)));

    await generateTrendData(historyData, path.join(outputDir, 'cache'));

    // Daily Accumulator Snapshot (Transitioned from Weekly)
    const accumBackupPath = path.join(backupBase, 'accum', `accum-${weekNumber}.json.gz`);
    await fs.mkdir(path.dirname(accumBackupPath), { recursive: true });
    try {
        const accum = await loadDailyAccum();
        const zlib = await import('zlib');
        await fs.writeFile(accumBackupPath, zlib.gzipSync(JSON.stringify(accum, null, 2)));
    } catch (e) { console.warn(`[BACKUP] Accumulator skipped: ${e.message}`); }
}


