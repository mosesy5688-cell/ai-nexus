/**
 * Aggregator Utilities V16.8.6 (CES Compliant)
 * V16.8.6: Logic Restoration & Field Promotion
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { loadFniHistory, saveFniHistory } from './cache-manager.js';
import { mergeEntities } from '../../ingestion/lib/entity-merger.js';


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
                    const buffer = await fs.readFile(mergedGzPath);
                    const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
                    data = isGzip ? zlib.gunzipSync(buffer).toString('utf-8') : buffer.toString('utf-8');
                } else if (await fs.access(gzPath).then(() => true).catch(() => false)) {
                    const buffer = await fs.readFile(gzPath);
                    const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
                    data = isGzip ? zlib.gunzipSync(buffer).toString('utf-8') : buffer.toString('utf-8');
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
                // V16.6.5 Fix: Resilient merge - even if success is false, we keep the raw entity
                // to prevent 40% data loss (papers).
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



