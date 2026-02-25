/** Aggregator Utilities V18.12.5.21 (Split Module) */
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { mergeEntities } from '../../ingestion/lib/entity-merger.js';
import { processShardsIteratively } from './aggregator-shard-manager.js';

export { processShardsIteratively };


/** Pass 1: Global Statistics and Registry Indexing (V18.12.5.21) */
export async function calculateGlobalStats(registryLoader, artifactDir, totalShards) {
    console.log(`[AGGREGATOR] Pass 1/2: Mesh Discovery & Global Indexing...`);
    const scoreMap = new Map();
    const registryMap = new Map(); // id -> registryShardIdx
    const citationCounts = new Map(); // id -> score

    // V18.12.5.21: Mesh Discovery Pass
    // Scan all entities for relation targets to calculate Sm (Mesh Impact)
    // Formula: Model Cite +1, Paper Cite +3, Collection +5. Cap 100.
    await registryLoader(async (entities) => {
        const { extractEntityRelations } = await import('./relation-extractors.js');
        for (const e of entities) {
            const relations = extractEntityRelations(e);
            for (const rel of relations) {
                const targetId = rel.target_id;
                const sourceId = rel.source_id;
                const weight = rel.target_type === 'paper' ? 3 : 1;
                citationCounts.set(targetId, (citationCounts.get(targetId) || 0) + weight);
            }
        }
    }, { slim: true });

    console.log(`  [MESH] Discovered ${citationCounts.size} citation targets.`);

    // Pass 1.2: Calculate weighted scores
    await registryLoader(async (entities, idx) => {
        for (const e of entities) {
            // S_m calculation
            const Sm = Math.min(100, citationCounts.get(e.id) || 0);

            // FNI_final = (Vitality * 0.75) + (Sm * 0.25)
            // Note: Stage 2/4 results already include Pop, Fresh, Comp, Util in a 0-100 score.
            // We treat that as the 75% baseline.
            const baseScore = e.fni_score ?? 0;
            const finalFni = Math.round((baseScore * 0.75) + (Sm * 0.25));

            scoreMap.set(e.id, finalFni);
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
    const thresholds = []; // For exporting score-to-percentile map

    for (const [id, score] of scoreMap) {
        const rank = scoreToRank.get(score) ?? 0;
        const percentile = Math.round((1 - rank / count) * 100);
        rankingsMap.set(id, percentile);
    }

    // Build Thresholds for Late-Binding (Stage 4/4)
    // We export a mapping of score -> percentile
    const sortedUniqueScores = Array.from(scoreToRank.keys()).sort((a, b) => b - a);
    const scorePercentiles = {};
    for (const s of sortedUniqueScores) {
        const r = scoreToRank.get(s);
        scorePercentiles[s] = Math.round((1 - r / count) * 100);
    }

    // Export thresholds
    await fs.mkdir('./output/cache', { recursive: true });
    await fs.writeFile('./output/cache/fni-thresholds.json', JSON.stringify({
        _ts: new Date().toISOString(),
        _count: count,
        scorePercentiles,
        citationCounts: Object.fromEntries(citationCounts) // Optional: for debugging
    }, null, 2));

    scoreMap.clear();
    citationCounts.clear();
    console.log(`  [STATS] Mapped ${registryMap.size} entities with Mesh Impact applied.`);
    return { rankingsMap, registryMap };
}

/**
 * Pass 1.5: Pre-process updates (Monolith or Shards)
 */
export async function preProcessDeltas(artifactDir, totalShards, registryMap, monolithPath = null) {
    // V18.12.5.21: Stability Hardening (Art 3.1)
    const deltaDir = './cache/deltas';
    await fs.mkdir(deltaDir, { recursive: true });

    // Clear old deltas
    const files = await fs.readdir(deltaDir).catch(() => []);
    for (const f of files) await fs.unlink(path.join(deltaDir, f));

    // Optimized: Use memory-buffered writes to prevent I/O saturation
    const updateBuffers = new Map(); // shardIdx -> string[]
    const FLUSH_THRESHOLD = 5000;
    let updateCount = 0;
    let totalProcessed = 0;

    const flushBuffers = async () => {
        for (const [idx, lines] of updateBuffers.entries()) {
            if (lines.length > 0) {
                await fs.appendFile(path.join(deltaDir, `reg-${idx}.jsonl`), lines.join('\n') + '\n');
                lines.length = 0;
            }
        }
    };

    // A. Check for Monolith first (Most efficient if it exists)
    if (monolithPath && await fs.access(monolithPath).then(() => true).catch(() => false)) {
        console.log(`  [DELTAS] Streaming Monolith: ${monolithPath}...`);
        await partitionMonolithStreamingly(monolithPath, async (incoming) => {
            const regIdx = registryMap.get(incoming.id);
            if (regIdx !== undefined) {
                if (!updateBuffers.has(regIdx)) updateBuffers.set(regIdx, []);
                updateBuffers.get(regIdx).push(JSON.stringify(incoming));
                updateCount++;
                totalProcessed++;

                if (totalProcessed % FLUSH_THRESHOLD === 0) {
                    await flushBuffers();
                }
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
                        if (!updateBuffers.has(regIdx)) updateBuffers.set(regIdx, []);
                        updateBuffers.get(regIdx).push(JSON.stringify(incoming));
                        updateCount++;
                        totalProcessed++;

                        if (totalProcessed % FLUSH_THRESHOLD === 0) {
                            await flushBuffers();
                        }
                    }
                }
            }
        });
    }

    // Final flush
    await flushBuffers();
    updateBuffers.clear();

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
