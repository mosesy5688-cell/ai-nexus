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
export async function processShardsIteratively(defaultArtifactDir, totalShards, options = {}, callback) {
    const { slim = false } = options;
    const searchPaths = [defaultArtifactDir, './artifacts', './output/cache/shards', './cache/registry', './output/registry'];

    console.log(`[AGGREGATOR] Iterative processing ${totalShards} shards... (Slim Mode: ${slim})`);

    for (let i = 0; i < totalShards; i++) {
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
 * Iterative version of mergeShardEntities to prevent OOM
 */
export async function mergeShardEntitiesIteratively(allEntities, artifactDir, totalShards, options = {}) {
    console.log('[AGGREGATOR] Performing iterative memory-safe merge...');
    const updatedEntitiesMap = new Map();
    const processedIds = new Set();
    const { slim = false } = options;

    // 1. Build update map ITERATIVELY
    await processShardsIteratively(artifactDir, totalShards, options, async (shard) => {
        if (shard?.entities) {
            for (const result of shard.entities) {
                const enriched = result.enriched || result;
                updatedEntitiesMap.set(result.id, {
                    ...enriched,
                    html_readme: enriched.html_readme || result.html || '',
                    htmlFragment: enriched.htmlFragment || result.html || ''
                });
            }
        }
    });
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



