/**
 * Aggregator Utilities V18.12.5.16 (Partitioned Edition)
 */
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
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
 * Pass 1: Global Statistics and Registry Indexing (V18.12.5.16)
 */
export async function calculateGlobalStats(registryLoader, artifactDir, totalShards) {
    console.log(`[AGGREGATOR] Pass 1/2: Global Indexing & Registry Mapping...`);
    const scoreMap = new Map();
    const registryMap = new Map(); // id -> registryShardIdx

    await registryLoader(async (entities, idx) => {
        for (const e of entities) {
            scoreMap.set(e.id, e.fni_score || 0);
            registryMap.set(e.id, idx);
        }
    }, { slim: true });

    const allScores = Array.from(scoreMap.values()).sort((a, b) => b - a);
    const count = allScores.length;

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
    console.log(`  [STATS] Mapped ${registryMap.size} entities for O(1) merge.`);
    return { rankingsMap, registryMap };
}

/**
 * Pass 1.5: Pre-process Harvester Deltas (Hash-Join Alignment)
 * O(S) I/O instead of O(S^2)
 */
/**
 * Pass 1.5: Pre-process updates (Monolith or Shards)
 */
export async function preProcessDeltas(artifactDir, totalShards, registryMap, monolithPath = null) {
    console.log(`[AGGREGATOR] Pass 1.5/2: Aligning updates for merge...`);
    const deltaDir = './cache/deltas';
    await fs.mkdir(deltaDir, { recursive: true });

    // Clear old deltas
    const files = await fs.readdir(deltaDir).catch(() => []);
    for (const f of files) await fs.unlink(path.join(deltaDir, f));

    // Open append streams for all registry shards
    const streams = new Map();
    const getStream = (idx) => {
        if (!streams.has(idx)) {
            streams.set(idx, fs.open(path.join(deltaDir, `reg-${idx}.jsonl`), 'a'));
        }
        return streams.get(idx);
    };

    let updateCount = 0;

    // A. Check for Monolith first (Most efficient if it exists)
    if (monolithPath && await fs.access(monolithPath).then(() => true).catch(() => false)) {
        console.log(`  [DELTAS] Streaming Monolith: ${monolithPath}...`);
        await partitionMonolithStreamingly(monolithPath, async (incoming) => {
            const regIdx = registryMap.get(incoming.id);
            if (regIdx !== undefined) {
                const handle = await getStream(regIdx);
                await fs.appendFile(handle, JSON.stringify(incoming) + '\n');
                updateCount++;
            }
        });
    } else {
        // B. Fallback to Update Shards
        console.log(`  [DELTAS] Processing Update Shards from ${artifactDir}...`);
        await processShardsIteratively(artifactDir, totalShards, { slim: true }, async (shard) => {
            if (shard?.entities) {
                for (const result of shard.entities) {
                    const incoming = result.enriched || result;
                    const regIdx = registryMap.get(incoming.id);
                    if (regIdx !== undefined) {
                        const handle = await getStream(regIdx);
                        await fs.appendFile(handle, JSON.stringify(incoming) + '\n');
                        updateCount++;
                    }
                }
            }
        });
    }

    // Close all handles
    for (const handle of streams.values()) {
        await (await handle).close();
    }

    console.log(`  [DELTAS] Aligned ${updateCount} updates across all shards.`);
}

import { partitionMonolithStreamingly } from './aggregator-stream-utils.js';

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
 * Partitioned Shard Merge (Optimized with Local Deltas)
 */
export async function mergePartitionedShard(baselineEntities, shardIndex, rankingsMap, options = {}) {
    const { slim = false } = options;
    const shardRegistry = new Map();
    for (const e of baselineEntities) {
        shardRegistry.set(e.id, e);
    }

    let updateCount = 0;
    const deltaPath = `./cache/deltas/reg-${shardIndex}.jsonl`;
    try {
        const content = await fs.readFile(deltaPath, 'utf-8').catch(() => '');
        if (content) {
            const lines = content.trim().split('\n');
            for (const line of lines) {
                const incoming = JSON.parse(line);
                const existing = shardRegistry.get(incoming.id);
                if (existing) {
                    const merged = processEntity(existing, incoming, { slim });
                    merged.fni_percentile = rankingsMap.get(merged.id) || 0;
                    shardRegistry.set(merged.id, merged);
                    updateCount++;
                }
            }
        }
    } catch (e) {
        // No deltas for this shard
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
