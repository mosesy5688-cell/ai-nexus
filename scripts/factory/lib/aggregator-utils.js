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
    console.log(`[AGGREGATOR] Pass 1/2: Global Indexing & Ranking...`);
    const scoreMap = new Map();
    const registryMap = new Map(); // id -> registryShardIdx

    // V25.1 FIX: Abolish Stage 4/4 Scoring. Trust Stage 2/4 Authority ONLY.
    await registryLoader(async (entities, idx) => {
        for (const e of entities) {
            // Read score directly from Stage 2/4 result
            const currentScore = e.fni_score ?? e.fni ?? 0;
            scoreMap.set(e.id, currentScore);
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
        // V25.5 FIX: Accurate Percentile for Tied Scores (Abolish "Tied for Top")
        // If 10,000 entities have score 0, they should all be at Bottom, not Top 100%.
        const rank = scoreToRank.get(score) ?? 0;
        const countAtScore = allScores.filter(s => s === score).length;
        // Use the middle of the range for tied scores to prevent saturation
        const effectiveRank = rank + (countAtScore - 1) / 2;
        const numericPercentile = Math.max(1, Math.round((1 - effectiveRank / count) * 100));
        rankingsMap.set(id, numericPercentile);
    }

    // Build Thresholds for Late-Binding (Stage 4/4)
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
        scorePercentiles
    }, null, 2));

    console.log(`  [STATS] Mapped ${registryMap.size} entities with Authority-First scoring.`);
    return { rankingsMap, registryMap, scoreMap };
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
    const finalFni = entity.fni_score ?? 0; // V25.5 FIX: Abolish 'fni' fallback. Only trust computed score.
    entity.fni_score = finalFni;
    entity.fni = finalFni; // Placeholder for legacy frontend compatibility (mapped to Score)

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
                    // V25.1: Trust existing string-based percentile (top_1%) if present.
                    // Only overwrite with numeric rank if current value is missing or numeric 0-100.
                    const currentP = merged.fni_percentile;
                    const hasBadge = typeof currentP === 'string' && currentP.includes('top_');
                    
                    if (!hasBadge) {
                        merged.fni_percentile = rankingsMap.get(merged.id) || 0;
                    }
                    shardRegistry.set(merged.id, merged);
                    updateCount++;
                }
            }
        }
    } catch (e) {
        // No deltas for this shard
    }

    for (const ent of shardRegistry.values()) {
        const currentP = ent.fni_percentile;
        const hasBadge = typeof currentP === 'string' && currentP.includes('top_');
        if (!hasBadge && currentP === undefined) {
            ent.fni_percentile = rankingsMap.get(ent.id) || 0;
        }
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
