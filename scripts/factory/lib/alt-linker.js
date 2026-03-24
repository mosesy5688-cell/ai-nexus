// ALT Linker V14.5.2 — Jaccard similarity for alternative relations

import fs from 'fs/promises';
import path from 'path';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { computeAltRelationsFromDirFFI, computeAltRelationsFFI } from './rust-bridge.js';

function jaccardSimilarity(tagsA, tagsB) {
    const arrA = Array.isArray(tagsA) ? tagsA : (typeof tagsA === 'string' ? [tagsA] : []);
    const arrB = Array.isArray(tagsB) ? tagsB : (typeof tagsB === 'string' ? [tagsB] : []);
    if (!arrA.length || !arrB.length) return 0;

    const setA = new Set(arrA.filter(t => typeof t === 'string').map(t => t.toLowerCase()));
    const setB = new Set(arrB.filter(t => typeof t === 'string').map(t => t.toLowerCase()));

    let intersection = 0;
    for (const tag of setA) {
        if (setB.has(tag)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Build inverted tag index for fast candidate lookup
 * @param {Array} entities 
 * @returns {Map<string, Set<string>>} tag -> entity IDs
 */
function buildTagIndex(entities) {
    const index = new Map();

    for (const entity of entities) {
        const id = entity.id || entity.slug;
        const tags = entity.tags || [];

        for (const tag of tags) {
            if (typeof tag !== 'string') continue;
            const normalizedTag = tag.toLowerCase();
            if (!index.has(normalizedTag)) {
                index.set(normalizedTag, new Set());
            }
            index.get(normalizedTag).add(id);
        }
    }

    return index;
}

/**
 * Get candidate IDs from tag index
 * @param {string[]} tags 
 * @param {Map} tagIndex 
 * @param {string} excludeId Entity to exclude (self)
 * @returns {Set<string>} Candidate entity IDs
 */
function getCandidates(tags, tagIndex, excludeId) {
    const candidates = new Set();

    for (const tag of (tags || [])) {
        if (typeof tag !== 'string') continue;
        const normalizedTag = tag.toLowerCase();
        const matches = tagIndex.get(normalizedTag);
        if (matches) {
            for (const id of matches) {
                if (id !== excludeId) {
                    candidates.add(id);
                }
            }
        }
    }

    return candidates;
}

/**
 * Group entities by category
 * @param {Array} entities 
 * @returns {Object} category -> entities[]
 */
function groupByCategory(entities) {
    const groups = {};

    for (const entity of entities) {
        const category = entity.primary_category || entity.pipeline_tag || 'other';
        if (!groups[category]) {
            groups[category] = [];
        }
        groups[category].push(entity);
    }

    return groups;
}

/** Compute ALT relations for a category */
function computeCategoryAlts(entities, category, maxEntities = 500, maxAlts = 10, minScore = 0.3) {
    const relations = [];

    // Sort by FNI score and take top N
    const topEntities = [...entities]
        .sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0))
        .slice(0, maxEntities);

    // Build entity lookup map
    const entityMap = new Map();
    for (const e of topEntities) {
        entityMap.set(e.id || e.slug, e);
    }

    // Build tag index
    const tagIndex = buildTagIndex(topEntities);

    // Compute ALT for each entity
    for (const entity of topEntities) {
        const sourceId = normalizeId(entity.id || entity.slug, getNodeSource(entity.id || entity.slug, entity.type), entity.type);
        const candidates = getCandidates(entity.tags, tagIndex, sourceId);

        const alts = [];
        for (const candidateId of candidates) {
            const candidate = entityMap.get(candidateId);
            if (!candidate) continue;

            const score = jaccardSimilarity(entity.tags, candidate.tags);
            if (score >= minScore) {
                alts.push({ id: normalizeId(candidateId, getNodeSource(candidateId, candidate.type), candidate.type), score });
            }
        }

        // Sort by score and take top N
        alts.sort((a, b) => b.score - a.score);
        const topAlts = alts.slice(0, maxAlts);

        if (topAlts.length > 0) {
            relations.push({
                source_id: sourceId,
                category,
                alts: topAlts.map(a => [a.id, Math.round(a.score * 100)])
            });
        }
    }

    return relations;
}

/**
 * Main ALT computation function
 * @param {Array} entities All entities
 * @param {string} outputDir Output directory
 */
export async function computeAltRelations(entities, outputDir = './output', opts = {}) {
    console.log('[ALT-LINKER V14.5.2] Computing alternative relations...');

    const startTime = Date.now();
    const relationsDir = path.join(outputDir, 'cache', 'relations', 'alt-by-category');
    await fs.mkdir(relationsDir, { recursive: true });

    // V26.5: Try Rust direct shard reading first
    let rustResult = null;
    if (opts.shardDir) {
        rustResult = computeAltRelationsFromDirFFI(opts.shardDir, relationsDir);
    }
    if (!rustResult) {
        try { rustResult = computeAltRelationsFFI(Buffer.from(JSON.stringify(entities))); }
        catch (e) { console.warn(`[ALT-LINKER] Rust FFI skipped (${e.message}). Using JS path.`); }
    }
    if (rustResult?.categories_data && rustResult?.meta_data) {
        for (const cat of rustResult.categories_data) {
            await fs.writeFile(path.join(relationsDir, cat.filename), Buffer.from(cat.compressed_data));
        }
        const metaDir = path.join(outputDir, 'cache', 'relations');
        await fs.writeFile(path.join(metaDir, 'alt-meta.json.zst'), Buffer.from(rustResult.meta_data));
        console.log(`  [ALT-LINKER] Rust FFI: ${rustResult.total_relations} relations in ${Date.now() - startTime}ms`);
        return { totalRelations: rustResult.total_relations };
    }

    // Group by category
    const byCategory = groupByCategory(entities);
    const categories = Object.keys(byCategory);
    console.log(`  Found ${categories.length} categories`);

    const stats = {
        categories: categories.length,
        totalRelations: 0,
        byCategoryCount: {},
    };

    // Process each category
    for (const category of categories) {
        const categoryEntities = byCategory[category];
        console.log(`  Processing ${category}: ${categoryEntities.length} entities`);

        const relations = computeCategoryAlts(categoryEntities, category);
        stats.byCategoryCount[category] = relations.length;
        stats.totalRelations += relations.length;

        // Output V14.5.2 format
        const output = {
            _v: '14.5.2',
            _ts: new Date().toISOString(),
            _cat: category,
            _count: relations.length,
            relations,
        };

        const { zstdCompress } = await import('./zstd-helper.js');
        // Sanitize category name for filename
        const safeCategory = category.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        await fs.writeFile(
            path.join(relationsDir, `${safeCategory}.json.zst`),
            await zstdCompress(JSON.stringify(output))
        );
    }

    const { zstdCompress: zstdCompressMeta } = await import('./zstd-helper.js');
    // Write meta file
    const meta = {
        _v: '14.5.2',
        _ts: new Date().toISOString(),
        _duration_ms: Date.now() - startTime,
        ...stats,
    };
    await fs.writeFile(
        path.join(outputDir, 'cache', 'relations', 'alt-meta.json.zst'),
        await zstdCompressMeta(JSON.stringify(meta, null, 2))
    );

    console.log(`  [ALT-LINKER] Completed in ${Date.now() - startTime}ms`);
    console.log(`  Total ALT relations: ${stats.totalRelations}`);

    return stats;
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const entitiesPath = process.argv[2] || './output/entities.json';
    const outputDir = process.argv[3] || './output';

    try {
        const data = await fs.readFile(entitiesPath);
        const entities = JSON.parse(data);
        await computeAltRelations(Array.isArray(entities) ? entities : entities.entities || [], outputDir);
    } catch (error) {
        console.error('[ALT-LINKER] Error:', error.message);
        process.exit(1);
    }
}
