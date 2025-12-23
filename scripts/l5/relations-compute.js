/**
 * L5 Relations Compute Script
 * 
 * B.3 Knowledge Relations Table
 * Discovers entity relationships from existing data.
 * CES-compliant: extraction utilities in relations-extractors.js
 * Paper cache in paper-relations-cache.js
 * 
 * @module l5/relations-compute
 */

import fs from 'fs';
import path from 'path';
import { extractArxivIds, detectBaseModel, extractDatasetIds } from './relations-extractors.js';
import { buildPaperRelationsCache } from './paper-relations-cache.js';

/**
 * Build relations for all entities
 */
function discoverRelations(entities) {
    const relations = [];
    const baseModelIndex = new Map();

    console.log(`🔍 Discovering relations for ${entities.length} entities...`);

    for (const entity of entities) {
        const textToSearch = [
            entity.body_content || '',
            entity.description || '',
            entity.tags || ''
        ].join(' ');

        // 1. Extract ArXiv paper_id relations
        const arxivIds = extractArxivIds(textToSearch);
        for (const arxivId of arxivIds) {
            relations.push({
                source_id: entity.id,
                target_id: `arxiv:${arxivId}`,
                relation_type: 'paper_id',
                confidence: 0.9,
                source_url: entity.source_url || null
            });
        }

        // 2. Detect base_model relations
        const baseName = detectBaseModel(entity.name);
        if (baseName) {
            if (!baseModelIndex.has(baseName.toLowerCase())) {
                baseModelIndex.set(baseName.toLowerCase(), []);
            }
            baseModelIndex.get(baseName.toLowerCase()).push(entity.id);
            relations.push({
                source_id: entity.id,
                target_id: `base:${baseName}`,
                relation_type: 'base_model',
                confidence: 0.7,
                source_url: null
            });
        }

        // 3. Extract dataset_id relations
        const datasetIds = extractDatasetIds(textToSearch, entity.tags);
        for (const datasetId of datasetIds) {
            relations.push({
                source_id: entity.id,
                target_id: `dataset:${datasetId}`,
                relation_type: 'dataset_id',
                confidence: 0.6,
                source_url: entity.source_url || null
            });
        }
    }

    // Create variant relations (inverse of base_model)
    for (const [baseName, variantIds] of baseModelIndex) {
        if (variantIds.length > 1) {
            const baseEntity = entities.find(e => e.name?.toLowerCase() === baseName);
            if (baseEntity) {
                for (const variantId of variantIds) {
                    relations.push({
                        source_id: baseEntity.id,
                        target_id: variantId,
                        relation_type: 'variant',
                        confidence: 0.8,
                        source_url: null
                    });
                }
            }
        }
    }
    return relations;
}

/**
 * Main execution function
 */
export async function computeRelations(inputFile, outputFile) {
    console.log(`📊 Loading entities from ${inputFile}...`);
    const entities = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    console.log(`📦 Loaded ${entities.length} entities`);

    const startTime = Date.now();
    const relations = discoverRelations(entities);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Deduplicate
    const uniqueRelations = [...new Map(
        relations.map(r => [`${r.source_id}|${r.target_id}|${r.relation_type}`, r])
    ).values()];

    console.log(`\n✅ Discovered ${uniqueRelations.length} relations in ${elapsed}s`);

    const typeCounts = {};
    for (const r of uniqueRelations) {
        typeCounts[r.relation_type] = (typeCounts[r.relation_type] || 0) + 1;
    }
    console.log('📊 Relation types:', typeCounts);

    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(outputFile, JSON.stringify(uniqueRelations, null, 2));
    console.log(`💾 Saved: ${outputFile}`);

    const summary = {
        total_relations: uniqueRelations.length,
        by_type: typeCounts,
        computed_at: new Date().toISOString(),
        elapsed_seconds: parseFloat(elapsed)
    };
    fs.writeFileSync(outputFile.replace('.json', '_summary.json'), JSON.stringify(summary, null, 2));

    // B.1.0 Phase 2: Build Paper-Model reverse index cache
    const cacheDir = path.join(path.dirname(outputFile), '..', 'cache');
    await buildPaperRelationsCache(uniqueRelations, entities, cacheDir);

    return summary;
}

// CLI execution
if (process.argv[1].includes('relations-compute')) {
    const inputFile = process.argv[2] || 'data/entities.json';
    const outputFile = process.argv[3] || 'data/relations.json';
    computeRelations(inputFile, outputFile)
        .then(s => console.log(`\n📊 Total: ${s.total_relations} relations`))
        .catch(err => { console.error('❌', err.message); process.exit(1); });
}

export default { computeRelations };

