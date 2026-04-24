/**
 * Rankings Generator Module V25.9
 * Constitution Reference: Art 3.1 (Aggregator)
 * V25.9: Streaming — per-group bounded accumulators, zero fullSet.
 */

import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';
import { getV6Category } from './category-stats-generator.js';

const CATEGORIES = [
    'text-generation', 'knowledge-retrieval', 'vision-multimedia',
    'automation-workflow', 'infrastructure-ops', 'prompts',
];
const ENTITY_TYPES = ['model', 'paper', 'agent', 'space', 'dataset', 'tool', 'prompt'];
const PAGE_SIZE = 50;
const MAX_PAGES = 50;
const MAX_PER_GROUP = PAGE_SIZE * MAX_PAGES; // 2500

/**
 * Generate all rankings via streaming shard reader
 */
export async function generateRankings(shardReader, outputDir = './output') {
    console.log('[RANKINGS] Generating rankings (streaming)...');
    const cacheDir = path.join(outputDir, 'cache');

    // Per-group bounded accumulators
    const groups = { all: [] };
    for (const cat of CATEGORIES) groups[cat] = [];
    for (const type of ENTITY_TYPES) groups[type] = [];

    await shardReader(async (entities) => {
        for (const e of entities) {
            boundedInsert(groups.all, e, MAX_PER_GROUP);
            const cat = getV6Category(e);
            if (groups[cat]) boundedInsert(groups[cat], e, MAX_PER_GROUP);
            if (e.type && groups[e.type]) boundedInsert(groups[e.type], e, MAX_PER_GROUP);
        }
    }, { slim: true });

    // Sort and paginate each group
    for (const [groupName, entities] of Object.entries(groups)) {
        entities.sort(byFniDesc);
        await generateCategoryRanking(groupName, entities, cacheDir);
    }
}

function boundedInsert(arr, item, maxSize) {
    const score = item.fni_score || 0;
    if (arr.length < maxSize) {
        arr.push(item);
        return;
    }
    if (score <= (arr[arr.length - 1]?._minScore ?? (arr[arr.length - 1]?.fni_score || 0))) return;
    arr[arr.length - 1] = item;
    arr.sort(byFniDesc);
}

function byFniDesc(a, b) { return (b.fni_score || 0) - (a.fni_score || 0); }

async function generateCategoryRanking(category, entities, cacheDir) {
    const totalPages = Math.ceil(entities.length / PAGE_SIZE) || 1;
    const effectivePages = Math.min(totalPages, MAX_PAGES);

    for (let page = 1; page <= effectivePages; page++) {
        const start = (page - 1) * PAGE_SIZE;
        const pageEntities = entities.slice(start, start + PAGE_SIZE).map(e => ({
            id: e.id,
            name: e.name || e.slug || 'Unknown',
            type: e.type || 'model',
            author: e.author || '',
            description: (e.description || e.summary || '').substring(0, 120),
            slug: e.slug || e.id?.split(/[:/]/).pop(),
            fni_score: e.fni_score || e.fni || 0,
            pipeline_tag: e.pipeline_tag || '',
            license: e.license || '',
            vram_estimate_gb: e.vram_estimate_gb || 0,
            params_billions: e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0,
            context_length: e.context_length ?? e.technical?.context_length ?? 0,
            stars: e.stars || 0,
            downloads: e.downloads || 0,
            fni_s: e.fni_s ?? e.fni_metrics?.s ?? 50.0,
            fni_a: e.fni_a ?? e.fni_metrics?.a ?? 0,
            fni_p: e.fni_p ?? e.fni_metrics?.p ?? 0,
            fni_r: e.fni_r ?? e.fni_metrics?.r ?? 0,
            fni_q: e.fni_q ?? e.fni_metrics?.q ?? 0,
            bundle_key: e.bundle_key || '',
            bundle_offset: e.bundle_offset ?? 0,
            bundle_size: e.bundle_size ?? 0
        }));

        const ranking = {
            category, page, totalPages: effectivePages,
            totalEntities: Math.min(entities.length, MAX_PER_GROUP),
            entities: pageEntities, generated: new Date().toISOString(),
        };
        await smartWriteWithVersioning(`rankings/${category}/p${page}.json`, ranking, cacheDir, { compress: true });
    }
    console.log(`  [RANKING] ${category}: ${entities.length} entities, ${effectivePages} pages`);
}
