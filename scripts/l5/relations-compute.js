/**
 * L5 Relations Compute Script
 * 
 * B.3 Knowledge Relations Table
 * Discovers entity relationships from existing data.
 * CES-compliant: extraction utilities in relations-extractors.js
 * 
 * @module l5/relations-compute
 */

import fs from 'fs';
import path from 'path';
import { extractArxivIds, detectBaseModel, extractDatasetIds } from './relations-extractors.js';

/**
 * Build relations for all entities
 */
function discoverRelations(entities) {
    const relations = [];
    const baseModelIndex = new Map(); // Track base models for variant linking

    console.log(`🔍 Discovering relations for ${entities.length} entities...`);

    for (const entity of entities) {
        // 1. Extract ArXiv paper_id relations
        const textToSearch = [
            entity.body_content || '',
            entity.description || '',
            entity.tags || ''
        ].join(' ');

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
            // Track for later reverse lookup
            if (!baseModelIndex.has(baseName.toLowerCase())) {
                baseModelIndex.set(baseName.toLowerCase(), []);
            }
            baseModelIndex.get(baseName.toLowerCase()).push(entity.id);

            // Create potential base_model relation (will be validated later)
            relations.push({
                source_id: entity.id,
                target_id: `base:${baseName}`,
                relation_type: 'base_model',
                confidence: 0.7,
                source_url: null
            });
        }

        // 3. Extract dataset_id relations (B.7 enhancement)
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

    // 3. Create variant relations (inverse of base_model)
    for (const [baseName, variantIds] of baseModelIndex) {
        if (variantIds.length > 1) {
            // Find the actual base entity if it exists
            const baseEntity = entities.find(e =>
                e.name && e.name.toLowerCase() === baseName
            );

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

    // Deduplicate relations
    const uniqueRelations = [...new Map(
        relations.map(r => [`${r.source_id}|${r.target_id}|${r.relation_type}`, r])
    ).values()];

    console.log(`\n✅ Discovered ${uniqueRelations.length} relations in ${elapsed}s`);

    // Count by type
    const typeCounts = {};
    for (const r of uniqueRelations) {
        typeCounts[r.relation_type] = (typeCounts[r.relation_type] || 0) + 1;
    }
    console.log('📊 Relation types:', typeCounts);

    // Ensure output directory exists
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save relations
    fs.writeFileSync(outputFile, JSON.stringify(uniqueRelations, null, 2));
    console.log(`💾 Saved: ${outputFile}`);

    // Save summary
    const summary = {
        total_relations: uniqueRelations.length,
        by_type: typeCounts,
        computed_at: new Date().toISOString(),
        elapsed_seconds: parseFloat(elapsed)
    };

    const summaryFile = outputFile.replace('.json', '_summary.json');
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

    // B.1.0 Phase 2: Build Paper-Model reverse index cache
    const cacheDir = path.join(path.dirname(outputFile), '..', 'cache');
    await buildPaperRelationsCache(uniqueRelations, entities, cacheDir);

    return summary;
}

/**
 * Build Paper-Model reverse index cache
 * B.1.0 Phase 2: Paper → Model relations
 * Creates cache/paper-relations/{arxivId}.json for each paper with citing models
 */
export async function buildPaperRelationsCache(relations, entities, outputDir) {
    console.log('\n📄 Building Paper-Relations cache (B.1.0 Phase 2)...');

    // Create entity lookup for FNI scores and names
    const entityMap = new Map(entities.map(e => [e.id, e]));

    // Group relations by paper (arxiv targets)
    const paperModelMap = new Map();

    for (const rel of relations) {
        if (rel.relation_type === 'paper_id' && rel.target_id.startsWith('arxiv:')) {
            const arxivId = rel.target_id.replace('arxiv:', '');

            if (!paperModelMap.has(arxivId)) {
                paperModelMap.set(arxivId, []);
            }

            const model = entityMap.get(rel.source_id);
            if (model) {
                paperModelMap.get(arxivId).push({
                    id: model.id,
                    name: model.name || model.id,
                    author: model.author || 'Unknown',
                    fni_score: model.fni_score || 0,
                    source: model.source || 'unknown'
                });
            }
        }
    }

    // Create output directory
    const paperRelDir = path.join(outputDir, 'paper-relations');
    if (!fs.existsSync(paperRelDir)) {
        fs.mkdirSync(paperRelDir, { recursive: true });
    }

    // Write individual cache files (Top 50 papers only to avoid explosion)
    const sortedPapers = [...paperModelMap.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 500);  // Top 500 papers with most citations

    let filesWritten = 0;
    for (const [arxivId, models] of sortedPapers) {
        // Sort models by FNI score descending
        const sortedModels = models.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));

        const cacheData = {
            arxiv_id: arxivId,
            citing_models: sortedModels.slice(0, 20),  // Top 20 models per paper
            total_citations: models.length,
            generated_at: new Date().toISOString()
        };

        const cacheFile = path.join(paperRelDir, `${arxivId}.json`);
        fs.writeFileSync(cacheFile, JSON.stringify(cacheData));
        filesWritten++;
    }

    console.log(`   ✅ Created ${filesWritten} paper-relations cache files`);
    console.log(`   📊 Total papers with citations: ${paperModelMap.size}`);

    // Write index file for quick lookup
    const indexData = {
        total_papers: paperModelMap.size,
        cached_papers: filesWritten,
        top_papers: sortedPapers.slice(0, 20).map(([id, models]) => ({
            arxiv_id: id,
            citation_count: models.length
        })),
        generated_at: new Date().toISOString()
    };

    fs.writeFileSync(
        path.join(paperRelDir, '_index.json'),
        JSON.stringify(indexData, null, 2)
    );

    return { filesWritten, totalPapers: paperModelMap.size };
}

// CLI execution
if (process.argv[1].includes('relations-compute')) {
    const inputFile = process.argv[2] || 'data/entities.json';
    const outputFile = process.argv[3] || 'data/relations.json';

    computeRelations(inputFile, outputFile)
        .then(summary => {
            console.log('\n📊 Summary:');
            console.log(`   Total: ${summary.total_relations} relations`);
            console.log(`   Types: ${JSON.stringify(summary.by_type)}`);
        })
        .catch(err => {
            console.error('❌ Error:', err.message);
            process.exit(1);
        });
}

export default { computeRelations, extractArxivIds, detectBaseModel };
