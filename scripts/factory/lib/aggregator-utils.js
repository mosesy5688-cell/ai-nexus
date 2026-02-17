/**
 * Aggregator Utilities V18.12.5.15 (Partitioned Edition)
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
 */
export async function processShardsIteratively(defaultArtifactDir, totalShards, options = {}, callback, startShard = 0, endShard = null) {
    const { slim = false } = options;
    const searchPaths = [defaultArtifactDir, './artifacts', './output/cache/shards', './cache/registry', './output/registry'];
    const limit = endShard === null ? totalShards : Math.min(endShard, totalShards);

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
        }
        shardData = null;
    }
}

/**
 * Pass 1: Global Statistics and Update Indexing (V18.12.5.15)
 */
export async function calculateGlobalStats(registryLoader, artifactDir, totalShards) {
    console.log(`[AGGREGATOR] Pass 1/2: Global Indexing & FNI stats...`);
    const scoreMap = new Map();
    const updateIndexMap = new Map();

    await processShardsIteratively(artifactDir, totalShards, { slim: true }, async (shard, idx) => {
        if (shard?.entities) {
            for (const ent of shard.entities) {
                const incoming = ent.enriched || ent;
                updateIndexMap.set(incoming.id, idx);
            }
        }
    });

    await registryLoader(async (entities) => {
        for (const e of entities) {
            scoreMap.set(e.id, e.fni_score || 0);
        }
    }, { slim: true });

    const allScores = Array.from(scoreMap.values()).sort((a, b) => b - a);
    const count = allScores.length;

    // V18.12.5.15 Enhancement: Efficient Rank Mapping (O(N))
    const scoreToRank = new Map();
    for (let i = 0; i < allScores.length; i++) {
        if (!scoreToRank.has(allScores[i])) {
            scoreToRank.set(allScores[i], i);
        }
    }

    const rankingsMap = new Map();
    for (const [id, score] of scoreMap) {
        const rank = scoreToRank.get(score) ?? 0;
        rankingsMap.set(id, Math.round((1 - rank / count) * 100));
    }

    scoreMap.clear();
    console.log(`  [STATS] Calculated rankings for ${count} entities.`);
    return { rankingsMap, updateIndexMap };
}

/**
 * Standard Entity Processor
 */
function processEntity(e, update, mOptions = {}) {
    let entity = update ? mergeEntities(e, update, mOptions) : e;
    const id = normalizeId(entity.id, getNodeSource(entity.id, entity.type), entity.type);

    if (!mOptions.slim && entity.meta_json && typeof entity.meta_json === 'object') {
        try { entity.meta_json = JSON.stringify(entity.meta_json); } catch (err) { }
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

/**
 * Partitioned Shard Merge
 */
export async function mergePartitionedShard(baselineEntities, shardIndex, artifactDir, totalShards, rankingsMap, updateIndexMap, options = {}) {
    const { slim = false } = options;
    const shardRegistry = new Map();
    for (const e of baselineEntities) {
        shardRegistry.set(e.id, e);
    }

    const requiredUpdateShards = new Set();
    for (const id of shardRegistry.keys()) {
        const uIdx = updateIndexMap.get(id);
        if (uIdx !== undefined) requiredUpdateShards.add(uIdx);
    }

    let updateCount = 0;
    for (const uIdx of requiredUpdateShards) {
        await processShardsIteratively(artifactDir, totalShards, { slim }, async (shard) => {
            if (shard?.entities) {
                for (const result of shard.entities) {
                    const incoming = result.enriched || result;
                    const existing = shardRegistry.get(incoming.id);
                    if (existing) {
                        const merged = processEntity(existing, incoming, { slim });
                        merged.fni_percentile = rankingsMap.get(merged.id) || 0;
                        shardRegistry.set(merged.id, merged);
                        updateCount++;
                    }
                }
            }
        }, uIdx, uIdx + 1);
    }

    for (const ent of shardRegistry.values()) {
        if (ent.fni_percentile === undefined) ent.fni_percentile = rankingsMap.get(ent.id) || 0;
    }

    return {
        entities: Array.from(shardRegistry.values()),
        updateCount,
        newCount: 0
    };
}

/**
 * Validate shard success rate
 */
export function validateShardSuccess(shardResults, totalShards) {
    const successful = shardResults.filter(s => s !== null).length;
    return successful / totalShards;
}

/**
 * Calculate percentiles
 */
export function calculatePercentiles(entities) {
    const sorted = [...entities].sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));
    return sorted.map((e, i) => ({
        ...e,
        fni_percentile: Math.round((1 - i / sorted.length) * 100),
    }));
}

/**
 * Update FNI history
 */
export async function updateFniHistory(entities) {
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
}
