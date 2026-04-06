/**
 * Aggregator Metrics & History V18.12.5.16
 */
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { loadFniHistory, saveFniHistory } from './cache-manager.js';

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

/**
 * V25.9: Streaming-compatible FNI history update.
 * Accepts a pre-built Map<normalizedId, score> instead of an entity array.
 */
export async function updateFniHistoryFromBatch(historyBatch) {
    const historyData = await loadFniHistory();
    const history = historyData.entities || {};
    const today = new Date().toISOString().split('T')[0];

    for (const [normalizedId, score] of historyBatch) {
        if (!history[normalizedId]) history[normalizedId] = [];
        history[normalizedId].push({ date: today, score });
        history[normalizedId] = history[normalizedId].slice(-7);
    }

    await saveFniHistory({ entities: history });
    console.log(`[FNI-HISTORY] Updated ${historyBatch.size} entries (streaming batch).`);
}
