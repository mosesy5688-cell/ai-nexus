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
// V27.36: KnowledgeAI + TrendsSummary tasks removed (Gemini-dependent).
// $3/month Gemini budget cap exhausts mid-month, leaving all calls in 429 +
// 60s stagger retry that wastes ~3-5min cron wall-time per run. Tasks have been
// removed from the registry below. generateWithGemini/getKnownTopics/
// generateTrendsSummary/isFresh stay on disk for future re-enable.
import { loadFniHistory } from './cache-manager.js';
import { generateTrendData } from './trend-data-generator.js';
import { smartWriteWithVersioning } from './smart-writer.js';
import path from 'path';

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
        }
        // V27.36: TrendsSummary + KnowledgeAI removed (Gemini-dependent under $3/mo budget cap).
        // To re-enable, reinstate the task blocks here and add back the imports above.
    ];
}
