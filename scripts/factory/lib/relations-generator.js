/**
 * Relations Generator Module V14.5.2
 * Constitution Reference: Art 4.4 (Cross-Entity Ranking)
 * SPEC: SPEC-KNOWLEDGE-V14.5.2
 * 
 * Extracts and generates entity relations for knowledge linking:
 * - Model ↔ Model (BASED_ON, ALT)
 * - Model ↔ Paper (CITES, IMPLEMENTS)
 * - Model ↔ Dataset (TRAINED_ON)
 * - Model ↔ Tool (STACK)
 * - Agent/Space → Model (USES)
 * - Entity → Knowledge (EXPLAIN)
 */

import fs from 'fs/promises';
import path from 'path';

// Relation type definitions - V14.5.2
const RELATION_TYPES = {
    // P0 - Must implement
    BASED_ON: { source: 'model', target: 'model' },
    STACK: { source: 'model', target: 'tool' },
    // P1 - Should implement
    TRAINED_ON: { source: 'model', target: 'dataset' },
    CITES: { source: 'model', target: 'paper' },
    IMPLEMENTS: { source: 'paper', target: 'model' },
    USES: { source: ['space', 'agent'], target: 'model' },
    DEP: { source: ['agent', 'tool'], target: 'tool' },
    DEMO_OF: { source: 'space', target: 'model' },
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

    // V14.5.2: STACK relation (Model → Tool)
    // Detect deployment tools from tags or description
    const KNOWN_TOOLS = {
        'vllm': 'tool--vllm--vllm',
        'ollama': 'tool--ollama--ollama',
        'llama.cpp': 'tool--ggerganov--llama.cpp',
        'tgi': 'tool--huggingface--text-generation-inference',
        'transformers': 'tool--huggingface--transformers',
        'langchain': 'tool--langchain-ai--langchain',
        'llamaindex': 'tool--run-llama--llama_index',
        'gguf': 'tool--ggerganov--llama.cpp',
        'exl2': 'tool--turboderp--exllamav2',
        'awq': 'tool--casper-hansen--autoawq',
        'gptq': 'tool--autogptq--autogptq',
    };

    if (sourceType === 'model') {
        const searchText = [
            ...(entity.tags || []),
            entity.description || '',
            entity.name || '',
        ].join(' ').toLowerCase();

        for (const [keyword, toolId] of Object.entries(KNOWN_TOOLS)) {
            if (searchText.includes(keyword)) {
                relations.push({
                    source_id: sourceId,
                    source_type: 'model',
                    target_id: toolId,
                    target_type: 'tool',
                    relation_type: 'STACK',
                    confidence: 0.8,
                });
            }
        }
    }

    // V14.5.2: DEP relation (Agent/Tool → Tool dependency)
    if ((sourceType === 'agent' || sourceType === 'tool') && entity.dependencies) {
        const deps = Array.isArray(entity.dependencies)
            ? entity.dependencies
            : [entity.dependencies];
        for (const dep of deps) {
            if (dep && dep.length > 2) {
                relations.push({
                    source_id: sourceId,
                    source_type: sourceType,
                    target_id: normalizeId(dep, 'tool'),
                    target_type: 'tool',
                    relation_type: 'DEP',
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
 * V14.5.2: Outputs both explicit.json and adjacency list format
 */
export async function generateRelations(entities, outputDir = './output') {
    console.log('[RELATIONS V14.5.2] Extracting entity relations...');

    const cacheDir = path.join(outputDir, 'cache');
    const relationsDir = path.join(cacheDir, 'relations');
    await fs.mkdir(relationsDir, { recursive: true });

    const allRelations = [];
    const relationCounts = {
        BASED_ON: 0,
        TRAINED_ON: 0,
        CITES: 0,
        IMPLEMENTS: 0,
        USES: 0,
        DEMO_OF: 0,
        STACK: 0,
        DEP: 0,
    };

    // Build node map for adjacency list
    const nodes = {};

    // Extract relations from each entity
    for (const entity of entities) {
        const id = entity.id || entity.slug;
        const type = entity.type || 'model';

        // Add to nodes map
        nodes[id] = {
            t: type,
            f: Math.round((entity.fni_score || 0) * 10) / 10
        };

        const relations = extractEntityRelations(entity);
        for (const rel of relations) {
            allRelations.push(rel);
            relationCounts[rel.relation_type] =
                (relationCounts[rel.relation_type] || 0) + 1;
        }
    }

    // Build adjacency list (V14.5.2 format)
    const edges = {};
    for (const rel of allRelations) {
        if (!edges[rel.source_id]) {
            edges[rel.source_id] = [];
        }
        // Compressed format: [targetId, relationType, weight(0-100)]
        edges[rel.source_id].push([
            rel.target_id,
            rel.relation_type,
            Math.round((rel.confidence || 1) * 100)
        ]);
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

    // V14.5.2 Output: Adjacency list format
    const v2Output = {
        _v: '14.5.2',
        _ts: new Date().toISOString(),
        _count: allRelations.length,
        _stats: relationCounts,
        nodes,
        edges,
    };

    // Legacy output for backward compatibility
    const legacyOutput = {
        relations: allRelations,
        reverse_lookup: reverseRelations,
        stats: relationCounts,
        _count: allRelations.length,
        _generated: new Date().toISOString(),
    };

    // Write both formats
    await fs.writeFile(
        path.join(relationsDir, 'explicit.json'),
        JSON.stringify(v2Output)
    );
    await fs.writeFile(
        path.join(cacheDir, 'relations.json'),
        JSON.stringify(legacyOutput)
    );

    console.log(`  [RELATIONS] ${allRelations.length} relations extracted`);
    for (const [type, count] of Object.entries(relationCounts)) {
        if (count > 0) {
            console.log(`    - ${type}: ${count}`);
        }
    }

    return { relationCounts, totalRelations: allRelations.length };
}
