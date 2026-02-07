/**
 * Rankings Generator Module V14.4
 * Constitution Reference: Art 3.1 (Aggregator)
 */

import fs from 'fs/promises';
import path from 'path';

const CATEGORIES = [
    'text-generation',
    'knowledge-retrieval',
    'vision-multimedia',
    'automation-workflow',
    'infrastructure-ops',
];

const ENTITY_TYPES = ['model', 'paper', 'agent', 'space', 'dataset', 'tool'];

/**
 * Generate all rankings
 */
export async function generateRankings(entities, outputDir = './output') {
    console.log('[RANKINGS] Generating rankings...');

    // Global ranking
    await generateCategoryRanking('all', entities, outputDir);

    // Per-category rankings
    for (const category of CATEGORIES) {
        const categoryEntities = entities.filter(e => e.category === category);
        await generateCategoryRanking(category, categoryEntities, outputDir);
    }

    // Per-type rankings
    for (const type of ENTITY_TYPES) {
        const typeEntities = entities.filter(e => e.type === type);
        await generateCategoryRanking(type, typeEntities, outputDir);
    }
}

async function generateCategoryRanking(category, entities, outputDir) {
    const pageSize = 50;
    const MAX_PAGES = 50; // Art 2.4 Constitution Limit
    const totalPages = Math.ceil(entities.length / pageSize) || 1;
    const effectivePages = Math.min(totalPages, MAX_PAGES);

    // Write to cache/rankings to match CDN path expectations
    const rankingDir = path.join(outputDir, 'cache', 'rankings', category);
    await fs.mkdir(rankingDir, { recursive: true });

    for (let page = 1; page <= effectivePages; page++) {
        const start = (page - 1) * pageSize;
        const pageEntities = entities.slice(start, start + pageSize);

        const ranking = {
            category,
            page,
            totalPages: effectivePages, // Report the capped total
            totalEntities: Math.min(entities.length, MAX_PAGES * pageSize),
            entities: pageEntities,
            generated: new Date().toISOString(),
        };

        const filePath = path.join(rankingDir, `p${page}.json`);
        await fs.writeFile(filePath, JSON.stringify(ranking, null, 2));
    }

    console.log(`  [RANKING] ${category}: ${entities.length} entities, ${effectivePages} pages generated (Capped at ${MAX_PAGES})`);
}
