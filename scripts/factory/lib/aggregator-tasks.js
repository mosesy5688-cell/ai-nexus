/**
 * Aggregator Task Registry V25.9
 * V25.9: All generators accept shardReader (streaming) instead of entity arrays.
 */

import { generateRankings } from './rankings-generator.js';
import { generateSearchIndices } from './search-indexer.js';
import { generateTrending } from './trending-generator.js';
import { generateCategoryStats } from './category-stats-generator.js';
import { generateRelations } from './relations-generator.js';
import { generateMeshGraph } from './mesh-graph-generator.js';
import { computeAltRelations } from './alt-linker.js';
import { computeKnowledgeLinks } from './knowledge-linker.js';
import { generateKnowledgeData } from './knowledge-data-generator.js';
import { generateWithGemini, getKnownTopics } from './knowledge-ai.js';
import { loadFniHistory } from './cache-manager.js';
import { generateTrendData } from './trend-data-generator.js';
import { smartWriteWithVersioning } from './smart-writer.js';
import { autoDecompress } from './zstd-helper.js';
import path from 'path';

async function isFresh(filename, dir, maxDays) {
    for (const ext of ['.zst', '.gz', '']) {
        try {
            const raw = await (await import('fs/promises')).readFile(path.join(dir, filename + ext));
            const data = JSON.parse((await autoDecompress(raw)).toString('utf-8'));
            if (data._ts) {
                const age = (Date.now() - new Date(data._ts).getTime()) / 86400000;
                if (age < maxDays) { console.log(`[KnowledgeAI] ${filename}: fresh (${age.toFixed(1)}d < ${maxDays}d), skipping`); return true; }
            }
        } catch { continue; }
    }
    return false;
}

/**
 * Build the list of satellite tasks for the aggregator.
 * @param {Function} shardReader - async (consumer, opts) => {} streaming shard reader
 */
export function buildTaskList(shardReader, outputDir, opts = {}) {
    const shardDir = opts.shardDir || null;
    return [
        { name: 'Trending', id: 'trending', fn: () => generateTrending(shardReader, outputDir) },
        { name: 'Rankings', id: 'rankings', fn: () => generateRankings(shardReader, outputDir) },
        { name: 'Search', id: 'search', fn: () => generateSearchIndices(shardReader, outputDir, { shardDir }) },
        { name: 'CategoryStats', id: 'category', fn: () => generateCategoryStats(shardReader, outputDir) },
        { name: 'Relations', id: 'relations', fn: () => generateRelations(shardReader, outputDir) },
        { name: 'AltLinker', id: 'alt', fn: () => computeAltRelations(shardReader, outputDir, { shardDir }) },
        { name: 'KnowledgeLinks', id: 'knowledge-links', fn: () => computeKnowledgeLinks(shardReader, outputDir, { shardDir }) },
        {
            name: 'MeshGraph', id: 'mesh', fn: async () => {
                await generateKnowledgeData(outputDir);
                await generateMeshGraph(outputDir);
            }
        },
        {
            name: 'TrendData', id: 'trend', fn: async () => {
                const history = await loadFniHistory();
                await generateTrendData(history, path.join(outputDir, 'cache'));
            }
        },
        {
            name: 'KnowledgeAI', id: 'knowledge-ai', fn: async () => {
                const knowledgeDir = path.join(outputDir, 'cache', 'knowledge', 'ai');
                const { mkdir, readFile } = await import('fs/promises');
                await mkdir(knowledgeDir, { recursive: true });
                const topicMap = getKnownTopics();
                const topics = Object.values(topicMap).flat();
                const FRESHNESS_DAYS = 14;
                let generated = 0, skipped = 0;
                for (const topic of topics) {
                    try {
                        const cached = await isFresh(`${topic.slug}.json`, knowledgeDir, FRESHNESS_DAYS);
                        if (cached) { skipped++; continue; }
                        const result = await generateWithGemini(topic);
                        if (result) {
                            await smartWriteWithVersioning(`${topic.slug}.json`, { ...result, _topic: topic.slug, _ts: new Date().toISOString() }, knowledgeDir, { compress: true });
                            generated++;
                        }
                    } catch (e) {
                        console.warn(`[KnowledgeAI] Skipping ${topic.slug}: ${e.message}`);
                    }
                }
                console.log(`[KnowledgeAI] Generated ${generated}, skipped ${skipped} fresh (< ${FRESHNESS_DAYS}d), total ${topics.length}`);
            }
        }
    ];
}
