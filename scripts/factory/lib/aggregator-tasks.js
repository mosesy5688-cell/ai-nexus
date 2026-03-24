/**
 * Aggregator Task Registry V25.8.4
 * Defines satellite tasks and their execution logic.
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
import { loadFniHistory } from './cache-manager.js';
import { generateTrendData } from './trend-data-generator.js';
import path from 'path';

/**
 * Build the list of satellite tasks for the aggregator.
 */
export function buildTaskList(rankedEntities, outputDir, opts = {}) {
    const shardDir = opts.shardDir || null;
    return [
        { name: 'Trending', id: 'trending', fn: () => generateTrending(rankedEntities, outputDir) },
        { name: 'Rankings', id: 'rankings', fn: () => generateRankings(rankedEntities, outputDir) },
        { name: 'Search', id: 'search', fn: () => generateSearchIndices(rankedEntities, outputDir, { shardDir }) },
        { name: 'CategoryStats', id: 'category', fn: () => generateCategoryStats(rankedEntities, outputDir) },
        {
            name: 'Relations', id: 'relations', fn: async () => {
                await generateRelations(rankedEntities, outputDir);
                await computeAltRelations(rankedEntities, outputDir, { shardDir });
                await computeKnowledgeLinks(rankedEntities, outputDir, { shardDir });
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
    ];
}
