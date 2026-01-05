/**
 * Relations Generator Module V14.4
 * Constitution Reference: Art 4.4 (Cross-Entity Ranking)
 * 
 * Extracts and generates entity relations for knowledge linking:
 * - Paper ↔ Model (CITES, IMPLEMENTS)
 * - Model ↔ Dataset (TRAINED_ON)
 * - Model ↔ Model (BASED_ON)
 */

import fs from 'fs/promises';
import path from 'path';

// Relation type definitions
const RELATION_TYPES = {
    BASED_ON: { source: 'model', target: 'model' },
    TRAINED_ON: { source: 'model', target: 'dataset' },
    CITES: { source: 'model', target: 'paper' },
    IMPLEMENTS: { source: 'model', target: 'paper' },
    USES: { source: 'space', target: 'model' },
};

/**
 * Extract relations from entity metadata
 * Supports: Model, Paper, Agent, Space, Dataset
 */
function extractEntityRelations(entity) {
    const relations = [];
    const sourceId = entity.id || entity.slug;
    const sourceType = entity.type || 'model';

    // base_model → BASED_ON (Model → Model)
    if (entity.base_model) {
        const targets = Array.isArray(entity.base_model)
            ? entity.base_model
            : [entity.base_model];
        for (const target of targets) {
            if (target && target.length > 2) {
                relations.push({
                    source_id: sourceId,
                    source_type: sourceType,
                    target_id: normalizeId(target, 'model'),
                    target_type: 'model',
                    relation_type: 'BASED_ON',
                    confidence: 1.0,
                });
            }
        }
    }

    // datasets / datasets_used → TRAINED_ON (Model → Dataset)
    const datasets = entity.datasets || entity.datasets_used || [];
    const datasetList = Array.isArray(datasets) ? datasets : [datasets];
    for (const ds of datasetList) {
        if (ds && ds.length > 2) {
            relations.push({
                source_id: sourceId,
                source_type: sourceType,
                target_id: normalizeId(ds, 'dataset'),
                target_type: 'dataset',
                relation_type: 'TRAINED_ON',
                confidence: 1.0,
            });
        }
    }

    // arxiv / paper_refs → CITES (Model/Paper → Paper)
    const papers = entity.arxiv_refs || entity.paper_refs || entity.references || [];
    const paperList = Array.isArray(papers) ? papers : [papers];
    for (const paper of paperList) {
        if (paper && paper.length > 2) {
            relations.push({
                source_id: sourceId,
                source_type: sourceType,
                target_id: normalizeId(paper, 'paper'),
                target_type: 'paper',
                relation_type: 'CITES',
                confidence: 1.0,
            });
        }
    }

    // models_used → USES (Agent/Space → Model)
    const modelsUsed = entity.models_used || entity.models || entity.model_id || [];
    const modelList = Array.isArray(modelsUsed) ? modelsUsed : [modelsUsed];
    for (const model of modelList) {
        if (model && model.length > 2) {
            relations.push({
                source_id: sourceId,
                source_type: sourceType,
                target_id: normalizeId(model, 'model'),
                target_type: 'model',
                relation_type: 'USES',
                confidence: 1.0,
            });
        }
    }

    // space_demo → DEMO_OF (Space → Model)
    if (entity.sdk === 'gradio' || entity.sdk === 'streamlit') {
        // Spaces often demo a model
        const demoModel = entity.model_id || entity.base_model;
        if (demoModel) {
            relations.push({
                source_id: sourceId,
                source_type: 'space',
                target_id: normalizeId(demoModel, 'model'),
                target_type: 'model',
                relation_type: 'DEMO_OF',
                confidence: 0.9,
            });
        }
    }

    // implements → IMPLEMENTS (Paper → Method)
    if (sourceType === 'paper' && entity.implementations) {
        const impls = Array.isArray(entity.implementations)
            ? entity.implementations
            : [entity.implementations];
        for (const impl of impls) {
            if (impl && impl.length > 2) {
                relations.push({
                    source_id: sourceId,
                    source_type: 'paper',
                    target_id: normalizeId(impl, 'model'),
                    target_type: 'model',
                    relation_type: 'IMPLEMENTS',
                    confidence: 1.0,
                });
            }
        }
    }

    return relations;
}

/**
 * Normalize entity ID to standard format
 */
function normalizeId(id, type) {
    if (!id) return id;

    // Already normalized
    if (id.includes('--')) return id;

    // ArXiv paper
    if (type === 'paper' && /^\d{4}\.\d{4,5}(v\d+)?$/.test(id)) {
        return `arxiv--${id}`;
    }

    // HuggingFace format (org/name)
    if (id.includes('/')) {
        return `huggingface--${id.replace(/\//g, '--')}`;
    }

    return id;
}

/**
 * Generate relations.json for frontend knowledge linking
 */
export async function generateRelations(entities, outputDir = './output') {
    console.log('[RELATIONS] Extracting entity relations...');

    const cacheDir = path.join(outputDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });

    const allRelations = [];
    const relationCounts = {
        BASED_ON: 0,
        TRAINED_ON: 0,
        CITES: 0,
        IMPLEMENTS: 0,
        USES: 0,
    };

    // Extract relations from each entity
    for (const entity of entities) {
        const relations = extractEntityRelations(entity);
        for (const rel of relations) {
            allRelations.push(rel);
            relationCounts[rel.relation_type] =
                (relationCounts[rel.relation_type] || 0) + 1;
        }
    }

    // Build reverse lookup (for "Related Models" on paper pages)
    const reverseRelations = {};
    for (const rel of allRelations) {
        if (!reverseRelations[rel.target_id]) {
            reverseRelations[rel.target_id] = [];
        }
        reverseRelations[rel.target_id].push({
            source_id: rel.source_id,
            source_type: rel.source_type,
            relation_type: rel.relation_type,
        });
    }

    // Output
    const output = {
        relations: allRelations,
        reverse_lookup: reverseRelations,
        stats: relationCounts,
        _count: allRelations.length,
        _generated: new Date().toISOString(),
    };

    const content = JSON.stringify(output);
    const filePath = path.join(cacheDir, 'relations.json');
    await fs.writeFile(filePath, content);

    console.log(`  [RELATIONS] ${allRelations.length} relations extracted`);
    for (const [type, count] of Object.entries(relationCounts)) {
        if (count > 0) {
            console.log(`    - ${type}: ${count}`);
        }
    }
}
