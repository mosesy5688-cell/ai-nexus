/**
 * Trending Generator Module V25.9
 * Constitution Reference: Art 3.1 (Aggregator)
 * V25.9: Streaming — bounded top-1000 accumulator, zero fullSet.
 */

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';

const TRENDING_LIMIT = 1000;

/**
 * Generate trending.json via streaming shard reader (bounded top-1000)
 */
export async function generateTrending(shardReader, outputDir = './output') {
    console.log('[TRENDING] Generating trending.json (streaming)...');

    const cacheDir = path.join(outputDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });

    const topN = [];
    await shardReader(async (entities) => {
        for (const e of entities) {
            const score = e.fni_score || e.fni || 0;
            if (topN.length < TRENDING_LIMIT) {
                binaryInsert(topN, e, score);
            } else if (score > (topN[topN.length - 1].fni_score || 0)) {
                topN.pop();
                binaryInsert(topN, e, score);
            }
        }
    }, { slim: true });

    topN.sort(byFniDesc);

    const formatPruned = (e) => ({
        id: e.id,
        name: e.name || e.slug || 'Unknown',
        type: e.type || 'model',
        author: e.author || '',
        tags: Array.isArray(e.tags) ? (typeof e.tags[0] === 'string' ? e.tags.slice(0, 5) : []) : [],
        percentile: e.percentile || 0,
        params_billions: e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0,
        context_length: e.context_length ?? e.technical?.context_length ?? 0,
        stars: e.stars || 0,
        downloads: e.downloads || 0,
        fni_score: e.fni_score ?? e.fni ?? 0,
        fni_percentile: e.fni_percentile || e.percentile || '',
        fni_s: e.fni_s ?? e.fni_metrics?.s ?? 50.0,
        fni_a: e.fni_a ?? e.fni_metrics?.a ?? 0,
        fni_p: e.fni_p ?? e.fni_metrics?.p ?? 0,
        fni_r: e.fni_r ?? e.fni_metrics?.r ?? 0,
        fni_q: e.fni_q ?? e.fni_metrics?.q ?? 0
    });

    const output = {
        models: topN.filter(e => e.type === 'model' || !e.type).map(formatPruned),
        papers: topN.filter(e => e.type === 'paper').map(formatPruned),
        agents: topN.filter(e => e.type === 'agent').map(formatPruned),
        spaces: topN.filter(e => e.type === 'space').map(formatPruned),
        datasets: topN.filter(e => e.type === 'dataset').map(formatPruned),
        tools: topN.filter(e => e.type === 'tool').map(formatPruned),
        prompts: topN.filter(e => e.type === 'prompt').map(formatPruned),
        count: topN.length,
        generated_at: new Date().toISOString(),
        version: 'V25.9'
    };

    await smartWriteWithVersioning('trending.json', output, cacheDir, { compress: true });
    console.log(`  [TRENDING] ✅ Done. ${topN.length} trending entities.`);
}

function byFniDesc(a, b) { return (b.fni_score || b.fni || 0) - (a.fni_score || a.fni || 0); }

function binaryInsert(arr, item, score) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((arr[mid].fni_score || arr[mid].fni || 0) > score) lo = mid + 1; else hi = mid;
    }
    arr.splice(lo, 0, item);
}
