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
 * Iterative Shard Processor (V18.12.5.12 OOM Guard)
 * Loads and processes shards one by one to keep heap footprint low.
 */
export async function processShardsIteratively(defaultArtifactDir, totalShards, options = {}, callback, startShard = 0, endShard = null) {
    const { slim = false } = options;
    const searchPaths = [defaultArtifactDir, './artifacts', './output/cache/shards', './cache/registry', './output/registry'];
    const limit = endShard === null ? totalShards : Math.min(endShard, totalShards);

    console.log(`[AGGREGATOR] Iterative processing shards ${startShard}-${limit - 1}... (Slim Mode: ${slim})`);

    for (let i = startShard; i < limit; i++) {
        let shardData = null;
        for (const p of searchPaths) {
            try {
                const gzPath = path.join(p, `shard-${i}.json.gz`);
                const jsonPath = path.join(p, `shard-${i}.json`);
                const mergedGzPath = path.join(p, `merged_shard_${i}.json.gz`);

                let data;
                if (await fs.access(mergedGzPath).then(() => true).catch(() => false)) {
                    data = zlib.gunzipSync(await fs.readFile(mergedGzPath)).toString('utf-8');
                } else if (await fs.access(gzPath).then(() => true).catch(() => false)) {
                    data = zlib.gunzipSync(await fs.readFile(gzPath)).toString('utf-8');
                } else if (await fs.access(jsonPath).then(() => true).catch(() => false)) {
                    data = await fs.readFile(jsonPath, 'utf-8');
                } else continue;

                const parsed = JSON.parse(data);
                if (slim && parsed.entities) {
                    // V18.12.5.14: Use Projection instead of delete to avoid Dictionary Mode
                    const slimFields = [
                        'id', 'umid', 'slug', 'name', 'type', 'author', 'description',
                        'tags', 'metrics', 'stars', 'forks', 'downloads', 'likes',
                        'citations', 'size', 'runtime', 'fni_score', 'fni_percentile',
                        'fni_trend_7d', 'is_rising_star', 'primary_category',
                        'pipeline_tag', 'published_date', 'last_modified',
                        'last_updated', 'lastModified', '_updated'
                    ];
                    for (let j = 0; j < parsed.entities.length; j++) {
                        const ent = parsed.entities[j].enriched || parsed.entities[j];
                        const projected = {};
                        for (const f of slimFields) {
                            if (ent[f] !== undefined) projected[f] = ent[f];
                        }
                        // Replace reference with slim object immediately
                        if (parsed.entities[j].enriched) parsed.entities[j].enriched = projected;
                        else parsed.entities[j] = projected;
                    }
                }
                shardData = parsed;
                break;
            } catch (e) { continue; }
        }

        if (shardData) {
            await callback(shardData, i);
        } else {
            console.warn(`[WARN] Shard ${i} missing.`);
        }
        // Force GC hint or at least clear reference
        shardData = null;
    }
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
 * Build a light index of which IDs are in which shards
 * Returns Map<ID, shardIndex>
 */
// buildShardIndex removed (V18.12.5.13: Redundant & OOM-prone)

/**
 * Zero-Copy In-Place Merge (V18.12.5.13 FINAL OOM FIX)
 * Uses a single Baseline Index Map to perform O(1) lookups.
 * Directly mutates the passed array to allow GC of old objects immediately.
 */
export async function mergeShardEntitiesIteratively(baselineArray, artifactDir, totalShards, options = {}) {
    console.log(`[AGGREGATOR] Performing Zero-Copy In-Place merge on ${baselineArray.length} entities...`);
    const { slim = false } = options;

    // 1. Build Baseline Index Map (O(N) - once)
    const idToIndex = new Map();
    for (let i = 0; i < baselineArray.length; i++) {
        idToIndex.set(baselineArray[i].id, i);
    }
    console.log(`  [BASELINE] Indexed ${idToIndex.size} existing entities.`);

    // 2. Process Shards and Merge In-Place
    for (let i = 0; i < totalShards; i++) {
        let updateCount = 0;
        let newCount = 0;

        await processShardsIteratively(artifactDir, totalShards, { slim }, async (shard, idx) => {
            if (idx === i && shard?.entities) {
                for (const result of shard.entities) {
                    const incoming = result.enriched || result;
                    const bIdx = idToIndex.get(incoming.id);

                    if (bIdx !== undefined) {
                        // In-Place Reference Replacement
                        baselineArray[bIdx] = processEntity(baselineArray[bIdx], incoming, { slim });
                        updateCount++;
                    } else {
                        // Append New Entities
                        const processed = processEntity(incoming, null, { slim });
                        baselineArray.push(processed);
                        idToIndex.set(processed.id, baselineArray.length - 1);
                        newCount++;
                    }
                }
            }
        }, i, i + 1);

        if (updateCount > 0 || newCount > 0) {
            console.log(`  [Merge] Shard ${i}: Applied ${updateCount} updates, added ${newCount} new entities.`);
        }

        // Hint GC after heavy shard processing
        if (global.gc) global.gc();
    }

    // Helper: Standard Entity Processor (V16.11 CES)
    function processEntity(e, update, mOptions = {}) {
        let entity = update ? mergeEntities(e, update, mOptions) : e;
        const id = normalizeId(entity.id, getNodeSource(entity.id, entity.type), entity.type);

        // V18.12.5.14: Skip meta_json stringification in slim mode if it's already there
        if (!mOptions.slim && entity.meta_json && typeof entity.meta_json === 'object') {
            try {
                entity.meta_json = JSON.stringify(entity.meta_json);
            } catch (err) { /* ignore */ }
        }

        entity.type = entity.type || entity.entity_type || 'model';
        const finalFni = entity.fni_score ?? entity.fni ?? 0;
        entity.fni_score = finalFni;
        entity.fni = finalFni;

        if (!entity.image_url) {
            entity.image_url = entity.raw_image_url || entity.preview_url || null;
        }

        // Return a fresh object with normalized ID
        return { ...entity, id };
    }

    idToIndex.clear();
    return baselineArray;
}



