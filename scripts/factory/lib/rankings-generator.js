/**
 * Rankings Generator Module V14.4
 * Constitution Reference: Art 3.1 (Aggregator)
 */

import path from 'path';
import { getV6Category } from './category-stats-generator.js';

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
    const cacheDir = path.join(outputDir, 'cache');

    // Global ranking
    await generateCategoryRanking('all', entities, cacheDir);

    // Per-category rankings
    for (const category of CATEGORIES) {
        const categoryEntities = entities.filter(e => getV6Category(e) === category);
        await generateCategoryRanking(category, categoryEntities, cacheDir);
    }

    // Per-type rankings
    for (const type of ENTITY_TYPES) {
        const typeEntities = entities.filter(e => e.type === type);
        await generateCategoryRanking(type, typeEntities, cacheDir);
    }
}

async function generateCategoryRanking(category, entities, cacheDir) {
    const pageSize = 50;
    const MAX_PAGES = 50; // Art 2.4 Constitution Limit
    const totalPages = Math.ceil(entities.length / pageSize) || 1;
    const effectivePages = Math.min(totalPages, MAX_PAGES);

    for (let page = 1; page <= effectivePages; page++) {
        const start = (page - 1) * pageSize;
        const pageEntities = entities.slice(start, start + pageSize).map(e => ({
            id: e.id,
            name: e.name || e.slug || 'Unknown',
            type: e.type || 'model',
            author: e.author || '',
            description: (e.description || e.summary || '').substring(0, 120),
            image_url: e.image_url || null,
            fni_score: Math.round(e.fni_score || e.fni || 0),
            tags: Array.isArray(e.tags) ? e.tags.slice(0, 3) : [],
            slug: e.slug || e.id?.split(/[:/]/).pop()
        }));

        const ranking = {
            category,
            page,
            totalPages: effectivePages,
            totalEntities: Math.min(entities.length, MAX_PAGES * pageSize),
            entities: pageEntities,
            generated: new Date().toISOString(),
        };

        const targetKey = `rankings/${category}/p${page}.json`;
        await smartWriteWithVersioning(targetKey, ranking, cacheDir, { compress: true });
    }

    console.log(`  [RANKING] ${category}: ${entities.length} entities, ${effectivePages} pages generated (Capped at ${MAX_PAGES})`);
}
