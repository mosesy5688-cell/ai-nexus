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
                    for (const result of parsed.entities) {
                        const ent = result.enriched || result;
                        delete ent.html_readme; delete ent.htmlFragment;
                        delete ent.content; delete ent.readme;
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
async function buildShardIndex(artifactDir, totalShards) {
    console.log(`[AGGREGATOR] Building shard update index for ${totalShards} shards...`);
    const index = new Map();
    const searchPaths = [artifactDir, './artifacts', './output/cache/shards', './cache/registry', './output/registry'];

    for (let i = 0; i < totalShards; i++) {
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
                if (parsed.entities) {
                    for (const e of parsed.entities) {
                        index.set(e.id, i);
                    }
                }
                break;
            } catch (e) { continue; }
        }
    }
    console.log(`  [INDEX] Indexed ${index.size} updates.`);
    return index;
}

/**
 * Iterative version of mergeShardEntities to prevent OOM
 * V18.12.5.12: Stateless Shard-by-Shard Merge (Method A)
 */
export async function mergeShardEntitiesIteratively(allEntities, artifactDir, totalShards, options = {}) {
    console.log('[AGGREGATOR] Performing Stateless Shard-by-Shard merge...');
    const { slim = false } = options;

    // 1. Build light index (ID -> shardIndex)
    const shardIndex = await buildShardIndex(artifactDir, totalShards);
    const processedIds = new Set();
    const finalSet = [...allEntities]; // Primary working set (references only)

    // 2. Process Shards one by one and apply updates to finalSet
    for (let i = 0; i < totalShards; i++) {
        let shardEntitiesMap = new Map();

        // Load single shard
        await processShardsIteratively(artifactDir, totalShards, { slim }, async (shard, idx) => {
            if (idx === i && shard?.entities) {
                for (const result of shard.entities) {
                    const enriched = result.enriched || result;
                    shardEntitiesMap.set(result.id, {
                        ...enriched,
                        html_readme: enriched.html_readme || result.html || '',
                        htmlFragment: enriched.htmlFragment || result.html || ''
                    });
                }
            }
        }, i, i + 1); // Helper needs to support range or we skip in callback

        if (shardEntitiesMap.size === 0) continue;

        console.log(`  [Merge] Applying ${shardEntitiesMap.size} updates from Shard ${i}...`);

        // Apply updates to Baseline in place
        for (let j = 0; j < finalSet.length; j++) {
            const e = finalSet[j];
            const id = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
            const update = shardEntitiesMap.get(id);
            if (update) {
                finalSet[j] = processEntity(e, update);
                processedIds.add(id);
            }
        }

        // Add "New" entities from this shard that weren't in baseline
        for (const [id, update] of shardEntitiesMap) {
            if (!processedIds.has(id)) {
                // Double check if it's truly new or just processed in a previous shard
                // (Though IDs should be unique per shard, it's safer)
                finalSet.push(processEntity(update, null));
                processedIds.add(id);
            }
        }

        shardEntitiesMap.clear();
        shardEntitiesMap = null;
    }

    // Helper: Standard Entity Processor (V16.11 CES)
    function processEntity(e, update) {
        let entity = update ? mergeEntities(e, update) : e;
        const id = normalizeId(entity.id, getNodeSource(entity.id, entity.type), entity.type);

        if (entity.meta_json) {
            try {
                const meta = typeof entity.meta_json === 'string' ? JSON.parse(entity.meta_json) : entity.meta_json;
                entity.meta_json = JSON.stringify(meta);
            } catch (err) { /* ignore */ }
        }

        entity.type = entity.type || entity.entity_type || 'model';
        const finalFni = entity.fni_score ?? entity.fni ?? 0;
        entity.fni_score = finalFni;
        entity.fni = finalFni;

        if (!entity.image_url) {
            entity.image_url = entity.raw_image_url || entity.preview_url || null;
        }
        return { ...entity, id };
    }

    shardIndex.clear();
    processedIds.clear();
    return finalSet;
}



